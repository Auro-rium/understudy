/**
 * API client for the FastAPI backend. Config:
 *   NEXT_PUBLIC_API_URL      default http://127.0.0.1:8000
 *   NEXT_PUBLIC_DATA_SOURCE  "api" (default) | "snapshot"  -- "snapshot" never calls the API.
 * Every response is passed through the normaliser in lib/snapshot.ts.
 */

import {
  normalizeEvalCompare,
  normalizeHealth,
  normalizeReviewItem,
  normalizeRound,
  normalizeSnapshot,
  normalizeSummary,
  normalizeTicket,
  normalizeTimePoint,
} from "@/lib/snapshot";
import type {
  ClassifyResult,
  EvalCompare,
  Health,
  ReviewItem,
  Round,
  Snapshot,
  Summary,
  Ticket,
  TimePoint,
  TrainBackend,
  TrainRoundResponse,
} from "@/lib/types";

export type DataSourceMode = "api" | "snapshot";

export const API_URL: string = (process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8000").replace(/\/+$/, "");
export const DATA_SOURCE: DataSourceMode = process.env.NEXT_PUBLIC_DATA_SOURCE === "snapshot" ? "snapshot" : "api";
/** false in "snapshot" mode: the app must make zero API calls. */
export const API_CONFIGURED: boolean = DATA_SOURCE === "api";

const TIMEOUT_MS = 4000;

export class ApiError extends Error {
  readonly status: number | null;
  readonly path: string;

  constructor(message: string, status: number | null, path: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ApiError";
    this.status = status;
    this.path = path;
  }
}

async function request<T>(path: string, init?: { method: "POST"; body?: unknown }): Promise<T> {
  if (!API_CONFIGURED) throw new ApiError(`API disabled (NEXT_PUBLIC_DATA_SOURCE=snapshot): ${path}`, null, path);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const hasBody = init?.body !== undefined;
    const res = await fetch(`${API_URL}${path}`, {
      method: init?.method ?? "GET",
      signal: ctrl.signal,
      headers: hasBody ? { "Content-Type": "application/json" } : undefined,
      body: hasBody ? JSON.stringify(init?.body) : undefined,
    });
    if (!res.ok) {
      throw new ApiError(`${res.status} ${res.statusText} for ${path}`, res.status, path);
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const reason = err instanceof Error && err.name === "AbortError" ? "timed out" : "unreachable";
    throw new ApiError(`Request to ${path} failed (${reason})`, null, path, err);
  } finally {
    clearTimeout(timer);
  }
}

function list<T>(raw: unknown, one: (v: unknown) => T | null): T[] {
  const out: T[] = [];
  if (Array.isArray(raw)) {
    for (const v of raw) {
      const n = one(v);
      if (n) out.push(n);
    }
  }
  return out;
}

export interface Api {
  health(): Promise<Health>;
  classify(text: string): Promise<ClassifyResult>;
  summary(): Promise<Summary>;
  timeseries(): Promise<TimePoint[]>;
  recentTickets(limit?: number): Promise<Ticket[]>;
  reviewQueue(): Promise<ReviewItem[]>;
  rounds(): Promise<Round[]>;
  evalCompare(): Promise<EvalCompare>;
  snapshot(): Promise<Snapshot>;
  trainRound(backend: TrainBackend): Promise<TrainRoundResponse>;
  streamStart(ratePerMin: number): Promise<void>;
  streamStop(): Promise<void>;
  setOffline(offline: boolean): Promise<void>;
}

export const api: Api = {
  health: async () => normalizeHealth(await request<unknown>("/api/health")),
  classify: async (text) => {
    const raw = await request<Record<string, unknown>>("/api/classify", { method: "POST", body: { text } });
    const t = normalizeTicket({ ...raw, text, created_at: "" });
    if (!t) throw new ApiError("Malformed /api/classify response", null, "/api/classify");
    return t;
  },
  summary: async () => normalizeSummary(await request<unknown>("/api/metrics/summary")),
  timeseries: async () => list(await request<unknown>("/api/metrics/timeseries"), normalizeTimePoint),
  recentTickets: async (limit = 50) => list(await request<unknown>(`/api/tickets/recent?limit=${limit}`), normalizeTicket),
  reviewQueue: async () => list(await request<unknown>("/api/review_queue"), normalizeReviewItem),
  rounds: async () => list(await request<unknown>("/api/rounds"), normalizeRound).sort((a, b) => a.round - b.round),
  evalCompare: async () => normalizeEvalCompare(await request<unknown>("/api/eval/compare")),
  snapshot: async () => {
    const s = normalizeSnapshot(await request<unknown>("/api/snapshot"));
    if (!s) throw new ApiError("Malformed /api/snapshot response", null, "/api/snapshot");
    return s;
  },
  trainRound: (backend) => request<TrainRoundResponse>("/api/train/round", { method: "POST", body: { backend } }),
  streamStart: async (ratePerMin) => {
    await request<unknown>("/api/stream/start", { method: "POST", body: { rate_per_min: ratePerMin } });
  },
  streamStop: async () => {
    await request<unknown>("/api/stream/stop", { method: "POST" });
  },
  setOffline: async (offline) => {
    await request<unknown>("/api/mode/offline", { method: "POST", body: { offline } });
  },
};
