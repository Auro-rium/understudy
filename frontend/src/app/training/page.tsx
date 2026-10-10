"use client";

import { Explainers } from "@/components/training/Explainers";
import { LoopPanel } from "@/components/training/LoopPanel";
import { RoundCards } from "@/components/training/RoundCards";
import { SummaryStrip } from "@/components/training/SummaryStrip";

export default function TrainingPage() {
  return (
    <div className="stage-glow">
      <div className="mx-auto max-w-[120rem] px-4 py-8 sm:px-8 sm:py-12">
        <h1 className="display text-[clamp(2.25rem,1.5rem+3.5vw,4.5rem)] font-semibold leading-none">
          How it learns
        </h1>
        <p className="mt-3 max-w-3xl text-xl text-ink-2">
          Every teacher answer becomes a training example. Each round trains a small adapter, tests it on held-out
          tickets, and only goes live if it passes the gate.
        </p>

        <div className="mt-8">
          <LoopPanel />
        </div>

        <div className="mt-12">
          <SummaryStrip />
        </div>

        <section aria-label="Training rounds" className="mt-8">
          <h2 className="mb-4 text-2xl font-semibold text-ink">Training rounds</h2>
          <RoundCards />
        </section>

        <section aria-label="Explainers" className="mt-12">
          <Explainers />
        </section>
      </div>
    </div>
  );
}
