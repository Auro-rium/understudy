"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useStore, type LastRound } from "@/lib/store";
import { fmtDelta, fmtInt, fmtPct } from "@/lib/format";
import { ProvisionalBadge, cx } from "@/components/ui";

export function RoundBanner({ round, onDismiss }: { round: LastRound | null; onDismiss: () => void }) {
  const reduce = useReducedMotion();
  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-40 sm:top-28 flex justify-center px-4">
      <AnimatePresence>
        {round ? <BannerCard key={round.at} round={round} onDismiss={onDismiss} reduce={!!reduce} /> : null}
      </AnimatePresence>
    </div>
  );
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

function BannerCard({
  round: lr,
  onDismiss,
  reduce,
}: {
  round: LastRound;
  onDismiss: () => void;
  reduce: boolean;
}) {
  const { state } = useStore();
  const r = lr.round;
  const promoted = !!r.promoted;
  const f1 = r.eval?.category_macro_f1;
  const acc = r.eval?.category_acc;
  // Local share before/after is a live measurement: it only means something once traffic exists.
  const deltaPts = lr.delta * 100;
  const showShare = promoted && (state.summary?.total ?? 0) > 0 && finite(deltaPts) && Math.abs(deltaPts) >= 0.05;
  const version = r.model_version || `round ${r.round}`;
  const previous = lr.previousVersion;

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

      <p className={cx("text-lg font-semibold", promoted ? "text-good" : "text-spot")}>
        {promoted ? `Training round ${r.round} complete` : `Training round ${r.round} not promoted`}
      </p>
      <h2 className="display mt-1 pr-12 text-[clamp(1.75rem,1.2rem+2vw,2.75rem)] font-semibold leading-tight text-ink">
        {promoted ? (
          <>
            <span className="font-mono">{version}</span> is now serving
          </>
        ) : (
          "Candidate blocked by the evaluation gate"
        )}
      </h2>

      {finite(f1) ? (
        <div className="mt-4 flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <span className="text-lg text-ink-2">Macro-F1</span>
          <span className="num text-4xl font-semibold text-ink">{fmtPct(f1, 1)}</span>
          {finite(acc) ? <span className="num text-lg text-ink-2">category accuracy {fmtPct(acc, 1)}</span> : null}
          <ProvisionalBadge />
        </div>
      ) : null}

      {r.reason ? <p className="mt-2 text-xl text-ink">{r.reason}</p> : null}

      {showShare ? (
        <div className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <span className="text-lg text-ink-2">Handled locally</span>
          <span className="num text-2xl font-semibold text-ink-2">{fmtPct(lr.localShareBefore, 1)}</span>
          <span aria-hidden className="text-xl text-ink-3">
            →
          </span>
          <span className="num text-3xl font-semibold text-ink">{fmtPct(lr.localShareAfter, 1)}</span>
          <span className={cx("num text-xl font-semibold", deltaPts >= 0 ? "text-good" : "text-bad")}>
            {fmtDelta(deltaPts)}
          </span>
        </div>
      ) : null}

      <p className="mt-3 text-lg text-ink-3">
        {finite(r.examples) && r.examples > 0 ? (
          <>
            Trained on <span className="num font-semibold text-ink-2">{fmtInt(r.examples)}</span> teacher examples
          </>
        ) : (
          "Test-set evaluation"
        )}
        {promoted && previous && previous !== r.model_version ? (
          <>
            {" · "}replaced <span className="font-mono text-ink-2">{previous}</span>
          </>
        ) : null}
        {!promoted && previous ? (
          <>
            {" · "}still serving <span className="font-mono text-ink-2">{previous}</span>
          </>
        ) : null}
      </p>
    </motion.div>
  );
}
