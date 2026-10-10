import type { EvalCompare, EvalModel, Round } from "@/lib/types";
import { fmtDelta, fmtMs, fmtPct, fmtUsd } from "@/lib/format";

/**
 * Model identity for the /results page. Everything is derived from the names the
 * API sends (base, round_1, round_2 ...), so a growing list needs no code change.
 *
 * Colour follows the entity, never its rank or its outcome:
 *  - base = the app's neutral text-3 grey-blue (a deliberate neutral baseline)
 *  - round_N = a fixed one-hue blue ordinal ramp indexed by round order (earlier
 *    lighter, later darker). The 4 stops pass the dataviz validator's --ordinal
 *    gate on the dark surface (#12151f). Whether a round was promoted or rejected
 *    is always stated in text, never carried by colour.
 */

export type ModelKind = "base" | "round";

/**
 * current   = the model in use now (latest promoted round, or the base when nothing is promoted)
 * superseded= promoted earlier, replaced by a later promoted round
 * rejected  = trained and evaluated but not promoted
 * trained   = a trained model with no round record to say what happened to it
 * start     = the starting model, not the one in use
 */
export type ModelStatus = "current" | "superseded" | "rejected" | "trained" | "start";

export interface ModelRow {
  model: EvalModel;
  kind: ModelKind;
  status: ModelStatus;
  /** True for the single model currently in use. */
  isCurrent: boolean;
  color: string;
  /** "Base", "Round 3": display name derived from the data key. */
  label: string;
  /** Short status text, always shown next to colour: "Current model", "Not promoted" ... */
  tag: string;
  /** One line under the name. */
  role: string;
  /** The backend's own reason for promoting / not promoting (rounds only). */
  reason: string;
  round?: Round;
}

export const COLOR_BASE = "#8d92a8";
const ROUND_COLORS = ["#9ec5f4", "#6da7ec", "#3987e5", "#256abf"];

/** Fixed colour per round position; past the ramp the darkest step is reused (rare, and the legend text still identifies it). */
function roundColor(index: number): string {
  return ROUND_COLORS[Math.min(index, ROUND_COLORS.length - 1)];
}

const ROUND_RE = /^round_(\d+)$/i;

export function modelLabel(name: string): string {
  if (/^base$/i.test(name)) return "Base";
  const m = ROUND_RE.exec(name);
  if (m) return `Round ${Number(m[1])}`;
  return name;
}

function roundNumber(name: string): number | null {
  const m = ROUND_RE.exec(name);
  return m ? Number(m[1]) : null;
}

function isBase(name: string): boolean {
  return /^base$/i.test(name);
}

function findRound(rounds: Round[], name: string): Round | undefined {
  const n = roundNumber(name);
  return rounds.find((r) => r.model_version === name || (n !== null && r.round === n));
}

/**
 * Table / chart order: base first, then trained rounds by round number (names that are not
 * "round_N" keep API order after those). Only models present in eval_compare.models become rows.
 */
export function buildRows(ec: EvalCompare, rounds: Round[], healthVersion = ""): ModelRow[] {
  const ordered = [...ec.models];
  const key = (m: EvalModel) => {
    if (isBase(m.name)) return -1;
    const n = roundNumber(m.name);
    return n === null ? Number.MAX_SAFE_INTEGER : n;
  };
  const idx = new Map(ordered.map((m, i) => [m.name, i] as const));
  ordered.sort((a, b) => key(a) - key(b) || (idx.get(a.name) ?? 0) - (idx.get(b.name) ?? 0));

  // The model in use: the latest promoted round; otherwise the health version if it is a listed
  // model; otherwise the base.
  let currentName = "";
  const promoted = rounds.filter((r) => r.promoted).sort((a, b) => b.round - a.round);
  for (const r of promoted) {
    const hit = ordered.find((m) => m.name === r.model_version || m.name === `round_${r.round}`);
    if (hit) {
      currentName = hit.name;
      break;
    }
  }
  if (!currentName && healthVersion && ordered.some((m) => m.name === healthVersion)) currentName = healthVersion;
  if (!currentName) currentName = ordered.find((m) => isBase(m.name))?.name ?? "";

  let ri = 0;
  return ordered.map((model): ModelRow => {
    const isCurrent = model.name === currentName;
    const label = modelLabel(model.name);
    if (isBase(model.name)) {
      return {
        model,
        kind: "base",
        status: isCurrent ? "current" : "start",
        isCurrent,
        color: COLOR_BASE,
        label,
        tag: isCurrent ? "Current model" : "Starting point",
        role: "Starting model, before any training",
        reason: "",
      };
    }
    const round = findRound(rounds, model.name);
    const color = roundColor(ri++);
    let status: ModelStatus = "trained";
    let tag = "Trained";
    if (isCurrent) {
      status = "current";
      tag = "Current model";
    } else if (round && round.promoted) {
      status = "superseded";
      tag = "Promoted, replaced";
    } else if (round && !round.promoted) {
      status = "rejected";
      tag = "Not promoted";
    }
    const role = round
      ? `${round.examples > 0 ? `Trained on ${round.examples.toLocaleString("en-US")} examples` : "Fine-tuned local model"}`
      : "Fine-tuned local model";
    return { model, kind: "round", status, isCurrent, color, label, tag, role, reason: round?.reason ?? "", round };
  });
}

/** Test-set size from a confusion matrix (sum of all cells); null when the data has none. */
export function testSetSize(ec: EvalCompare): number | null {
  for (const m of Object.values(ec.confusion)) {
    const total = m.reduce((a, r) => a + r.reduce((x, y) => x + y, 0), 0);
    if (total > 0) return total;
  }
  return null;
}

export type MetricKey =
  | "category_acc"
  | "category_macro_f1"
  | "priority_acc"
  | "latency_ms"
  | "cost_per_1k";

export interface MetricDef {
  key: MetricKey;
  label: string;
  /** Short column header. */
  head: string;
  higherBetter: boolean;
  format: (v: number) => string;
  /** Compact tick format for axes. */
  tick: (v: number) => string;
  isPct: boolean;
  /** Signed change text vs a reference value, or null when there is no change. */
  delta: (v: number, ref: number) => string | null;
}

function signedMs(d: number): string {
  const sign = d > 0 ? "+" : "−";
  return `${sign}${fmtMs(Math.abs(d))}`;
}

function pctDelta(v: number, ref: number): string | null {
  const pts = (v - ref) * 100;
  return Math.abs(pts) < 0.05 ? null : fmtDelta(pts);
}

export const METRICS: MetricDef[] = [
  {
    key: "category_acc",
    label: "Category accuracy",
    head: "Category accuracy",
    higherBetter: true,
    format: (v) => fmtPct(v, 1),
    tick: (v) => fmtPct(v, 0),
    isPct: true,
    delta: pctDelta,
  },
  {
    key: "category_macro_f1",
    label: "Macro-F1",
    head: "Macro-F1",
    higherBetter: true,
    format: (v) => fmtPct(v, 1),
    tick: (v) => fmtPct(v, 0),
    isPct: true,
    delta: pctDelta,
  },
  {
    key: "priority_acc",
    label: "Priority accuracy",
    head: "Priority accuracy",
    higherBetter: true,
    format: (v) => fmtPct(v, 1),
    tick: (v) => fmtPct(v, 0),
    isPct: true,
    delta: pctDelta,
  },
  {
    key: "latency_ms",
    label: "Latency",
    head: "Latency",
    higherBetter: false,
    format: fmtMs,
    tick: fmtMs,
    isPct: false,
    delta: (v, ref) => (Math.abs(v - ref) < 0.5 ? null : signedMs(v - ref)),
  },
  {
    key: "cost_per_1k",
    label: "Cost per 1,000",
    head: "Cost per 1,000 tickets",
    higherBetter: false,
    format: fmtUsd,
    tick: fmtUsd,
    isPct: false,
    delta: (v, ref) => (Math.abs(v - ref) < 0.00005 ? null : `${v > ref ? "+" : "−"}${fmtUsd(Math.abs(v - ref))}`),
  },
];

/** Whether a change in this metric is an improvement (true), a regression (false) or neutral (null). */
export function isImprovement(metric: MetricDef, v: number, ref: number): boolean | null {
  if (v === ref) return null;
  return metric.higherBetter ? v > ref : v < ref;
}

/** Names of the rows holding the best value of a metric. Empty when every row ties (nothing to rank). */
export function bestNames(rows: ModelRow[], metric: MetricDef): Set<string> {
  const vals = rows.map((r) => r.model[metric.key]).filter((v) => Number.isFinite(v));
  if (vals.length < 2) return new Set();
  const best = metric.higherBetter ? Math.max(...vals) : Math.min(...vals);
  const worst = metric.higherBetter ? Math.min(...vals) : Math.max(...vals);
  if (best === worst) return new Set();
  return new Set(rows.filter((r) => r.model[metric.key] === best).map((r) => r.model.name));
}

export function baseRow(rows: ModelRow[]): ModelRow | undefined {
  return rows.find((r) => r.kind === "base");
}

export function currentRow(rows: ModelRow[]): ModelRow | undefined {
  return rows.find((r) => r.isCurrent);
}
