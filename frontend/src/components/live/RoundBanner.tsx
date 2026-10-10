"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { LastRound } from "@/lib/store";
import { fmtDelta, fmtInt, fmtPct } from "@/lib/format";
import { cx } from "@/components/ui";

export function RoundBanner({ round, onDismiss }: { round: LastRound | null; onDismiss: () => void }) {
  const reduce = useReducedMotion();
  return (
    <div className="pointer-events-none fixed inset-x-0 top-24 z-40 flex justify-center px-4">
      <AnimatePresence>
        {round ? <BannerCard key={round.at} round={round} onDismiss={onDismiss} reduce={!!reduce} /> : null}
      </AnimatePresence>
    </div>
  );
}

function BannerCard({
  round: lr,
  onDismiss,
  reduce,
}: {
  round: LastRound;
  onDismiss: () => void;
  reduce: boolean;
}) {
  const promoted = lr.round.promoted;
  const deltaPts = lr.delta * 100;
  const changed = Math.abs(deltaPts) >= 0.05;
  return (
    <motion.div
      role="status"
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: -28, scale: 0.97 }}
      animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, y: -20 }}
      transition={{ duration: 0.4, ease: "easeOut" }}
      className={cx(
        "pointer-events-auto relative w-full max-w-3xl rounded-2xl border-2 px-6 py-5 shadow-2xl shadow-black/60 sm:px-8 sm:py-6",
        promoted ? "border-good bg-surface-2" : "border-spot bg-surface-2",
      )}
    >
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="absolute right-3 top-3 grid size-12 place-items-center rounded-lg text-2xl text-ink-2 hover:bg-surface-3 hover:text-ink"
      >
        <span aria-hidden>×</span>
      </button>

      <p className={cx("text-base font-semibold uppercase tracking-wider", promoted ? "text-good" : "text-spot")}>
        {promoted ? `Training round ${lr.round.round} complete` : `Training round ${lr.round.round} rejected`}
      </p>
      <h2 className="display mt-1 pr-12 text-[clamp(1.75rem,1.2rem+2vw,2.75rem)] font-semibold leading-tight text-ink">
        {promoted
          ? `New model ${lr.round.model_version} live`
          : `${lr.round.model_version} — blocked by the evaluation gate`}
      </h2>

      {promoted ? (
        <div className="mt-4 flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <span className="text-lg text-ink-2">Handled locally</span>
          <span className="num text-3xl font-semibold text-ink-2">{fmtPct(lr.localShareBefore, 1)}</span>
          <span aria-hidden className="text-2xl text-ink-3">
            →
          </span>
          <span className="num text-4xl font-semibold text-ink">{fmtPct(lr.localShareAfter, 1)}</span>
          {changed ? (
            <span className={cx("num text-2xl font-semibold", deltaPts >= 0 ? "text-good" : "text-bad")}>
              {fmtDelta(deltaPts)}
            </span>
          ) : null}
        </div>
      ) : (
        <div className="mt-3 space-y-1">
          {lr.round.reason ? <p className="text-xl text-ink">{lr.round.reason}</p> : null}
          <p className="text-lg text-ink-2">
            Still serving <span className="font-mono font-semibold text-ink">{lr.previousVersion}</span>
            {" · "}handled locally stays at <span className="num font-semibold text-ink">{fmtPct(lr.localShareBefore, 1)}</span>
          </p>
        </div>
      )}

      <p className="mt-3 text-lg text-ink-3">
        Trained on <span className="num font-semibold text-ink-2">{fmtInt(lr.round.examples)}</span> teacher examples
        {promoted ? (
          <>
            {" · "}replaced <span className="font-mono text-ink-2">{lr.previousVersion}</span>
          </>
        ) : null}
      </p>
    </motion.div>
  );
}
