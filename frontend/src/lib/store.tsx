"use client";

/**
 * Single app-wide store: loads everything through `api`, applies live events,
 * keeps a cached snapshot so the UI still has something to show offline.
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
import { ApiError, IS_MOCK, api } from "@/lib/api";
import { subscribe, type EventStatus } from "@/lib/events";
import { TEACHER_COST_PER_TICKET } from "@/lib/mock/seed";
import { loadSnapshot, saveSnapshot } from "@/lib/snapshot";
import type {
  EvalCompare,
  Health,
  Mode,
  ReviewItem,
  Round,
  RoundComplete,
  ServerEvent,
  Snapshot,
  Summary,
  Ticket,
  TimePoint,
  TrainProgress,
  TrainStage,
} from "@/lib/types";

/* ---------- public types ---------- */

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
  isMock: boolean;
  connection: Connection;
  snapshotAt: string | null;
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
  activeStage: ActiveStage;
  lastRound: LastRound | null;
  roundMarkers: RoundMarker[];
  lastPredictionAt: number | null;
}

export interface StoreActions {
  startStream(ratePerMin?: number): Promise<void>;
  stopStream(): Promise<void>;
  runTrainingRound(backend?: string): Promise<void>;
  setOffline(offline: boolean): Promise<void>;
  refresh(): Promise<void>;
}

/* ---------- internals ---------- */

const TICKET_CAP = 100;
const REFRESH_MS = 4000;
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
  | { type: "init"; data: LoadedData; connection: Connection; snapshotAt: string | null; markers: RoundMarker[] | null }
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
  | { type: "refresh"; summary: Summary; timeseries: TimePoint[]; reviewQueue: ReviewItem[]; health: Health }
  | { type: "extras"; rounds: Round[]; evalCompare: EvalCompare }
  | { type: "streaming"; on: boolean };

function initialState(): StoreState {
  return {
    loaded: false,
    isMock: IS_MOCK,
    connection: "live",
    snapshotAt: null,
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
    activeStage: "idle",
    lastRound: null,
    roundMarkers: [],
    lastPredictionAt: null,
  };
}

function connectionFromStatus(s: EventStatus | null): Connection {
  return s === "polling" || s === "down" ? "polling" : "live";
}

function reducer(state: StoreState, a: Action): StoreState {
  switch (a.type) {
    case "init":
      return {
        ...state,
        loaded: true,
        connection: a.connection,
        snapshotAt: a.snapshotAt,
        health: a.data.health,
        summary: a.data.summary,
        timeseries: a.data.timeseries,
        tickets: a.data.tickets.slice(0, TICKET_CAP),
        reviewQueue: a.data.reviewQueue,
        rounds: a.data.rounds,
        evalCompare: a.data.evalCompare,
        mode: a.data.health.mode,
        modelVersion: a.data.health.model_version,
        roundMarkers: a.markers ?? state.roundMarkers,
      };
    case "failed":
      return { ...state, loaded: true, connection: "down" };
    case "connection":
      return state.connection === a.connection ? state : { ...state, connection: a.connection };
    case "eventStatus": {
      if (state.connection === "snapshot") return state;
      const next = a.status === "down" ? "down" : connectionFromStatus(a.status);
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
      const summary = state.summary
        ? {
            ...state.summary,
            total: state.summary.total + fresh.length,
            cost_usd_total: state.summary.cost_usd_total + cost,
            cost_avoided_usd: Math.max(
              0,
              state.summary.cost_avoided_usd + fresh.length * TEACHER_COST_PER_TICKET - cost,
            ),
          }
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
    case "train_progress":
      return { ...state, trainProgress: a.data, activeStage: a.data.stage };
    case "trainStale":
      if (state.trainProgress === null) return state;
      return {
        ...state,
        trainProgress: null,
        activeStage: TRAIN_STAGES.includes(state.activeStage) ? "idle" : state.activeStage,
      };
    case "round_complete": {
      const r = a.data.round;
      const rounds = [...state.rounds.filter((x) => x.round !== r.round), r].sort((x, y) => x.round - y.round);
      const version = r.promoted ? r.model_version : a.data.previous_model_version;
      const lastPoint = state.timeseries[state.timeseries.length - 1];
      const marker: RoundMarker = {
        at: lastPoint ? lastPoint.t : new Date(a.at).toISOString(),
        version: r.model_version,
        promoted: r.promoted,
      };
      return {
        ...state,
        rounds,
        modelVersion: version,
        health: state.health ? { ...state.health, model_version: version } : state.health,
        summary: state.summary ? { ...state.summary, model_version: version } : state.summary,
        trainProgress: null,
        activeStage: "idle",
        lastRound: {
          round: r,
          previousVersion: a.data.previous_model_version,
          localShareBefore: a.before,
          localShareAfter: a.after,
          delta: a.after - a.before,
          at: a.at,
        },
        roundMarkers: [...state.roundMarkers.filter((m) => m.version !== marker.version), marker],
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
    case "refresh":
      return {
        ...state,
        summary: a.summary,
        timeseries: a.timeseries,
        reviewQueue: a.reviewQueue,
        health: a.health,
        mode: a.health.mode,
        modelVersion: a.health.model_version,
      };
    case "extras":
      return { ...state, rounds: a.rounds, evalCompare: a.evalCompare };
    case "streaming":
      return { ...state, streaming: a.on };
  }
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

  useEffect(() => {
    stateRef.current = state;
  });

  /** Full (re)load. Falls back to the cached snapshot if the API is unreachable. */
  const loadAll = useCallback(async (): Promise<void> => {
    try {
      const data = await fetchAll();
      let markers: RoundMarker[] | null = null;
      if (stateRef.current.roundMarkers.length === 0) {
        const m = await api.mockMarkers();
        markers = m.length ? m : null;
      }
      dispatch({
        type: "init",
        data,
        connection: connectionFromStatus(eventStatusRef.current),
        snapshotAt: null,
        markers,
      });
    } catch {
      if (stateRef.current.loaded) {
        dispatch({ type: "connection", connection: stateRef.current.connection === "snapshot" ? "snapshot" : "down" });
        return;
      }
      const snap = loadSnapshot();
      if (snap) {
        dispatch({ type: "init", data: fromSnapshot(snap), connection: "snapshot", snapshotAt: snap.generated_at, markers: null });
      } else {
        dispatch({ type: "failed" });
      }
    }
  }, []);

  const loadExtras = useCallback(async (): Promise<void> => {
    const [rounds, evalCompare] = await Promise.all([api.rounds(), api.evalCompare()]);
    dispatch({ type: "extras", rounds, evalCompare });
  }, []);

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
      if (data.round.promoted) {
        if (IS_MOCK) {
          void api.mockLocalTarget().then((t) => {
            if (t !== null) dispatch({ type: "lastRoundAfter", after: t });
          });
        } else {
          measureUntilRef.current = Date.now() + MEASURE_MS;
        }
      }
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
      }
    },
    [flushPredictions, handleRoundComplete],
  );

  // mount: initial load, event subscription, periodic refresh / retry
  useEffect(() => {
    let alive = true;
    void loadAll();

    const unsubscribe = subscribe(onEvent, (status) => {
      eventStatusRef.current = status;
      if (alive) dispatch({ type: "eventStatus", status });
    });

    const refreshTimer = setInterval(() => {
      const s = stateRef.current;
      if (!s.loaded || inflightRef.current) return;
      inflightRef.current = true;
      const job: Promise<void> =
        s.connection === "snapshot" || s.connection === "down"
          ? loadAll()
          : (async () => {
              try {
                await refreshLight();
                refreshCountRef.current += 1;
                if (refreshCountRef.current % EXTRAS_EVERY === 0) await loadExtras();
              } catch {
                if (alive) dispatch({ type: "connection", connection: "down" });
              }
            })();
      void job.finally(() => {
        inflightRef.current = false;
      });
    }, REFRESH_MS);

    const staleTimer = setInterval(() => {
      const s = stateRef.current;
      if (s.trainProgress && Date.now() - lastProgressAtRef.current > TRAIN_STALE_MS) {
        dispatch({ type: "trainStale" });
      }
    }, 3000);

    return () => {
      alive = false;
      unsubscribe();
      clearInterval(refreshTimer);
      clearInterval(staleTimer);
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
      if (routingTimerRef.current) clearTimeout(routingTimerRef.current);
      flushTimerRef.current = null;
      routingTimerRef.current = null;
    };
  }, [loadAll, loadExtras, refreshLight, onEvent]);

  // cache the latest good state for offline starts (throttled)
  useEffect(() => {
    const { loaded, connection, health, summary, evalCompare } = state;
    if (!loaded || (connection !== "live" && connection !== "polling")) return;
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

  const actions = useMemo<StoreActions>(
    () => ({
      startStream: async (ratePerMin?: number) => {
        await api.streamStart(ratePerMin ?? DEFAULT_RATE);
        dispatch({ type: "streaming", on: true });
      },
      stopStream: async () => {
        await api.streamStop();
        dispatch({ type: "streaming", on: false });
      },
      runTrainingRound: async (backend = "mlx") => {
        const { job_id } = await api.trainRound(backend);
        const current = stateRef.current.trainProgress;
        if (current === null || current.job_id !== job_id) {
          lastProgressAtRef.current = Date.now();
          dispatch({
            type: "train_progress",
            data: {
              job_id,
              round: stateRef.current.rounds.length + 1,
              stage: "collect",
              progress: 0,
              message: "Training round queued",
            },
          });
        }
      },
      setOffline: async (offline: boolean) => {
        await api.setOffline(offline);
        dispatch({ type: "mode", mode: offline ? "offline" : "online" });
      },
      refresh: async () => {
        try {
          await Promise.all([refreshLight(), loadExtras()]);
        } catch {
          dispatch({ type: "connection", connection: "down" });
        }
      },
    }),
    [refreshLight, loadExtras],
  );

  const value = useMemo<StoreValue>(() => ({ state, actions }), [state, actions]);

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be used inside <StoreProvider>");
  return ctx;
}
