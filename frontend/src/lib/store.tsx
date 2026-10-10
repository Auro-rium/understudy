"use client";

/**
 * Single app-wide store. Data comes from the live backend when reachable; otherwise
 * the best saved snapshot (localStorage cache of the last good live data, or the
 * bundled /export/snapshot.json, whichever is newer). In NEXT_PUBLIC_DATA_SOURCE=snapshot
 * mode the API is never called. Nothing here invents data: when the backend is not
 * reachable the actions reject and the UI shows a snapshot badge instead.
 * Pages only ever call useStore().
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import { API_CONFIGURED, ApiError, api } from "@/lib/api";
import { subscribe, type EventStatus } from "@/lib/events";
import { cleanAddressBar } from "@/lib/runtime";
import { loadBestSnapshot, loadBundledSnapshot, saveSnapshot } from "@/lib/snapshot";
import type {
  EvalCompare,
  Health,
  LossPoint,
  Mode,
  ModelSwitched,
  ModelVersionInfo,
  ReviewItem,
  Round,
  RoundComplete,
  ServerEvent,
  Snapshot,
  SnapshotSource,
  Summary,
  Ticket,
  TimePoint,
  TrainBackend,
  TrainProgress,
  TrainStage,
} from "@/lib/types";

/* ---------- public types ---------- */

/** "snapshot" covers both the localStorage cache and the bundled file. */
export type Connection = "live" | "polling" | "snapshot" | "down";
export type ActiveStage = "idle" | "routing" | TrainStage;

export interface LastRound {
  round: Round;
  previousVersion: string;
  localShareBefore: number;
  localShareAfter: number;
  delta: number;
  at: number;
}

export interface RoundMarker {
  at: string;
  version: string;
  promoted: boolean;
}

export interface StoreState {
  loaded: boolean;
  connection: Connection;
  /** what is currently displayed: "live" API data, the localStorage "cache", or the "bundled" export */
  dataSource: SnapshotSource;
  /** generated_at of the snapshot on screen; null when dataSource is "live" */
  snapshotAt: string | null;
  /** true only while the backend is reachable (connection live or polling); stream/train/offline need it */
  canControl: boolean;
  /** false when NEXT_PUBLIC_DATA_SOURCE=snapshot (the app never calls the API) */
  apiConfigured: boolean;
  health: Health | null;
  summary: Summary | null;
  timeseries: TimePoint[];
  /** newest first, capped at 100 */
  tickets: Ticket[];
  reviewQueue: ReviewItem[];
  rounds: Round[];
  evalCompare: EvalCompare | null;
  mode: Mode;
  modelVersion: string;
  streaming: boolean;
  trainProgress: TrainProgress | null;
  /** message of the last failed training round (cleared by the next progress event) */
  trainError: string | null;
  /** Loss points of the running job, kept here so they survive page navigation. */
  lossTrace: { jobId: string | null; points: LossPoint[] };
  activeStage: ActiveStage;
  lastRound: LastRound | null;
  /** rounds completed while watching, anchored on the timeseries; [] when the timeseries is empty */
  roundMarkers: RoundMarker[];
  lastPredictionAt: number | null;
  /** GET /api/model/versions; [] until loaded or when the backend has no such endpoint */
  modelVersions: ModelVersionInfo[];
  /** version being activated right now (POST /api/model/activate in flight), else null */
  switchingModel: string | null;
}

export interface StoreActions {
  /** switch the serving model; rejects with the backend's {detail} (401 -> demo key message, 409 -> round running) */
  activateModel(version: string): Promise<void>;
  /** all four reject with Error("Backend not reachable — this is a saved snapshot") when !canControl */
  startStream(ratePerMin?: number): Promise<void>;
  stopStream(): Promise<void>;
  runTrainingRound(backend?: TrainBackend): Promise<void>;
  setOffline(offline: boolean): Promise<void>;
  /** reload from the API (no-op in snapshot data-source mode) */
  refresh(): Promise<void>;
}

/* ---------- internals ---------- */

export const NOT_REACHABLE = "Backend not reachable — this is a saved snapshot";

const TICKET_CAP = 100;
const TRACE_CAP = 2000;
const REFRESH_MS = 4000;
const RETRY_MS = 5000;
const FAILS_BEFORE_SNAPSHOT = 2;
const EXTRAS_EVERY = 5; // refreshes between evalCompare/rounds reloads
const FLUSH_MS = 150;
const ROUTING_MS = 1500;
const SAVE_THROTTLE_MS = 10000;
const MEASURE_MS = 120000;
const TRAIN_STALE_MS = 30000;
const DEFAULT_RATE = 40;
const TRAIN_STAGES: readonly string[] = ["collect", "train", "evaluate", "promote"];

interface LoadedData {
  health: Health;
  summary: Summary;
  timeseries: TimePoint[];
  tickets: Ticket[];
  reviewQueue: ReviewItem[];
  rounds: Round[];
  evalCompare: EvalCompare;
}

type Action =
  | { type: "init"; data: LoadedData; connection: Connection; dataSource: SnapshotSource; snapshotAt: string | null }
  | { type: "failed" }
  | { type: "connection"; connection: Connection }
  | { type: "eventStatus"; status: EventStatus }
  | { type: "predictions"; tickets: Ticket[]; at: number }
  | { type: "routingTick"; at: number }
  | { type: "train_progress"; data: TrainProgress }
  | { type: "trainStale" }
  | { type: "round_complete"; data: RoundComplete; at: number; before: number; after: number }
  | { type: "lastRoundAfter"; after: number }
  | { type: "mode"; mode: Mode }
  | { type: "model"; data: ModelSwitched }
  | { type: "modelVersions"; versions: ModelVersionInfo[] }
  | { type: "switching"; version: string | null }
  | { type: "refresh"; summary: Summary; timeseries: TimePoint[]; reviewQueue: ReviewItem[]; health: Health }
  | { type: "extras"; rounds: Round[]; evalCompare: EvalCompare }
  | { type: "streaming"; on: boolean };

function initialState(): StoreState {
  return {
    loaded: false,
    connection: API_CONFIGURED ? "live" : "snapshot",
    dataSource: API_CONFIGURED ? "live" : "bundled",
    snapshotAt: null,
    canControl: false,
    apiConfigured: API_CONFIGURED,
    health: null,
    summary: null,
    timeseries: [],
    tickets: [],
    reviewQueue: [],
    rounds: [],
    evalCompare: null,
    mode: "online",
    modelVersion: "",
    streaming: false,
    trainProgress: null,
    trainError: null,
    lossTrace: { jobId: null, points: [] },
    activeStage: "idle",
    lastRound: null,
    roundMarkers: [],
    lastPredictionAt: null,
    modelVersions: [],
    switchingModel: null,
  };
}

function connectionFromStatus(s: EventStatus | null): Connection {
  return s === "polling" ? "polling" : "live";
}

function step(state: StoreState, a: Action): StoreState {
  switch (a.type) {
    case "init": {
      const live = a.dataSource === "live";
      return {
        ...state,
        loaded: true,
        connection: a.connection,
        dataSource: a.dataSource,
        snapshotAt: live ? null : a.snapshotAt,
        health: a.data.health,
        summary: a.data.summary,
        timeseries: a.data.timeseries,
        tickets: a.data.tickets.slice(0, TICKET_CAP),
        reviewQueue: a.data.reviewQueue,
        rounds: a.data.rounds,
        evalCompare: a.data.evalCompare,
        mode: a.data.health.mode,
        // the export's health block can predate the last promotion; for a saved snapshot trust the rounds
        modelVersion: live
          ? a.data.health.model_version
          : ([...a.data.rounds].reverse().find((r) => r.promoted)?.model_version ?? a.data.health.model_version),
        // markers are anchored on timeseries points: none without a timeseries, and only for rounds that still exist
        roundMarkers:
          live && a.data.timeseries.length > 0
            ? state.roundMarkers.filter((m) => a.data.rounds.some((r) => r.model_version === m.version))
            : [],
        // a snapshot has no running job and no stream
        ...(live ? {} : { trainProgress: null, activeStage: "idle" as ActiveStage, streaming: false }),
      };
    }
    case "failed":
      return { ...state, loaded: true, connection: "down" };
    case "connection":
      return state.connection === a.connection ? state : { ...state, connection: a.connection };
    case "eventStatus": {
      if (state.dataSource !== "live" || a.status === "down") return state;
      const next = connectionFromStatus(a.status);
      return state.connection === next ? state : { ...state, connection: next };
    }
    case "predictions": {
      if (a.tickets.length === 0) return state;
      const known = new Set(state.tickets.map((t) => t.id));
      const fresh = a.tickets.filter((t) => !known.has(t.id)).reverse(); // newest first
      if (fresh.length === 0) return state;
      const queued = new Set(state.reviewQueue.map((r) => r.id));
      const toReview: ReviewItem[] = fresh
        .filter((t) => t.source === "review" && !queued.has(t.id))
        .map((t) => ({ id: t.id, text: t.text, created_at: t.created_at }));
      const cost = fresh.reduce((sum, t) => sum + t.cost_usd, 0);
      // only exact counters are bumped here; shares and cost_avoided come from the next summary refresh
      const summary = state.summary
        ? { ...state.summary, total: state.summary.total + fresh.length, cost_usd_total: state.summary.cost_usd_total + cost }
        : state.summary;
      return {
        ...state,
        tickets: [...fresh, ...state.tickets].slice(0, TICKET_CAP),
        reviewQueue: toReview.length ? [...toReview, ...state.reviewQueue] : state.reviewQueue,
        summary,
        lastPredictionAt: a.at,
        activeStage: state.trainProgress === null ? "routing" : state.activeStage,
      };
    }
    case "routingTick":
      if (state.activeStage === "routing" && state.lastPredictionAt !== null && a.at - state.lastPredictionAt >= ROUTING_MS - 100) {
        return { ...state, activeStage: "idle" };
      }
      return state;
    case "train_progress": {
      const d = a.data;
      if (d.error !== undefined) {
        return { ...state, trainProgress: null, trainError: d.error, activeStage: "idle" };
      }
      let trace = state.lossTrace;
      if (trace.jobId !== d.job_id) trace = { jobId: d.job_id, points: [] };
      if (d.step !== undefined && d.loss !== undefined) {
        const last = trace.points[trace.points.length - 1];
        if (!last || d.step > last.step) {
          trace = { jobId: trace.jobId, points: [...trace.points, { step: d.step, loss: d.loss }].slice(-TRACE_CAP) };
        }
      }
      return { ...state, trainProgress: d, trainError: null, lossTrace: trace, activeStage: d.stage };
    }
    case "trainStale":
      if (state.trainProgress === null) return state;
      return {
        ...state,
        trainProgress: null,
        activeStage: TRAIN_STAGES.includes(state.activeStage) ? "idle" : state.activeStage,
      };
    case "round_complete": {
      const r = a.data.round;
      const previous = a.data.previous_model_version || state.modelVersion;
      const rounds = [...state.rounds.filter((x) => x.round !== r.round), r].sort((x, y) => x.round - y.round);
      const version = r.promoted ? r.model_version : previous;
      const lastPoint = state.timeseries[state.timeseries.length - 1];
      const marker: RoundMarker | null = lastPoint
        ? { at: lastPoint.t, version: r.model_version, promoted: r.promoted }
        : null;
      return {
        ...state,
        rounds,
        modelVersion: version,
        health: state.health ? { ...state.health, model_version: version } : state.health,
        summary: state.summary ? { ...state.summary, model_version: version } : state.summary,
        trainProgress: null,
        trainError: null,
        activeStage: "idle",
        lastRound: {
          round: r,
          previousVersion: previous,
          localShareBefore: a.before,
          localShareAfter: a.after,
          delta: a.after - a.before,
          at: a.at,
        },
        roundMarkers: marker ? [...state.roundMarkers.filter((m) => m.version !== marker.version), marker] : [],
      };
    }
    case "lastRoundAfter":
      if (!state.lastRound) return state;
      return {
        ...state,
        lastRound: {
          ...state.lastRound,
          localShareAfter: a.after,
          delta: a.after - state.lastRound.localShareBefore,
        },
      };
    case "mode":
      return {
        ...state,
        mode: a.mode,
        health: state.health ? { ...state.health, mode: a.mode } : state.health,
        summary: state.summary ? { ...state.summary, mode: a.mode } : state.summary,
      };
    case "model": {
      const version = a.data.model_version;
      return {
        ...state,
        modelVersion: version,
        health: state.health ? { ...state.health, model_version: version } : state.health,
        summary: state.summary ? { ...state.summary, model_version: version } : state.summary,
      };
    }
    case "modelVersions":
      return { ...state, modelVersions: a.versions };
    case "switching":
      return { ...state, switchingModel: a.version };
    case "refresh":
      return {
        ...state,
        summary: a.summary,
        timeseries: a.timeseries,
        reviewQueue: a.reviewQueue,
        health: a.health,
        mode: a.health.mode,
        modelVersion: a.health.model_version,
        roundMarkers: a.timeseries.length > 0 ? state.roundMarkers : [],
      };
    case "extras":
      return { ...state, rounds: a.rounds, evalCompare: a.evalCompare };
    case "streaming":
      return { ...state, streaming: a.on };
  }
}

function reducer(state: StoreState, a: Action): StoreState {
  const next = step(state, a);
  const canControl =
    API_CONFIGURED && next.loaded && next.dataSource === "live" && (next.connection === "live" || next.connection === "polling");
  return next.canControl === canControl ? next : { ...next, canControl };
}

function fromSnapshot(s: Snapshot): LoadedData {
  return {
    health: s.health,
    summary: s.summary,
    timeseries: s.timeseries,
    tickets: s.tickets,
    reviewQueue: s.review_queue,
    rounds: s.rounds,
    evalCompare: s.eval_compare,
  };
}

async function fetchAll(): Promise<LoadedData> {
  try {
    return fromSnapshot(await api.snapshot());
  } catch (err) {
    // network failure: no point retrying seven more requests. HTTP error (e.g. 404): fall back.
    if (!(err instanceof ApiError) || err.status === null) throw err;
  }
  const [health, summary, timeseries, tickets, reviewQueue, rounds, evalCompare] = await Promise.all([
    api.health(),
    api.summary(),
    api.timeseries(),
    api.recentTickets(50),
    api.reviewQueue(),
    api.rounds(),
    api.evalCompare(),
  ]);
  return { health, summary, timeseries, tickets, reviewQueue, rounds, evalCompare };
}

/* ---------- context ---------- */

interface StoreValue {
  state: StoreState;
  actions: StoreActions;
}

const StoreContext = createContext<StoreValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);

  const stateRef = useRef<StoreState>(state);
  const eventStatusRef = useRef<EventStatus | null>(null);
  const bufferRef = useRef<Ticket[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const routingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSaveRef = useRef(0);
  const measureUntilRef = useRef(0);
  const lastProgressAtRef = useRef(0);
  const inflightRef = useRef(false);
  const refreshCountRef = useRef(0);
  const failCountRef = useRef(0);

  useEffect(() => {
    stateRef.current = state;
  });

  /** Show the best saved snapshot (newer of cache / bundled). Falls to "down" only when there is none. */
  const showSnapshot = useCallback(async (): Promise<void> => {
    const best = await loadBestSnapshot();
    if (best) {
      dispatch({
        type: "init",
        data: fromSnapshot(best.snapshot),
        connection: "snapshot",
        dataSource: best.from,
        snapshotAt: best.snapshot.generated_at,
      });
    } else if (stateRef.current.loaded) {
      dispatch({ type: "connection", connection: "down" });
    } else {
      dispatch({ type: "failed" });
    }
  }, []);

  /** Best effort: an older backend without /api/model/versions just leaves the list empty. */
  const loadVersions = useCallback(async (): Promise<void> => {
    try {
      const v = await api.modelVersions();
      dispatch({ type: "modelVersions", versions: v.versions });
    } catch {
      /* keep the previous list */
    }
  }, []);

  /** Full (re)load: live API first; if unreachable, a saved snapshot (unless one is already showing). */
  const loadAll = useCallback(async (): Promise<void> => {
    if (!API_CONFIGURED) {
      const bundled = await loadBundledSnapshot();
      if (bundled) {
        dispatch({
          type: "init",
          data: fromSnapshot(bundled),
          connection: "snapshot",
          dataSource: "bundled",
          snapshotAt: bundled.generated_at,
        });
      } else {
        dispatch({ type: "failed" });
      }
      return;
    }
    try {
      const data = await fetchAll();
      failCountRef.current = 0;
      dispatch({
        type: "init",
        data,
        connection: connectionFromStatus(eventStatusRef.current),
        dataSource: "live",
        snapshotAt: null,
      });
      void loadVersions();
    } catch {
      const s = stateRef.current;
      if (s.loaded && (s.dataSource !== "live" || s.connection === "down")) return; // already showing something
      await showSnapshot();
    }
  }, [showSnapshot, loadVersions]);

  const loadExtras = useCallback(async (): Promise<void> => {
    const [rounds, evalCompare] = await Promise.all([api.rounds(), api.evalCompare()]);
    dispatch({ type: "extras", rounds, evalCompare });
    void loadVersions();
  }, [loadVersions]);

  const refreshLight = useCallback(async (): Promise<void> => {
    const [summary, timeseries, reviewQueue, health] = await Promise.all([
      api.summary(),
      api.timeseries(),
      api.reviewQueue(),
      api.health(),
    ]);
    dispatch({ type: "refresh", summary, timeseries, reviewQueue, health });
    if (Date.now() < measureUntilRef.current) {
      dispatch({ type: "lastRoundAfter", after: summary.local_share });
    }
  }, []);

  const flushPredictions = useCallback((): void => {
    flushTimerRef.current = null;
    const tickets = bufferRef.current;
    if (tickets.length === 0) return;
    bufferRef.current = [];
    dispatch({ type: "predictions", tickets, at: Date.now() });
    if (routingTimerRef.current) clearTimeout(routingTimerRef.current);
    routingTimerRef.current = setTimeout(() => {
      routingTimerRef.current = null;
      dispatch({ type: "routingTick", at: Date.now() });
    }, ROUTING_MS);
  }, []);

  const handleRoundComplete = useCallback(
    (data: RoundComplete): void => {
      const before = stateRef.current.summary?.local_share ?? 0;
      dispatch({ type: "round_complete", data, at: Date.now(), before, after: before });
      // the "after" share is measured from the live summary for the next couple of minutes
      if (data.round.promoted) measureUntilRef.current = Date.now() + MEASURE_MS;
      void Promise.all([refreshLight(), loadExtras()]).catch(() => undefined);
    },
    [refreshLight, loadExtras],
  );

  const onEvent = useCallback(
    (e: ServerEvent): void => {
      switch (e.type) {
        case "prediction":
          bufferRef.current.push(e.data);
          if (flushTimerRef.current === null) flushTimerRef.current = setTimeout(flushPredictions, FLUSH_MS);
          break;
        case "train_progress":
          lastProgressAtRef.current = Date.now();
          dispatch({ type: "train_progress", data: e.data });
          break;
        case "round_complete":
          handleRoundComplete(e.data);
          break;
        case "mode":
          dispatch({ type: "mode", mode: e.data.mode });
          break;
        case "model":
          dispatch({ type: "model", data: e.data });
          void loadVersions();
          break;
      }
    },
    [flushPredictions, handleRoundComplete, loadVersions],
  );

  // mount: persist ?api / ?key and take them out of the address bar (the first API call resolved them already)
  useEffect(() => {
    cleanAddressBar();
  }, []);

  // mount: initial load, periodic refresh while live, periodic retry while on a snapshot
  useEffect(() => {
    let alive = true;
    void loadAll();
    if (!API_CONFIGURED) return;

    const refreshTimer = setInterval(() => {
      const s = stateRef.current;
      if (!s.loaded || inflightRef.current || s.dataSource !== "live" || s.connection === "down") return;
      inflightRef.current = true;
      void (async () => {
        try {
          await refreshLight();
          failCountRef.current = 0;
          refreshCountRef.current += 1;
          if (refreshCountRef.current % EXTRAS_EVERY === 0) await loadExtras();
        } catch {
          failCountRef.current += 1;
          if (alive && failCountRef.current >= FAILS_BEFORE_SNAPSHOT) await showSnapshot();
        } finally {
          inflightRef.current = false;
        }
      })();
    }, REFRESH_MS);

    const retryTimer = setInterval(() => {
      const s = stateRef.current;
      if (!s.loaded || inflightRef.current) return;
      if (s.dataSource === "live" && s.connection !== "down") return;
      inflightRef.current = true;
      void loadAll().finally(() => {
        inflightRef.current = false;
      });
    }, RETRY_MS);

    const staleTimer = setInterval(() => {
      const s = stateRef.current;
      if (s.trainProgress && Date.now() - lastProgressAtRef.current > TRAIN_STALE_MS) {
        dispatch({ type: "trainStale" });
      }
    }, 3000);

    return () => {
      alive = false;
      clearInterval(refreshTimer);
      clearInterval(retryTimer);
      clearInterval(staleTimer);
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
      if (routingTimerRef.current) clearTimeout(routingTimerRef.current);
      flushTimerRef.current = null;
      routingTimerRef.current = null;
    };
  }, [loadAll, loadExtras, refreshLight, showSnapshot]);

  // event stream: only while the backend is reachable (SSE, falling back to 2s polling inside subscribe)
  const reachable = state.canControl;
  useEffect(() => {
    if (!API_CONFIGURED || !reachable) return;
    const unsubscribe = subscribe(onEvent, (status) => {
      eventStatusRef.current = status;
      dispatch({ type: "eventStatus", status });
    });
    return () => {
      unsubscribe();
      eventStatusRef.current = null;
    };
  }, [reachable, onEvent]);

  // cache the latest good live state for offline starts (throttled)
  useEffect(() => {
    const { loaded, dataSource, connection, health, summary, evalCompare } = state;
    if (!loaded || dataSource !== "live" || (connection !== "live" && connection !== "polling")) return;
    if (!health || !summary || !evalCompare) return;
    const now = Date.now();
    if (now - lastSaveRef.current < SAVE_THROTTLE_MS) return;
    lastSaveRef.current = now;
    saveSnapshot({
      generated_at: new Date(now).toISOString(),
      health,
      summary,
      timeseries: state.timeseries,
      tickets: state.tickets.slice(0, 50),
      review_queue: state.reviewQueue,
      rounds: state.rounds,
      eval_compare: evalCompare,
    });
  }, [state]);

  const actions = useMemo<StoreActions>(() => {
    const requireBackend = (): void => {
      if (!stateRef.current.canControl) throw new Error(NOT_REACHABLE);
    };
    return {
      activateModel: async (version: string) => {
        requireBackend();
        if (stateRef.current.trainProgress !== null) {
          throw new Error("A training round is running - switch models when it finishes.");
        }
        if (stateRef.current.switchingModel !== null) return;
        dispatch({ type: "switching", version });
        try {
          const res = await api.activateModel(version);
          dispatch({
            type: "model",
            data: { model_version: res.model_version, previous_model_version: res.previous_model_version },
          });
          void loadVersions();
        } finally {
          dispatch({ type: "switching", version: null });
        }
      },
      startStream: async (ratePerMin?: number) => {
        requireBackend();
        await api.streamStart(ratePerMin ?? DEFAULT_RATE);
        dispatch({ type: "streaming", on: true });
      },
      stopStream: async () => {
        requireBackend();
        await api.streamStop();
        dispatch({ type: "streaming", on: false });
      },
      runTrainingRound: async (backend: TrainBackend = "mlx_local") => {
        requireBackend();
        const { job_id } = await api.trainRound(backend);
        const current = stateRef.current.trainProgress;
        if (current === null || current.job_id !== job_id) {
          lastProgressAtRef.current = Date.now();
          const maxRound = stateRef.current.rounds.reduce((m, r) => Math.max(m, r.round), 0);
          dispatch({
            type: "train_progress",
            data: { job_id, round: maxRound + 1, stage: "collect", progress: 0, message: "Training round queued" },
          });
        }
      },
      setOffline: async (offline: boolean) => {
        requireBackend();
        await api.setOffline(offline);
        dispatch({ type: "mode", mode: offline ? "offline" : "online" });
      },
      refresh: async () => {
        if (!API_CONFIGURED) return;
        const s = stateRef.current;
        if (s.dataSource !== "live" || s.connection === "down") {
          await loadAll();
          return;
        }
        try {
          await Promise.all([refreshLight(), loadExtras()]);
        } catch {
          dispatch({ type: "connection", connection: "down" });
        }
      },
    };
  }, [refreshLight, loadExtras, loadAll, loadVersions]);

  const value = useMemo<StoreValue>(() => ({ state, actions }), [state, actions]);

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be used inside <StoreProvider>");
  return ctx;
}
