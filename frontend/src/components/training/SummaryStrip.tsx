"use client";

import type { ReactNode } from "react";
import { AnimatedNumber } from "@/components/ui";
import { fmtInt, fmtUsd } from "@/lib/format";
import { useStore } from "@/lib/store";

function Figure({ label, value, accent }: { label: string; value: ReactNode; accent?: string }) {
  return (
    <div className="relative pl-5">
      <span aria-hidden className={`absolute bottom-1 left-0 top-1 w-1 rounded-full ${accent ?? "bg-line-strong"}`} />
      <p className="text-lg text-ink-2">{label}</p>
      <p className="num display text-5xl font-semibold leading-tight text-ink sm:text-6xl">{value}</p>
    </div>
  );
}

/** Everything here is computed from state.rounds and nothing else. */
export function SummaryStrip() {
  const { state } = useStore();
  const { rounds } = state;
  const promoted = rounds.filter((r) => r.promoted).length;
  const examples = rounds.reduce((sum, r) => sum + r.examples, 0);
  const cost = rounds.reduce((sum, r) => sum + r.cost_usd, 0);

  return (
    <section aria-label="Training summary" className="grid grid-cols-2 gap-x-6 gap-y-8 lg:grid-cols-4">
      <Figure label="Rounds run" value={<AnimatedNumber value={rounds.length} format={fmtInt} />} accent="bg-local" />
      <Figure label="Promoted" value={<AnimatedNumber value={promoted} format={fmtInt} />} accent="bg-good" />
      <Figure
        label="Training examples used"
        value={<AnimatedNumber value={examples} format={fmtInt} />}
        accent="bg-teacher"
      />
      <Figure label="Total training cost" value={<AnimatedNumber value={cost} format={fmtUsd} />} accent="bg-spot" />
    </section>
  );
}
