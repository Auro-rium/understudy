/**
 * Live event feed. Mock mode: the in-browser engine's bus. Real mode: SSE from
 * GET /api/events, falling back to 2s polling when the stream is unavailable.
 */

import { API_URL, IS_MOCK, api } from "@/lib/api";
import { getEngine } from "@/lib/mock/engine";
import type { Mode, ServerEvent } from "@/lib/types";

export type EventStatus = "sse" | "polling" | "mock" | "down";

const EVENT_TYPES = ["prediction", "train_progress", "round_complete", "mode"] as const;
const POLL_MS = 2000;
const MAX_BACKOFF_MS = 15000;
const POLL_TICKETS = 30;
const SEEN_CAP = 500;

function isServerEvent(v: unknown): v is ServerEvent {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.type === "string" && (EVENT_TYPES as readonly string[]).includes(o.type) && "data" in o;
}

/** Accepts {type,data} envelopes, or a bare payload when the SSE `event:` field names the type. */
function parseEvent(raw: string, namedType?: string): ServerEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (isServerEvent(parsed)) return parsed;
  if (namedType && (EVENT_TYPES as readonly string[]).includes(namedType)) {
    return isServerEvent({ type: namedType, data: parsed })
      ? ({ type: namedType, data: parsed } as ServerEvent)
      : null;
  }
  return null;
}

export function subscribe(
  onEvent: (e: ServerEvent) => void,
  onStatus?: (s: EventStatus) => void,
): () => void {
  if (IS_MOCK) {
    const off = getEngine().subscribe(onEvent);
    onStatus?.("mock");
    return off;
  }

  let closed = false;
  let es: EventSource | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let backoff = 1000;
  let status: EventStatus | null = null;

  // polling state persists across polling sessions so we do not replay old tickets
  const seen = new Set<string>();
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

      if (seeded) {
        // tickets arrive newest first; emit oldest first
        for (const t of fresh.slice().reverse()) onEvent({ type: "prediction", data: t });
        if (lastMode !== null && health.mode !== lastMode) {
          onEvent({ type: "mode", data: { mode: health.mode } });
        }
        for (const r of rounds.filter((x) => x.round > lastRound).sort((a, b) => a.round - b.round)) {
          onEvent({
            type: "round_complete",
            data: { job_id: `poll-${r.round}`, round: r, previous_model_version: lastVersion || r.model_version },
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

  const connect = (): void => {
    if (closed) return;
    let source: EventSource;
    try {
      source = new EventSource(`${API_URL}/api/events`);
    } catch {
      startPolling();
      retryTimer = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      return;
    }
    es = source;
    source.onopen = () => {
      backoff = 1000;
      stopPolling();
      setStatus("sse");
    };
    source.onmessage = (m: MessageEvent<string>) => {
      const ev = parseEvent(m.data);
      if (ev) onEvent(ev);
    };
    for (const type of EVENT_TYPES) {
      source.addEventListener(type, (m) => {
        const ev = parseEvent((m as MessageEvent<string>).data, type);
        if (ev) onEvent(ev);
      });
    }
    source.onerror = () => {
      source.close();
      if (es === source) es = null;
      if (closed) return;
      startPolling();
      retryTimer = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    };
  };

  connect();

  return () => {
    closed = true;
    if (es) es.close();
    es = null;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    stopPolling();
  };
}
