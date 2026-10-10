"use client";

import { motion, useReducedMotion } from "motion/react";
import { useMemo } from "react";
import { useStore } from "@/lib/store";
import { clamp, fmtDelta, fmtPct } from "@/lib/format";
import { AnimatedNumber, Card, EmptyState, ProvisionalBadge, cx } from "@/components/ui";
import type { Round } from "@/lib/types";

interface Row {
  name: string;
  f1: number;
  round: Round | null;
}

type Status = "serving" | "promoted" | "rejected" | "baseline";

const STATUS_TEXT: Record<Status, string> = {
  serving: "Serving now",
  promoted: "Promoted",
  rejected: "Not promoted",
  baseline: "Baseline",
};

const STATUS_CLASS: Record<Status, string> = {
  serving: "text-local",
  promoted: "text-ink-2",
  rejected: "text-spot",
  baseline: "text-ink-3",
};

/** Hatched fill = rejected, so the state never rests on colour alone. */
const HATCH =
  "repeating-linear-gradient(135deg, var(--text-3) 0 2px, transparent 2px 7px)";

function Bar({ value, status }: { value: number; status: Status }) {
  const reduce = useReducedMotion();
  const w = `${clamp(value, 0, 1) * 100}%`;
  return (
    <div className="relative h-4 overflow-hidden rounded-full bg-surface-3">
      <motion.div
        className={cx(
          "absolute inset-y-0 left-0 rounded-full",
          status === "serving" && "bg-local",
          status === "baseline" && "bg-ink-3",
          status === "rejected" && "border border-dashed border-ink-3",
        )}
        style={
          status === "rejected"
            ? { backgroundImage: HATCH, opacity: 0.8 }
            : status === "promoted"
              ? { backgroundColor: "var(--seq-550)" }
              : undefined
        }
        initial={reduce ? { width: w } : { width: 0 }}
        animate={{ width: w }}
        transition={{ duration: reduce ? 0 : 0.8, ease: [0.16, 1, 0.3, 1] }}
      />
    </div>
  );
}

/**
 * Real per-model macro-F1 from the backend's test-set evaluation. This is the part of
 * /live that has data even when no traffic has been recorded.
 */
export function ModelProgress({ className }: { className?: string }) {
  const { state } = useStore();
  const ec = state.evalCompare;

  const rows = useMemo<Row[]>(() => {
    const byVersion = new Map(state.rounds.map((r) => [r.model_version, r]));
    if (ec && ec.models.length > 0) {
      return ec.models
        .filter((m) => Number.isFinite(m.category_macro_f1))
        .map((m) => ({ name: m.name, f1: m.category_macro_f1, round: byVersion.get(m.name) ?? null }));
    }
    return state.rounds
      .filter((r) => Number.isFinite(r.eval?.category_macro_f1))
      .map((r) => ({ name: r.model_version, f1: r.eval.category_macro_f1, round: r }));
  }, [ec, state.rounds]);

  const statusOf = (r: Row): Status => {
    if (r.name === state.modelVersion) return "serving";
    if (!r.round) return "baseline";
    return r.round.promoted ? "promoted" : "rejected";
  };

  const base = rows.find((r) => !r.round);
  const serving = rows.find((r) => r.name === state.modelVersion);
  const gain =
    base && serving && serving !== base ? (serving.f1 - base.f1) * 100 : null;

  return (
    <Card
      title="Model progress"
      className={className}
      action={ec?.provisional ? <ProvisionalBadge /> : null}
    >
      <p className="-mt-2 mb-4 text-base text-ink-3">
        Category macro-F1 on the test set, per training round. Scored against teacher-derived labels.
      </p>
      {rows.length === 0 ? (
        <EmptyState title="No evaluation recorded yet" hint="Scores appear here after the first training round." />
      ) : (
        <>
          <ul className="space-y-4" aria-label="Macro-F1 by model">
            {rows.map((r) => {
              const status = statusOf(r);
              return (
                <li key={r.name}>
                  <div className="grid grid-cols-[6.5rem_minmax(0,1fr)_4.5rem] items-center gap-x-3">
                    <span className="truncate font-mono text-lg text-ink">{r.name}</span>
                    <Bar value={r.f1} status={status} />
                    <span className="num text-right text-xl font-semibold text-ink">
                      <AnimatedNumber value={r.f1} format={(n) => fmtPct(n, 1)} durationMs={800} />
                    </span>
                  </div>
                  <p className="mt-1 pl-0 text-base text-ink-3 sm:pl-[7.25rem]">
                    <span className={cx("font-medium", STATUS_CLASS[status])}>{STATUS_TEXT[status]}</span>
                    {r.round?.reason ? <span>{` · ${r.round.reason}`}</span> : null}
                  </p>
                </li>
              );
            })}
          </ul>
          {gain !== null && Number.isFinite(gain) ? (
            <p className="mt-4 border-t border-line pt-3 text-lg text-ink-2">
              <span className="font-mono text-ink">{serving?.name}</span> scores{" "}
              <span className={cx("num font-semibold", gain >= 0 ? "text-good" : "text-bad")}>{fmtDelta(gain)}</span>{" "}
              macro-F1 against <span className="font-mono text-ink">{base?.name}</span>.
            </p>
          ) : null}
        </>
      )}
    </Card>
  );
}
