/**
 * Live event feed: SSE from GET /api/events, falling back to 2s polling when the
 * stream is unavailable or silent (see the watchdog in connect()). Every payload is normalised. In "snapshot" data-source mode
 * subscribe() does nothing (zero API calls).
 */

import { API_CONFIGURED, api } from "@/lib/api";
import { getApiUrl } from "@/lib/runtime";
import { normalizeModelSwitched, normalizeRoundComplete, normalizeTicket, normalizeTrainProgress } from "@/lib/snapshot";
import type { Mode, ServerEvent } from "@/lib/types";

export type EventStatus = "sse" | "polling" | "down";

const EVENT_TYPES = ["prediction", "train_progress", "round_complete", "mode", "model"] as const;
const POLL_MS = 2000;
const MAX_BACKOFF_MS = 15000;
const POLL_TICKETS = 30;
const SEEN_CAP = 500;
const WATCHDOG_MS = 5000; // an opened stream must deliver a message within this
const IDLE_RECONNECT_MS = 40000; // quiet this long on an established stream: reopen it
const SILENT_RETRY_MS = 60000; // after a silent stream, retry SSE this rarely (keeps the UI from flapping)

function isEnvelope(v: unknown): v is { type: string; data: unknown } {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.type === "string" && (EVENT_TYPES as readonly string[]).includes(o.type) && "data" in o;
}

/** Validates and normalises one event payload by type; null when it is not usable. */
function build(type: string, data: unknown): ServerEvent | null {
  switch (type) {
    case "prediction": {
      const t = normalizeTicket(data);
      return t ? { type: "prediction", data: t } : null;
    }
    case "train_progress": {
      const p = normalizeTrainProgress(data);
      return p ? { type: "train_progress", data: p } : null;
    }
    case "round_complete": {
      const r = normalizeRoundComplete(data);
      return r ? { type: "round_complete", data: r } : null;
    }
    case "mode": {
      const m = (data as { mode?: unknown } | null)?.mode;
      return m === "online" || m === "offline" ? { type: "mode", data: { mode: m } } : null;
    }
    case "model": {
      const m = normalizeModelSwitched(data);
      return m ? { type: "model", data: m } : null;
    }
    default:
      return null; // unknown event types are ignored
  }
}

/** Accepts {type,data} envelopes, or a bare payload when the SSE `event:` field names the type. */
function parseEvent(raw: string, namedType?: string): ServerEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (isEnvelope(parsed)) return build(parsed.type, parsed.data);
  if (namedType && (EVENT_TYPES as readonly string[]).includes(namedType)) return build(namedType, parsed);
  return null;
}

export function subscribe(
  onEvent: (e: ServerEvent) => void,
  onStatus?: (s: EventStatus) => void,
): () => void {
  if (!API_CONFIGURED) return () => undefined;

  let closed = false;
  let es: EventSource | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let backoff = 1000;
  let status: EventStatus | null = null;

  // polling state persists across polling sessions so we do not replay old tickets
  const seen = new Set<number>();
  let seeded = false;
  let lastMode: Mode | null = null;
  let lastRound = 0;
  let lastVersion = "";

  const setStatus = (s: EventStatus): void => {
    if (closed || s === status) return;
    status = s;
    onStatus?.(s);
  };

  const poll = async (): Promise<void> => {
    try {
      const [tickets, health, rounds] = await Promise.all([
        api.recentTickets(POLL_TICKETS),
        api.health(),
        api.rounds(),
      ]);
      if (closed || pollTimer === null) return;

      const fresh = tickets.filter((t) => !seen.has(t.id));
      for (const t of tickets) seen.add(t.id);
      if (seen.size > SEEN_CAP) {
        const keep = Array.from(seen).slice(-SEEN_CAP);
        seen.clear();
        keep.forEach((id) => seen.add(id));
      }
      const maxRound = rounds.reduce((m, r) => Math.max(m, r.round), 0);

      // tickets arrive newest first; emit oldest first. Also on the first poll: the store drops ids it already has.
      for (const t of fresh.slice().reverse()) onEvent({ type: "prediction", data: t });
      if (seeded) {
        if (lastMode !== null && health.mode !== lastMode) {
          onEvent({ type: "mode", data: { mode: health.mode } });
        }
        const newRounds = rounds.filter((x) => x.round > lastRound).sort((a, b) => a.round - b.round);
        for (const r of newRounds) {
          onEvent({
            type: "round_complete",
            data: { job_id: `poll-${r.round}`, round: r, previous_model_version: lastVersion },
          });
        }
        // a manual model switch has no round: report it from /api/health
        if (newRounds.length === 0 && lastVersion && health.model_version && health.model_version !== lastVersion) {
          onEvent({
            type: "model",
            data: { model_version: health.model_version, previous_model_version: lastVersion },
          });
        }
      }
      seeded = true;
      lastMode = health.mode;
      lastRound = maxRound;
      lastVersion = health.model_version;
      setStatus("polling");
    } catch {
      setStatus("down");
    }
    if (!closed && pollTimer !== null) pollTimer = setTimeout(() => void poll(), POLL_MS);
  };

  const startPolling = (): void => {
    if (pollTimer !== null || closed) return;
    pollTimer = setTimeout(() => void poll(), 0);
  };

  const stopPolling = (): void => {
    if (pollTimer !== null) clearTimeout(pollTimer);
    pollTimer = null;
  };

  let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** true after a connection opened but never delivered a message (e.g. a proxy that buffers the stream) */
  let silentMode = false;

  const clearWatchdog = (): void => {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    watchdogTimer = null;
  };
  const clearIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  };

  const connect = (): void => {
    if (closed) return;
    retryTimer = null;
    let source: EventSource;
    try {
      source = new EventSource(`${getApiUrl()}/api/events`);
    } catch {
      startPolling();
      retryTimer = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      return;
    }
    es = source;
    let alive = false; // true once any message (data or named event) arrived on this connection

    const drop = (): void => {
      source.close();
      if (es === source) es = null;
      clearWatchdog();
      clearIdle();
    };

    // Healthy streams send an `event: mode` straight away. Idle ones only send comment pings, which
    // EventSource never surfaces, so after IDLE_RECONNECT_MS of quiet we quietly reopen instead of
    // declaring the stream dead; the new connection must again prove itself within WATCHDOG_MS.
    const armIdle = (): void => {
      clearIdle();
      idleTimer = setTimeout(() => {
        if (closed || es !== source) return;
        drop();
        connect();
      }, IDLE_RECONNECT_MS);
    };

    const touch = (): void => {
      if (closed || es !== source) return;
      if (!alive) {
        alive = true;
        clearWatchdog();
        silentMode = false;
        backoff = 1000;
        stopPolling();
        setStatus("sse");
      }
      armIdle();
    };

    // Some proxies (Cloudflare quick tunnels) answer 200 and fire `open` but never deliver a byte.
    // No message within WATCHDOG_MS: give up on this stream, poll every 2 s, retry SSE only rarely.
    watchdogTimer = setTimeout(() => {
      if (closed || es !== source || alive) return;
      drop();
      silentMode = true;
      startPolling();
      retryTimer = setTimeout(connect, SILENT_RETRY_MS);
    }, WATCHDOG_MS);

    source.onmessage = (m: MessageEvent<string>) => {
      touch();
      const ev = parseEvent(m.data);
      if (ev) onEvent(ev);
    };
    for (const type of EVENT_TYPES) {
      source.addEventListener(type, (m) => {
        touch();
        const ev = parseEvent((m as MessageEvent<string>).data, type);
        if (ev) onEvent(ev);
      });
    }
    source.onerror = () => {
      const current = es === source;
      drop();
      if (closed || !current) return;
      startPolling();
      retryTimer = setTimeout(connect, silentMode ? SILENT_RETRY_MS : backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    };
  };

  connect();

  return () => {
    closed = true;
    if (es) es.close();
    es = null;
    clearWatchdog();
    clearIdle();
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    stopPolling();
  };
}
