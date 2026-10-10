"use client";

import { useState } from "react";
import { ProgressBar } from "@/components/ui";
import { useStore, type ActiveStage } from "@/lib/store";
import type { TrainProgress } from "@/lib/types";
import { LoopDiagram, stageLabel } from "./LoopDiagram";

function captionFor(stage: ActiveStage, tp: TrainProgress | null): string {
  switch (stage) {
    case "idle":
      return "Idle — routing tickets";
    case "routing":
      return "Now: routing — Gemma answers what it is sure of, the teacher gets the rest";
    case "collect":
      return `Now: teacher answers becoming training data${tp?.message ? ` — ${tp.message}` : ""}`;
    case "train":
      if (tp?.step !== undefined && tp.total_steps !== undefined) {
        const loss = tp.loss !== undefined ? `, loss ${tp.loss.toFixed(2)}` : "";
        return `Now: LoRA training — step ${tp.step}/${tp.total_steps}${loss}`;
      }
      return `Now: LoRA training${tp?.message ? ` — ${tp.message}` : ""}`;
    case "evaluate":
      return `Now: evaluation gate${tp?.message ? ` — ${tp.message}` : " — scoring the new adapter on held-out tickets"}`;
    case "promote":
      return `Now: hot-swap${tp?.message ? ` — ${tp.message}` : " — serving the promoted model"}`;
  }
}

export function LoopPanel() {
  const { state, actions } = useStore();
  const { activeStage, trainProgress } = state;
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = trainProgress !== null;

  const onRun = async () => {
    setError(null);
    setStarting(true);
    try {
      await actions.runTrainingRound();
    } catch {
      setError("Could not start a training round. Check the connection and try again.");
    } finally {
      setStarting(false);
    }
  };

  return (
    <section
      aria-label="Training loop"
      className="rounded-lg border border-line bg-surface p-4 sm:p-6"
    >
      <LoopDiagram stage={activeStage} />

      <div className="mt-6 border-t border-line pt-5">
        <p
          className={`text-xl font-medium leading-snug sm:text-2xl ${
            activeStage === "idle" ? "text-ink-2" : "text-spot"
          }`}
        >
          {captionFor(activeStage, trainProgress)}
        </p>
        <p className="sr-only" role="status" aria-live="polite">
          {`Current stage: ${stageLabel(activeStage)}`}
        </p>

        <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-6">
          <button
            type="button"
            onClick={onRun}
            disabled={running || starting}
            className="inline-flex flex-none items-center justify-center rounded-lg bg-spot px-6 py-3 text-lg font-semibold text-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {running || starting ? "Training round running…" : "Run training round"}
          </button>
          <div className="min-h-[3.25rem] flex-1">
            {running ? (
              <ProgressBar
                value={trainProgress.progress}
                label={`Round ${trainProgress.round} — ${stageLabel(trainProgress.stage)}`}
                fillClassName="bg-spot"
              />
            ) : (
              <p className="text-base text-ink-3">
                Runs one full round: collect teacher answers, train, evaluate, then promote only if the gate passes.
              </p>
            )}
          </div>
        </div>
        {error ? (
          <p role="alert" className="mt-3 text-base text-bad">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
