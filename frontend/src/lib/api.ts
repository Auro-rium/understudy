/**
 * API client. In mock mode (NEXT_PUBLIC_MOCK=1) every call is served by the
 * in-browser engine; otherwise it hits the FastAPI backend at API_URL.
 * Callers cannot tell the difference.
 */

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
  TrainRoundResponse,
} from "@/lib/types";
import { getEngine } from "@/lib/mock/engine";

export const IS_MOCK: boolean = process.env.NEXT_PUBLIC_MOCK === "1";
export const API_URL: string = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8000";

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
  trainRound(backend: string): Promise<TrainRoundResponse>;
  streamStart(ratePerMin: number): Promise<void>;
  streamStop(): Promise<void>;
  setOffline(offline: boolean): Promise<void>;
  /** Mock only: nominal local share of the serving model (null against a real backend). */
  mockLocalTarget(): Promise<number | null>;
  /** Mock only: where the history rounds were promoted (empty against a real backend). */
  mockMarkers(): Promise<{ at: string; version: string; promoted: boolean }[]>;
}

const mockApi: Api = {
  health: () => getEngine().health(),
  classify: (text) => getEngine().classify(text),
  summary: () => getEngine().summary(),
  timeseries: () => getEngine().timeseries(),
  recentTickets: (limit = 50) => getEngine().recentTickets(limit),
  reviewQueue: () => getEngine().reviewQueue(),
  rounds: () => getEngine().rounds(),
  evalCompare: () => getEngine().evalCompare(),
  snapshot: () => getEngine().snapshot(),
  trainRound: (backend) => getEngine().trainRound({ backend }),
  streamStart: async (ratePerMin) => {
    await getEngine().streamStart(ratePerMin);
  },
  streamStop: async () => {
    await getEngine().streamStop();
  },
  setOffline: async (offline) => {
    await getEngine().setOffline(offline);
  },
  mockLocalTarget: async () => getEngine().peekLocalTarget(),
  mockMarkers: async () => getEngine().historyMarkers(),
};

const realApi: Api = {
  health: () => request<Health>("/api/health"),
  classify: (text) => request<ClassifyResult>("/api/classify", { method: "POST", body: { text } }),
  summary: () => request<Summary>("/api/metrics/summary"),
  timeseries: () => request<TimePoint[]>("/api/metrics/timeseries"),
  recentTickets: (limit = 50) => request<Ticket[]>(`/api/tickets/recent?limit=${limit}`),
  reviewQueue: () => request<ReviewItem[]>("/api/review_queue"),
  rounds: () => request<Round[]>("/api/rounds"),
  evalCompare: () => request<EvalCompare>("/api/eval/compare"),
  snapshot: () => request<Snapshot>("/api/snapshot"),
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
  mockLocalTarget: async () => null,
  mockMarkers: async () => [],
};

export const api: Api = IS_MOCK ? mockApi : realApi;
