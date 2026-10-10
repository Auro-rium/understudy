import type { EvalCompare, EvalModel } from "@/lib/types";
import { fmtMs, fmtPct, fmtUsd } from "@/lib/format";

/**
 * Model identity for the /results page. Everything is derived from the names
 * the API sends, so a growing list (v3, v4 ...) needs no code change.
 *
 * Colours: base = neutral grey-blue (the app's text-3), trained versions = a
 * one-hue blue ordinal ramp (older lighter -> newest darker; the 4 stops pass
 * the dataviz validator's --ordinal gate on the dark surface), teacher = the
 * app's teacher orange, router = the app's spot yellow (the headline).
 */

export type ModelKind = "base" | "trained" | "teacher" | "router";

export interface ModelRow {
  model: EvalModel;
  kind: ModelKind;
  color: string;
  /** Short role description shown under the name. */
  role: string;
}

export const COLOR_BASE = "#8d92a8";
export const COLOR_TEACHER = "#d95926";
export const COLOR_ROUTER = "#f2c14e";

const BLUE_STOPS = ["#9ec5f4", "#6da7ec", "#3987e5", "#256abf"];

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

/** Linear interpolation along a list of hex stops; t in 0..1. */
export function rampColor(stops: string[], t: number): string {
  const x = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const a = hexToRgb(stops[i]);
  const b = hexToRgb(stops[i + 1]);
  return rgbToHex([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]);
}

function trainedColor(index: number, count: number): string {
  if (count <= 1) return BLUE_STOPS[2];
  return rampColor(BLUE_STOPS, index / (count - 1));
}

function classify(name: string): ModelKind {
  if (/teacher/i.test(name)) return "teacher";
  if (/base/i.test(name)) return "base";
  return "trained";
}

/** Table/chart order: base, trained versions (as sent), teacher, then the router last. */
export function buildRows(ec: EvalCompare): ModelRow[] {
  const kinds = ec.models.map((m) => classify(m.name));
  const trainedCount = kinds.filter((k) => k === "trained").length;
  let ti = 0;
  const rows: ModelRow[] = ec.models.map((model, i) => {
    const kind = kinds[i];
    if (kind === "base") return { model, kind, color: COLOR_BASE, role: "Local, before any training" };
    if (kind === "teacher") return { model, kind, color: COLOR_TEACHER, role: "Cloud model" };
    return {
      model,
      kind,
      color: trainedColor(ti++, trainedCount),
      role: "Local, fine-tuned",
    };
  });
  const order: Record<ModelKind, number> = { base: 0, trained: 1, teacher: 2, router: 3 };
  rows.sort((a, b) => order[a.kind] - order[b.kind]); // stable: trained keep API order
  if (ec.router) {
    rows.push({ model: ec.router, kind: "router", color: COLOR_ROUTER, role: "Local first, asks the teacher when unsure" });
  }
  return rows;
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
  },
  {
    key: "category_macro_f1",
    label: "Macro-F1",
    head: "Macro-F1",
    higherBetter: true,
    format: (v) => fmtPct(v, 1),
    tick: (v) => fmtPct(v, 0),
    isPct: true,
  },
  {
    key: "priority_acc",
    label: "Priority accuracy",
    head: "Priority accuracy",
    higherBetter: true,
    format: (v) => fmtPct(v, 1),
    tick: (v) => fmtPct(v, 0),
    isPct: true,
  },
  {
    key: "latency_ms",
    label: "Latency",
    head: "Latency",
    higherBetter: false,
    format: fmtMs,
    tick: fmtMs,
    isPct: false,
  },
  {
    key: "cost_per_1k",
    label: "Cost per 1,000",
    head: "Cost per 1,000 tickets",
    higherBetter: false,
    format: fmtUsd,
    tick: fmtUsd,
    isPct: false,
  },
];

/** Names of the rows holding the best value of a metric (ties all included). */
export function bestNames(rows: ModelRow[], metric: MetricDef): Set<string> {
  const vals = rows.map((r) => r.model[metric.key]).filter((v) => Number.isFinite(v));
  if (vals.length === 0) return new Set();
  const best = metric.higherBetter ? Math.max(...vals) : Math.min(...vals);
  return new Set(rows.filter((r) => r.model[metric.key] === best).map((r) => r.model.name));
}

/** Latest trained row = last trained version in API order. */
export function latestTrained(rows: ModelRow[]): ModelRow | undefined {
  const t = rows.filter((r) => r.kind === "trained");
  return t[t.length - 1];
}
