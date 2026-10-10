"use client";

import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { AnimatedNumber, EmptyState, ProgressBar, Skeleton, VersionChip, cx } from "@/components/ui";
import { fmtDelta, fmtDuration, fmtInt, fmtPct, fmtUsd } from "@/lib/format";
import { useStore } from "@/lib/store";
import type { Round, RoundEval, TrainProgress, TrainStage } from "@/lib/types";
import { LossChart } from "./LossChart";
import { useLiveLoss } from "./useLiveLoss";

/* ---------- small pieces ---------- */

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-base text-ink-3">{label}</dt>
      <dd className="num mt-0.5 text-xl font-medium text-ink">{children}</dd>
    </div>
  );
}

function StatusChip({ promoted }: { promoted: boolean }) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-base font-semibold",
        promoted ? "border-good/50 text-good" : "border-spot/60 text-spot",
      )}
    >
      <span aria-hidden className={cx("size-2.5 rounded-full", promoted ? "bg-good" : "bg-spot")} />
      {promoted ? "Promoted" : "Not promoted"}
    </span>
  );
}

type EvalKey = keyof RoundEval;
const EVAL_ROWS: Array<{ key: EvalKey; label: string }> = [
  { key: "category_acc", label: "Category accuracy" },
  { key: "category_macro_f1", label: "Category macro-F1" },
  { key: "priority_acc", label: "Priority accuracy" },
];

function EvalTriplet({ evalNow, base }: { evalNow: RoundEval; base: Round | null }) {
  return (
    <div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {EVAL_ROWS.map(({ key, label }) => {
          const delta = base ? (evalNow[key] - base.eval[key]) * 100 : null;
          const rounded = delta === null ? null : Math.round(delta * 10) / 10;
          return (
            <div key={key} className="rounded-md border border-line bg-surface-2 px-3 py-2.5">
              <p className="text-base text-ink-3">{label}</p>
              <p className="num text-3xl font-semibold text-ink">{fmtPct(evalNow[key], 1)}</p>
              <p
                className={cx(
                  "num text-base",
                  rounded === null || rounded === 0 ? "text-ink-3" : rounded > 0 ? "text-good" : "text-bad",
                )}
              >
                {rounded === null ? "no earlier round" : fmtDelta(rounded)}
              </p>
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-base text-ink-3">
        {base
          ? `Change compared with round ${base.round} (${base.model_version}), the latest earlier promoted round. Scored on held-out, human-labelled tickets.`
          : "Scored on held-out, human-labelled tickets. No earlier promoted round to compare with."}
      </p>
    </div>
  );
}

/* ---------- finished round ---------- */

function RoundCard({ round, base }: { round: Round; base: Round | null }) {
  const rejected = !round.promoted;
  return (
    <article
      className={cx(
        "rounded-lg border bg-surface p-4 sm:p-6",
        rejected ? "border-spot/70 border-l-4" : "border-line",
      )}
    >
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h3 className="display text-3xl font-semibold text-ink">Round {round.round}</h3>
        <VersionChip version={round.model_version} className="text-base" />
        <StatusChip promoted={round.promoted} />
      </header>

      <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-8">
        <div className="space-y-5">
          <p
            className={cx(
              "rounded-md px-4 py-3 text-lg leading-relaxed",
              rejected ? "border border-spot/40 bg-spot/10 text-ink" : "bg-surface-2 text-ink-2",
            )}
          >
            <span className="font-semibold text-ink">{rejected ? "Why it was rejected: " : "Why it was promoted: "}</span>
            {round.reason}
          </p>

          <dl className="grid grid-cols-2 gap-x-6 gap-y-4">
            <Fact label="Examples used">
              <AnimatedNumber value={round.examples} format={fmtInt} />
            </Fact>
            <Fact label="Wall time">{fmtDuration(round.wall_time_s)}</Fact>
            <Fact label="Hardware">
              <span className="text-lg">{round.hardware}</span>
            </Fact>
            <Fact label="Training cost">{fmtUsd(round.cost_usd)}</Fact>
          </dl>

          <EvalTriplet evalNow={round.eval} base={base} />
        </div>

        <div>
          <h4 className="mb-2 text-lg font-medium text-ink-2">Training loss (lower is better)</h4>
          <LossChart data={round.loss} mode="draw" height={300} />
        </div>
      </div>
    </article>
  );
}

/* ---------- live round ---------- */

const STAGES: Array<{ id: TrainStage; label: string }> = [
  { id: "collect", label: "Collect" },
  { id: "train", label: "Train" },
  { id: "evaluate", label: "Evaluate" },
  { id: "promote", label: "Promote" },
];

function LiveRoundCard({ tp, points }: { tp: TrainProgress; points: { step: number; loss: number }[] }) {
  const reduce = useReducedMotion();
  const idx = STAGES.findIndex((s) => s.id === tp.stage);
  const latest = points.length ? points[points.length - 1] : null;
  return (
    <motion.article
      initial={reduce ? false : { opacity: 0, y: -12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
      className="rounded-lg border border-spot/70 bg-surface p-4 sm:p-6"
      aria-label={`Round ${tp.round} in progress`}
    >
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h3 className="display text-3xl font-semibold text-ink">Round {tp.round}</h3>
        <span className="inline-flex items-center gap-2 rounded-full border border-spot/60 px-3 py-1 text-base font-semibold text-spot">
          <span aria-hidden className="size-2.5 animate-pulse rounded-full bg-spot" />
          In progress
        </span>
      </header>

      <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-8">
        <div className="space-y-5">
          <ol className="flex flex-wrap gap-2" aria-label="Round stages">
            {STAGES.map((s, i) => (
              <li
                key={s.id}
                aria-current={i === idx ? "step" : undefined}
                className={cx(
                  "rounded-full border px-3.5 py-1 text-base font-medium",
                  i === idx
                    ? "border-spot bg-spot/15 text-spot"
                    : i < idx
                      ? "border-line-strong text-ink-2"
                      : "border-line text-ink-3",
                )}
              >
                {i < idx ? "Done: " : ""}
                {s.label}
              </li>
            ))}
          </ol>
          <ProgressBar value={tp.progress} label="Overall progress" fillClassName="bg-spot" />
          {tp.message ? <p className="text-lg text-ink-2">{tp.message}</p> : null}
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4">
            <Fact label="Step">
              {tp.step !== undefined && tp.total_steps !== undefined
                ? `${fmtInt(tp.step)} / ${fmtInt(tp.total_steps)}`
                : "–"}
            </Fact>
            <Fact label="Latest loss">{latest ? latest.loss.toFixed(3) : "–"}</Fact>
          </dl>
          <p className="text-base text-ink-3">
            Results, evaluation scores and the promote decision appear here when the round finishes.
          </p>
        </div>
        <div>
          <h4 className="mb-2 text-lg font-medium text-ink-2">Training loss, live</h4>
          <LossChart data={points} mode="live" xMax={tp.total_steps} height={300} />
        </div>
      </div>
    </motion.article>
  );
}

/* ---------- list ---------- */

export function RoundCards() {
  const { state } = useStore();
  const { rounds, trainProgress, loaded } = state;
  const points = useLiveLoss(trainProgress);

  const newestFirst = [...rounds].sort((a, b) => b.round - a.round);
  const baseFor = (r: Round): Round | null =>
    [...rounds]
      .filter((x) => x.promoted && x.round < r.round)
      .sort((a, b) => b.round - a.round)[0] ?? null;

  // while a round runs, its in-progress card stands in for any stale entry with the same number
  const shown = trainProgress ? newestFirst.filter((r) => r.round !== trainProgress.round) : newestFirst;

  return (
    <div className="space-y-6">
      {trainProgress ? <LiveRoundCard tp={trainProgress} points={points} /> : null}
      {shown.map((r) => (
        <RoundCard key={r.round} round={r} base={baseFor(r)} />
      ))}
      {!loaded ? <Skeleton className="h-72" /> : null}
      {loaded && rounds.length === 0 && !trainProgress ? (
        <EmptyState
          title="No training rounds yet — run one to see the loss curve"
          hint="Use “Run training round” above. Each round appears here with its result, cost and reason."
        />
      ) : null}
    </div>
  );
}
