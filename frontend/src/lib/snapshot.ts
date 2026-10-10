/**
 * Snapshots: the normaliser for every payload that enters the app (live API,
 * SSE, localStorage cache, bundled export), plus the cache/bundled loaders.
 * This is the ONE place that tolerates missing keys and turns the API's
 * `router: {}` into null. It never throws on a partial file and never invents data
 * beyond neutral empty defaults.
 */

import { categoryLetter, categoryName, teamFor } from "@/lib/categories";
import type {
  ActivateModelResponse,
  EvalCompare,
  EvalModel,
  Health,
  LossPoint,
  Mode,
  ModelSwitched,
  ModelVersionInfo,
  ModelVersions,
  ReviewItem,
  Round,
  RoundComplete,
  Snapshot,
  Source,
  Summary,
  Ticket,
  TimePoint,
  TrainProgress,
  TrainStage,
} from "@/lib/types";

const CACHE_KEY = "understudy.snapshot.v2";
const BUNDLED_URL = "/export/snapshot.json";
const BUNDLED_TIMEOUT_MS = 4000;

/* ---------- primitives ---------- */

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function mode(v: unknown): Mode {
  return v === "offline" ? "offline" : "online";
}

/* ---------- entity normalisers ---------- */

export function normalizeHealth(raw: unknown): Health {
  const r = isRec(raw) ? raw : {};
  return { status: str(r.status, "unknown"), model_version: str(r.model_version), mode: mode(r.mode) };
}

export function normalizeSummary(raw: unknown): Summary {
  const r = isRec(raw) ? raw : {};
  return {
    total: num(r.total),
    local_share: num(r.local_share),
    teacher_share: num(r.teacher_share),
    review_share: num(r.review_share),
    cost_usd_total: num(r.cost_usd_total),
    cost_avoided_usd: num(r.cost_avoided_usd),
    model_version: str(r.model_version),
    mode: mode(r.mode),
  };
}

export function normalizeTimePoint(raw: unknown): TimePoint | null {
  if (!isRec(raw) || typeof raw.t !== "string") return null;
  return {
    t: raw.t,
    local_share: num(raw.local_share),
    cost_cumulative: num(raw.cost_cumulative),
    cost_cloud_only_cumulative: num(raw.cost_cloud_only_cumulative),
  };
}

function source(v: unknown): Source {
  return v === "teacher" || v === "review" ? v : "local";
}

export function normalizeTicket(raw: unknown): Ticket | null {
  if (!isRec(raw)) return null;
  const id = typeof raw.id === "string" ? Number(raw.id) : num(raw.id, Number.NaN);
  if (!Number.isFinite(id)) return null;
  // category is a letter; tolerate a raw name or only category_name being present
  const rawCat = str(raw.category) || str(raw.category_name);
  const letter = categoryLetter(rawCat) ?? rawCat;
  return {
    id,
    category: letter,
    category_name: categoryName(letter),
    priority: str(raw.priority),
    team: str(raw.team) || teamFor(letter),
    source: source(raw.source),
    confidence: typeof raw.confidence === "number" && Number.isFinite(raw.confidence) ? raw.confidence : null,
    latency_ms: num(raw.latency_ms),
    cost_usd: num(raw.cost_usd),
    model_version: str(raw.model_version),
    text: str(raw.text),
    created_at: str(raw.created_at),
  };
}

export function normalizeReviewItem(raw: unknown): ReviewItem | null {
  if (!isRec(raw)) return null;
  const id = typeof raw.id === "string" ? Number(raw.id) : num(raw.id, Number.NaN);
  if (!Number.isFinite(id)) return null;
  return { id, text: str(raw.text), created_at: str(raw.created_at) };
}

function normalizeLoss(raw: unknown): LossPoint[] {
  const out: LossPoint[] = [];
  for (const p of arr(raw)) {
    if (isRec(p) && typeof p.step === "number" && typeof p.loss === "number") out.push({ step: p.step, loss: p.loss });
  }
  return out;
}

export function normalizeRound(raw: unknown): Round | null {
  if (!isRec(raw) || typeof raw.round !== "number") return null;
  const ev = isRec(raw.eval) ? raw.eval : {};
  return {
    round: raw.round,
    model_version: str(raw.model_version),
    examples: num(raw.examples),
    loss: normalizeLoss(raw.loss),
    wall_time_s: num(raw.wall_time_s),
    hardware: str(raw.hardware),
    cost_usd: num(raw.cost_usd),
    promoted: raw.promoted === true,
    reason: str(raw.reason),
    eval: {
      category_acc: num(ev.category_acc),
      category_macro_f1: num(ev.category_macro_f1),
      priority_acc: num(ev.priority_acc),
    },
  };
}

export function normalizeEvalModel(raw: unknown): EvalModel | null {
  if (!isRec(raw) || typeof raw.name !== "string" || raw.name === "") return null;
  return {
    name: raw.name,
    category_acc: num(raw.category_acc),
    category_macro_f1: num(raw.category_macro_f1),
    priority_acc: num(raw.priority_acc),
    latency_ms: num(raw.latency_ms),
    cost_per_1k: num(raw.cost_per_1k),
  };
}

export function emptyEvalCompare(): EvalCompare {
  return { provisional: false, models: [], router: null, per_category_f1: {}, confusion: {} };
}

export function normalizeEvalCompare(raw: unknown): EvalCompare {
  if (!isRec(raw)) return emptyEvalCompare();
  const models: EvalModel[] = [];
  for (const m of arr(raw.models)) {
    const n = normalizeEvalModel(m);
    if (n) models.push(n);
  }
  const per: Record<string, Record<string, number>> = {};
  if (isRec(raw.per_category_f1)) {
    for (const [model, byCat] of Object.entries(raw.per_category_f1)) {
      if (!isRec(byCat)) continue;
      const row: Record<string, number> = {};
      for (const [cat, v] of Object.entries(byCat)) {
        if (typeof v === "number" && Number.isFinite(v)) row[cat] = v;
      }
      per[model] = row;
    }
  }
  const confusion: Record<string, number[][]> = {};
  if (isRec(raw.confusion)) {
    for (const [model, m] of Object.entries(raw.confusion)) {
      if (!Array.isArray(m)) continue;
      confusion[model] = m.map((row) => arr(row).map((c) => num(c)));
    }
  }
  return {
    provisional: raw.provisional === true,
    models,
    router: normalizeEvalModel(raw.router), // `{}` (no router eval yet) -> null
    per_category_f1: per,
    confusion,
  };
}

/* ---------- events ---------- */

const STAGES: readonly string[] = ["collect", "train", "evaluate", "promote"];

export function normalizeTrainProgress(raw: unknown): TrainProgress | null {
  if (!isRec(raw)) return null;
  const failed = raw.type === "round_failed";
  const stage: TrainStage = STAGES.includes(str(raw.stage)) ? (raw.stage as TrainStage) : "train";
  const out: TrainProgress = {
    job_id: str(raw.job_id),
    round: num(raw.round),
    stage,
    progress: Math.min(1, Math.max(0, num(raw.progress))),
  };
  if (typeof raw.step === "number") out.step = raw.step;
  if (typeof raw.total_steps === "number") out.total_steps = raw.total_steps;
  if (typeof raw.loss === "number") out.loss = raw.loss;
  if (typeof raw.message === "string") out.message = raw.message;
  if (failed) out.error = str(raw.error, "Training round failed");
  return out;
}

/** Accepts {job_id, round: Round, previous_model_version} or a flat Round with job_id. */
export function normalizeRoundComplete(raw: unknown): RoundComplete | null {
  if (!isRec(raw)) return null;
  const round = normalizeRound(isRec(raw.round) ? raw.round : raw);
  if (!round) return null;
  return {
    job_id: str(raw.job_id),
    round,
    previous_model_version: str(raw.previous_model_version),
  };
}

/** SSE "model" payload; null unless it names the new version. */
export function normalizeModelSwitched(raw: unknown): ModelSwitched | null {
  if (!isRec(raw)) return null;
  const model_version = str(raw.model_version);
  if (!model_version) return null;
  return { model_version, previous_model_version: str(raw.previous_model_version) };
}

export function normalizeModelVersions(raw: unknown): ModelVersions {
  const r = isRec(raw) ? raw : {};
  const versions: ModelVersionInfo[] = [];
  for (const v of arr(r.versions)) {
    if (!isRec(v) || typeof v.version !== "string" || v.version === "") continue;
    versions.push({
      version: v.version,
      available: v.available === true,
      promoted: v.promoted === true,
      category_macro_f1:
        typeof v.category_macro_f1 === "number" && Number.isFinite(v.category_macro_f1) ? v.category_macro_f1 : null,
    });
  }
  return { active: str(r.active), versions };
}

export function normalizeActivateModel(raw: unknown): ActivateModelResponse | null {
  if (!isRec(raw)) return null;
  const model_version = str(raw.model_version);
  if (!model_version) return null;
  return {
    model_version,
    previous_model_version: str(raw.previous_model_version),
    changed: raw.changed === true,
    load_s: num(raw.load_s),
  };
}

/* ---------- snapshot ---------- */

export function normalizeSnapshot(raw: unknown): Snapshot | null {
  if (!isRec(raw)) return null;
  const timeseries: TimePoint[] = [];
  for (const p of arr(raw.timeseries)) {
    const n = normalizeTimePoint(p);
    if (n) timeseries.push(n);
  }
  const tickets: Ticket[] = [];
  for (const t of arr(raw.tickets)) {
    const n = normalizeTicket(t);
    if (n) tickets.push(n);
  }
  const review_queue: ReviewItem[] = [];
  for (const r of arr(raw.review_queue)) {
    const n = normalizeReviewItem(r);
    if (n) review_queue.push(n);
  }
  const rounds: Round[] = [];
  for (const r of arr(raw.rounds)) {
    const n = normalizeRound(r);
    if (n) rounds.push(n);
  }
  rounds.sort((a, b) => a.round - b.round);
  const health = normalizeHealth(raw.health);
  const summary = normalizeSummary(raw.summary);
  if (!health.model_version) health.model_version = summary.model_version;
  if (!summary.model_version) summary.model_version = health.model_version;
  return {
    generated_at: str(raw.generated_at),
    health,
    summary,
    timeseries,
    tickets,
    review_queue,
    rounds,
    eval_compare: normalizeEvalCompare(raw.eval_compare),
  };
}

/** Milliseconds since epoch of a snapshot's generated_at, or -Infinity when unparseable. */
export function snapshotTime(s: Snapshot | null): number {
  if (!s) return Number.NEGATIVE_INFINITY;
  const t = Date.parse(s.generated_at);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

/* ---------- cache (localStorage) ---------- */

export function saveSnapshot(s: Snapshot): void {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable or full: caching is best-effort */
  }
}

export function loadCachedSnapshot(): Snapshot | null {
  try {
    window.localStorage.removeItem("understudy.snapshot.v1"); // pre-real-data cache, never trusted
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const snap = normalizeSnapshot(JSON.parse(raw) as unknown);
    return snap && snap.generated_at ? snap : null;
  } catch {
    return null;
  }
}

/* ---------- bundled file (same origin, works offline from `next start`) ---------- */

export async function loadBundledSnapshot(): Promise<Snapshot | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), BUNDLED_TIMEOUT_MS);
  try {
    const res = await fetch(BUNDLED_URL, { signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) return null;
    return normalizeSnapshot((await res.json()) as unknown);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Best available saved snapshot: whichever of cache / bundled has the newer generated_at. */
export async function loadBestSnapshot(): Promise<{ snapshot: Snapshot; from: "cache" | "bundled" } | null> {
  const cached = loadCachedSnapshot();
  const bundled = await loadBundledSnapshot();
  if (cached && (!bundled || snapshotTime(cached) > snapshotTime(bundled))) return { snapshot: cached, from: "cache" };
  if (bundled) return { snapshot: bundled, from: "bundled" };
  return null;
}
