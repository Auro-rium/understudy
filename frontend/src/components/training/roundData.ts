import type { EvalCompare, LossPoint, Round, RoundEval } from "@/lib/types";

/** What a round is compared against: the latest earlier promoted round, else the base model's eval row. */
export interface Baseline {
  label: string;
  eval: RoundEval;
}

export function baselineFor(round: Round, rounds: Round[], ec: EvalCompare | null): Baseline | null {
  const prev = rounds
    .filter((x) => x.promoted && x.round < round.round)
    .sort((a, b) => b.round - a.round)[0];
  if (prev) return { label: `round ${prev.round}`, eval: prev.eval };
  const versions = new Set(rounds.map((r) => r.model_version));
  const base =
    ec?.models.find((m) => m.name === "base") ??
    ec?.models.find((m) => !versions.has(m.name) && !/teacher/i.test(m.name));
  if (!base) return null;
  return {
    label: base.name === "base" ? "the base model" : base.name,
    eval: {
      category_acc: base.category_acc,
      category_macro_f1: base.category_macro_f1,
      priority_acc: base.priority_acc,
    },
  };
}

/** Seconds -> "2.7 min" (under a minute stays in seconds). */
export function fmtMinutes(seconds: number): string {
  if (!Number.isFinite(seconds)) return "–";
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const m = seconds / 60;
  return `${m < 10 ? m.toFixed(1) : Math.round(m)} min`;
}

/** First/last/lowest loss of a recorded series; null when nothing was recorded. */
export function lossStats(points: LossPoint[]): { first: LossPoint; last: LossPoint; min: LossPoint } | null {
  if (points.length === 0) return null;
  let min = points[0];
  for (const p of points) if (p.loss < min.loss) min = p;
  return { first: points[0], last: points[points.length - 1], min };
}

/** One shared y-axis ceiling so the loss charts of different rounds are comparable. */
export function sharedLossMax(rounds: Round[]): number | undefined {
  let max = 0;
  for (const r of rounds) for (const p of r.loss) if (p.loss > max) max = p.loss;
  return max > 0 ? Math.ceil(max * 2) / 2 : undefined;
}

export function trainedOnThisMac(hardware: string): boolean {
  return /darwin|apple|macos|\bmac\b/i.test(hardware);
}
