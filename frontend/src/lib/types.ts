/**
 * Single source of truth for every API payload.
 * These mirror the FastAPI contract exactly; pages never see "mock vs real".
 */

export type Mode = "online" | "offline";
export type Source = "local" | "teacher" | "review";

export interface Health {
  status: string;
  model_version: string;
  mode: Mode;
}

export interface ClassifyResult {
  id: string;
  category: number;
  category_name: string;
  priority: string; // "low" | "medium" | "high" | "urgent"
  team: string;
  source: Source;
  confidence: number; // 0..1
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
  id: string;
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
  models: EvalModel[];
  router: EvalModel;
  /** model name -> category name -> F1 */
  per_category_f1: Record<string, Record<string, number>>;
  /** model name -> square matrix, rows = true category, cols = predicted (order = category order in per_category_f1) */
  confusion: Record<string, number[][]>;
}

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
}

export interface RoundComplete {
  job_id: string;
  round: Round;
  /** version being served before this round finished */
  previous_model_version: string;
}

export type ServerEvent =
  | { type: "prediction"; data: Ticket }
  | { type: "train_progress"; data: TrainProgress }
  | { type: "round_complete"; data: RoundComplete }
  | { type: "mode"; data: { mode: Mode } };

/* ---------- requests ---------- */

export interface TrainRoundRequest {
  backend: string; // e.g. "mlx" | "cloud"
}
export interface TrainRoundResponse {
  job_id: string;
}
