"use client";

import { useMemo } from "react";
import Link from "next/link";
import { motion, useReducedMotion } from "motion/react";
import { useStore } from "@/lib/store";
import { fmtInt, fmtPct, fmtUsd } from "@/lib/format";
import { AnimatedNumber, EmptyState, Skeleton, StatTile } from "@/components/ui";
import { Ladder } from "./Ladder";
import { Lineup } from "./Lineup";

/** Display-only: drop the OS prefix from the recorded hardware string ("Darwin arm64 Apple M5 16GB"). */
function hardwareLabel(h: string): string {
  return h.replace(/^Darwin arm64\s+/, "");
}

/**
 * The hero is the headline plus the evidence: how the model got better round by round
 * (macro-F1 on the test set, from the real evaluation), and three numbers computed from
 * the rounds. Live-traffic numbers only appear once tickets have actually been handled.
 */
export function Hero() {
  const { state } = useStore();
  const reduce = useReducedMotion();
  const s = state.summary;

  const rise = (delay: number) =>
    reduce
      ? {}
      : {
          initial: { opacity: 0, y: 14 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.6, delay, ease: [0.16, 1, 0.3, 1] as const },
        };

  const facts = useMemo(() => {
    const ec = state.evalCompare;
    const rounds = state.rounds;
    if (!ec || rounds.length === 0) return null;
    const base = ec.models.find((m) => m.name === "base");
    const promoted = rounds.filter((r) => r.promoted);
    const best = promoted.length ? promoted[promoted.length - 1] : null;
    const rejected = rounds.filter((r) => !r.promoted);
    const trainCost = rounds.reduce((sum, r) => sum + r.cost_usd, 0);
    const hardware = new Set(rounds.map((r) => r.hardware).filter(Boolean));
    return {
      baseF1: base?.category_macro_f1 ?? null,
      best,
      promotedCount: promoted.length,
      rejected,
      total: rounds.length,
      trainCost,
      hardware: hardware.size === 1 ? hardwareLabel([...hardware][0]) : null,
      provisional: ec.provisional,
    };
  }, [state.evalCompare, state.rounds]);

  const hasLive = state.loaded && s !== null && s.total > 0;
  const hasTickets = state.tickets.length > 0;

  return (
    <section className="stage-glow border-b border-line">
      <div className="mx-auto max-w-[120rem] px-4 pb-12 pt-12 sm:px-8 sm:pb-16 sm:pt-16 lg:pt-20">
        <motion.h1
          {...rise(0)}
          className="display max-w-[22ch] text-[clamp(2.5rem,1.2rem+4.6vw,5.75rem)] font-semibold leading-[1.02] text-ink"
        >
          A local model that learns from a teacher, and gradually needs it less.
        </motion.h1>

        <motion.div {...rise(0.12)} className="mt-6 flex flex-wrap items-center gap-x-8 gap-y-4">
          <p className="max-w-2xl text-xl text-ink-2">
            Gig workers send support tickets in plain English. A small model on this machine routes them. It
            asks a larger cloud model only when it is unsure, and keeps what it learns.
          </p>
          <div className="flex items-center gap-5">
            <Link
              href="/live"
              className="rounded-md bg-spot px-5 py-2.5 text-lg font-semibold text-bg transition-opacity hover:opacity-90"
            >
              Start the demo
            </Link>
            <Link href="/results" className="text-lg text-ink-2 underline decoration-line-strong underline-offset-4 hover:text-ink">
              Jump to results
            </Link>
          </div>
        </motion.div>

        <motion.div {...rise(0.24)} className="mt-12">
          {!state.loaded ? (
            <Skeleton className="h-56" />
          ) : facts ? (
            <>
              <h2 className="display mb-5 max-w-[34ch] text-[clamp(1.5rem,1.1rem+1.4vw,2.25rem)] font-semibold leading-[1.15] text-ink">
                What the training rounds have done so far
              </h2>
              <Ladder />
            </>
          ) : (
            <EmptyState
              title="No evaluation results yet"
              hint="The backend is not reachable and there is no saved snapshot with training rounds."
            />
          )}
        </motion.div>

        {facts ? (
          <motion.div {...rise(0.36)} className="mt-12 grid gap-x-10 gap-y-9 sm:grid-cols-3">
            {facts.best ? (
              <StatTile
                label="Macro-F1 of the promoted model"
                accent="local"
                value={<AnimatedNumber value={facts.best.eval.category_macro_f1} format={(n) => n.toFixed(3)} />}
                sub={
                  facts.baseF1 !== null
                    ? `${facts.best.model_version.replace("_", " ")}, up from ${facts.baseF1.toFixed(3)} for the base model${facts.provisional ? " (provisional)" : ""}`
                    : `${facts.best.model_version.replace("_", " ")}${facts.provisional ? " (provisional)" : ""}`
                }
              />
            ) : (
              <StatTile
                label="Promoted models"
                value={<AnimatedNumber value={0} format={fmtInt} />}
                sub="No round has beaten the base model yet"
              />
            )}
            <StatTile
              label="Rounds promoted"
              accent="spot"
              value={
                <>
                  <AnimatedNumber value={facts.promotedCount} format={fmtInt} />
                  <span className="text-ink-3"> of {fmtInt(facts.total)}</span>
                </>
              }
              sub={
                facts.rejected.length > 0
                  ? `${facts.rejected.map((r) => r.model_version.replace("_", " ")).join(", ")} scored lower and was rejected by the promotion gate`
                  : "Every round beat the model before it"
              }
            />
            <StatTile
              label="Cost of training the rounds"
              accent="save"
              value={<AnimatedNumber value={facts.trainCost} format={fmtUsd} />}
              sub={facts.hardware ? `Trained locally on ${facts.hardware}` : "Trained locally"}
            />
          </motion.div>
        ) : null}

        {state.loaded ? (
          <motion.div {...rise(0.48)} className="mt-14">
            {hasLive && s ? (
              <>
                <h2 className="display mb-5 text-[clamp(1.5rem,1.1rem+1.4vw,2.25rem)] font-semibold leading-[1.15] text-ink">
                  Live traffic
                </h2>
                {hasTickets ? (
                  <div className="mb-10">
                    <Lineup />
                  </div>
                ) : null}
                <div className="grid gap-x-10 gap-y-9 sm:grid-cols-3">
                  <StatTile
                    label="Handled on this machine"
                    accent="local"
                    value={<AnimatedNumber value={s.local_share} format={(n) => fmtPct(n, 0)} />}
                    sub={`of ${fmtInt(s.total)} tickets, no internet needed`}
                  />
                  <StatTile
                    label="Paid to the cloud teacher"
                    accent="teacher"
                    value={<AnimatedNumber value={s.cost_usd_total} format={fmtUsd} />}
                    sub="cloud cost so far"
                  />
                  <StatTile
                    label="Cost avoided"
                    accent="save"
                    value={<AnimatedNumber value={s.cost_avoided_usd} format={fmtUsd} />}
                    sub="compared with sending every ticket to the cloud"
                  />
                </div>
              </>
            ) : (
              <p className="max-w-3xl border-l-2 border-line-strong pl-5 text-lg text-ink-2">
                <strong className="font-semibold text-ink">No live tickets have been recorded yet.</strong> The share
                handled locally and the cloud cost appear here once the backend is running and tickets flow through
                it. Until then, the numbers above are the only results we claim.
              </p>
            )}
          </motion.div>
        ) : null}
      </div>
    </section>
  );
}
