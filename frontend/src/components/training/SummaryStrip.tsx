"use client";

import type { ReactNode } from "react";
import { AnimatedNumber } from "@/components/ui";
import { fmtInt, fmtPct, fmtUsd } from "@/lib/format";
import { useStore } from "@/lib/store";
import { fmtMinutes, trainedOnThisMac } from "./roundData";

function Figure({ label, value, sub, accent }: { label: string; value: ReactNode; sub?: ReactNode; accent?: string }) {
  return (
    <div className="relative pl-5">
      <span aria-hidden className={`absolute bottom-1 left-0 top-1 w-1 rounded-full ${accent ?? "bg-line-strong"}`} />
      <p className="text-lg text-ink-2">{label}</p>
      <p className="num display text-4xl font-semibold leading-tight text-ink min-[480px]:text-5xl sm:text-6xl">{value}</p>
      {sub ? <p className="mt-1 text-lg text-ink-3">{sub}</p> : null}
    </div>
  );
}

/** Everything here is computed from state.rounds (and the eval's provisional flag) and nothing else. */
export function SummaryStrip() {
  const { state } = useStore();
  const { rounds, evalCompare } = state;
  const promoted = rounds.filter((r) => r.promoted);
  const rejected = rounds.length - promoted.length;
  const latest = [...promoted].sort((a, b) => b.round - a.round)[0];
  const seconds = rounds.reduce((sum, r) => sum + r.wall_time_s, 0);
  const cost = rounds.reduce((sum, r) => sum + r.cost_usd, 0);
  const onMac = rounds.length > 0 && rounds.every((r) => trainedOnThisMac(r.hardware));

  return (
    <section aria-label="Training summary" className="grid grid-cols-[repeat(2,minmax(0,1fr))] gap-x-6 gap-y-8 lg:grid-cols-4">
      <Figure
        label="Rounds promoted"
        value={
          <>
            <AnimatedNumber value={promoted.length} format={fmtInt} />
            <span className="text-ink-3"> of </span>
            <AnimatedNumber value={rounds.length} format={fmtInt} />
          </>
        }
        sub={rejected > 0 ? `${fmtInt(rejected)} not promoted` : "none rejected"}
        accent="bg-good"
      />
      <Figure
        label="Latest promoted macro-F1"
        value={latest ? <AnimatedNumber value={latest.eval.category_macro_f1} format={(n) => fmtPct(n, 1)} /> : "–"}
        sub={
          latest
            ? `${latest.model_version}${evalCompare?.provisional ? ", provisional score" : ""}`
            : "no promoted round yet"
        }
        accent="bg-local"
      />
      <Figure
        label="Total training time"
        value={<AnimatedNumber value={seconds} format={fmtMinutes} />}
        sub={`across ${fmtInt(rounds.length)} ${rounds.length === 1 ? "round" : "rounds"}`}
        accent="bg-teacher"
      />
      <Figure
        label="Total training cost"
        value={<AnimatedNumber value={cost} format={fmtUsd} />}
        sub={cost === 0 ? (onMac ? "trained on this Mac" : "no cloud cost recorded") : undefined}
        accent="bg-spot"
      />
    </section>
  );
}
