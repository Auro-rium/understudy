/**
 * Single source of truth for every API payload.
 * These mirror the FastAPI contract (backend/schemas.py) exactly.
 * Category is always the backend LETTER ("A".."H"); go through lib/categories.ts for names/labels.
 */

export type Mode = "online" | "offline";
export type Source = "local" | "teacher" | "review";

export interface Health {
  status: string;
  model_version: string;
  mode: Mode;
}

export interface ClassifyResult {
  id: number;
  /** backend category letter "A".."H" */
  category: string;
  /** raw backend name, e.g. "payment_delay" (use categoryLabel() for display) */
  category_name: string;
  priority: string; // "P1" | "P2" | "P3" | "P4"
  team: string;
  source: Source;
  confidence: number | null; // 0..1, null when the router had no score
  latency_ms: number;
  cost_usd: number;
  model_version: string;
}

/** /api/tickets/recent rows and SSE "prediction" payloads */
export interface Ticket extends ClassifyResult {
  text: string;
  created_at: string; // ISO
}

export interface Summary {
  total: number;
  local_share: number; // 0..1
  teacher_share: number;
  review_share: number;
  cost_usd_total: number;
  cost_avoided_usd: number;
  model_version: string;
  mode: Mode;
}

export interface TimePoint {
  t: string; // ISO
  local_share: number;
  cost_cumulative: number;
  cost_cloud_only_cumulative: number;
}

export interface ReviewItem {
  id: number;
  text: string;
  created_at: string;
}

export interface LossPoint {
  step: number;
  loss: number;
}

export interface RoundEval {
  category_acc: number;
  category_macro_f1: number;
  priority_acc: number;
}

export interface Round {
  round: number;
  model_version: string;
  examples: number;
  loss: LossPoint[];
  wall_time_s: number;
  hardware: string;
  cost_usd: number;
  promoted: boolean;
  reason: string;
  eval: RoundEval;
}

export interface EvalModel {
  name: string;
  category_acc: number;
  category_macro_f1: number;
  priority_acc: number;
  latency_ms: number;
  cost_per_1k: number;
}

export interface EvalCompare {
  provisional: boolean;
  /** e.g. "base", "round_1", "round_2"; there may be no teacher row */
  models: EvalModel[];
  /** null until a router eval exists (the API sends {} for that; normalised on load) */
  router: EvalModel | null;
  /** model name -> category LETTER -> F1 */
  per_category_f1: Record<string, Record<string, number>>;
  /** model name -> 8x8 matrix, rows = true category, cols = predicted, both in letter order A..H */
  confusion: Record<string, number[][]>;
}

/** Where the data currently on screen came from. */
export type SnapshotSource = "live" | "cache" | "bundled";

export interface Snapshot {
  generated_at: string; // ISO
  health: Health;
  summary: Summary;
  timeseries: TimePoint[];
  tickets: Ticket[];
  review_queue: ReviewItem[];
  rounds: Round[];
  eval_compare: EvalCompare;
}

/* ---------- SSE events (GET /api/events) ---------- */

export type TrainStage = "collect" | "train" | "evaluate" | "promote";

export interface TrainProgress {
  job_id: string;
  round: number;
  stage: TrainStage;
  progress: number; // 0..1 overall
  step?: number;
  total_steps?: number;
  loss?: number;
  message?: string;
  /** set when the backend reported a failed round (event type "round_failed") */
  error?: string;
}

export interface RoundComplete {
  job_id: string;
  round: Round;
  /** version being served before this round finished */
  previous_model_version: string;
}

/** SSE "model": the serving model was switched (POST /api/model/activate). */
export interface ModelSwitched {
  model_version: string;
  previous_model_version: string;
}

export type ServerEvent =
  | { type: "prediction"; data: Ticket }
  | { type: "train_progress"; data: TrainProgress }
  | { type: "round_complete"; data: RoundComplete }
  | { type: "mode"; data: { mode: Mode } }
  | { type: "model"; data: ModelSwitched };

/* ---------- model versions (GET /api/model/versions, POST /api/model/activate) ---------- */

export interface ModelVersionInfo {
  version: string;
  available: boolean;
  promoted: boolean;
  /** null when the backend sent no score */
  category_macro_f1: number | null;
}

export interface ModelVersions {
  active: string;
  versions: ModelVersionInfo[];
}

export interface ActivateModelResponse {
  model_version: string;
  previous_model_version: string;
  changed: boolean;
  load_s: number;
}

/* ---------- requests ---------- */

export type TrainBackend = "mlx_local" | "aws" | "modal";

export interface TrainRoundRequest {
  backend: TrainBackend;
}
export interface TrainRoundResponse {
  job_id: string;
}
