"use client";

import { useState } from "react";
import { ProgressBar } from "@/components/ui";
import { CATEGORY_LETTERS, categoryLabel } from "@/lib/categories";
import { fmtDateTime } from "@/lib/format";
import { useStore, type ActiveStage } from "@/lib/store";
import type { TrainProgress } from "@/lib/types";
import { LoopDiagram, stageLabel } from "./LoopDiagram";

function captionFor(stage: ActiveStage, tp: TrainProgress | null, canControl: boolean): string {
  switch (stage) {
    case "idle":
      return canControl ? "No round running" : "Showing saved results, no round running";
    case "routing":
      return "Now: routing. The local model answers what it is sure of, the teacher gets the rest";
    case "collect":
      return `Now: teacher answers becoming training data${tp?.message ? `. ${tp.message}` : ""}`;
    case "train":
      if (tp?.step !== undefined && tp.total_steps !== undefined) {
        const loss = tp.loss !== undefined ? `, loss ${tp.loss.toFixed(2)}` : "";
        return `Now: LoRA training, step ${tp.step} of ${tp.total_steps}${loss}`;
      }
      return `Now: LoRA training${tp?.message ? `. ${tp.message}` : ""}`;
    case "evaluate":
      return `Now: evaluation gate${tp?.message ? `. ${tp.message}` : ", scoring the new adapter"}`;
    case "promote":
      return `Now: promotion${tp?.message ? `. ${tp.message}` : ", serving the new adapter"}`;
  }
}

export function LoopPanel() {
  const { state, actions } = useStore();
  const { activeStage, trainProgress, canControl, apiConfigured, snapshotAt, trainError, loaded } = state;
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = trainProgress !== null;
  const blocked = loaded && !canControl;

  const onRun = async () => {
    setError(null);
    setStarting(true);
    try {
      await actions.runTrainingRound();
    } catch (e) {
      setError(
        e instanceof Error && e.message
          ? `Could not start a training round: ${e.message}`
          : "Could not start a training round. Check the backend and try again.",
      );
    } finally {
      setStarting(false);
    }
  };

  const why = blocked
    ? apiConfigured
      ? `The backend is not reachable, so this page shows a saved export${snapshotAt ? ` from ${fmtDateTime(snapshotAt)}` : ""}. Start the backend on the Mac to run a round.`
      : `This is a read-only export${snapshotAt ? ` from ${fmtDateTime(snapshotAt)}` : ""}. No backend is connected, so rounds cannot be started here.`
    : null;

  return (
    <section aria-label="Training loop" className="rounded-lg border border-line bg-surface p-4 sm:p-6">
      <LoopDiagram stage={activeStage} />

      <div className="mt-4 border-t border-line pt-4">
        <p className="mb-2 text-base text-ink-3">The router sorts every ticket into one of eight categories</p>
        <ul className="flex flex-wrap gap-2">
          {CATEGORY_LETTERS.map((l) => (
            <li
              key={l}
              className="inline-flex items-center gap-2 rounded-full border border-line-strong bg-surface-2 px-3 py-0.5 text-base text-ink-2"
            >
              <span className="font-mono font-semibold text-ink">{l}</span>
              {categoryLabel(l)}
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-5 border-t border-line pt-5">
        <p
          className={`text-xl font-medium leading-snug sm:text-2xl ${
            activeStage === "idle" ? "text-ink-2" : "text-spot"
          }`}
        >
          {captionFor(activeStage, trainProgress, canControl)}
        </p>
        <p className="sr-only" role="status" aria-live="polite">
          {`Current stage: ${stageLabel(activeStage)}`}
        </p>

        <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-6">
          <button
            type="button"
            onClick={onRun}
            disabled={running || starting || !canControl}
            aria-describedby="run-help"
            className="inline-flex flex-none items-center justify-center rounded-lg bg-spot px-6 py-3 text-lg font-semibold text-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {running || starting ? "Training round running…" : "Run training round"}
          </button>
          <div className="min-h-[3.25rem] flex-1">
            {running ? (
              <ProgressBar
                value={trainProgress.progress}
                label={`Round ${trainProgress.round}: ${stageLabel(trainProgress.stage)}`}
                fillClassName="bg-spot"
              />
            ) : (
              <p id="run-help" className="text-base text-ink-2">
                {why ??
                  "Runs one round on this Mac: collect teacher answers, train a LoRA adapter, score it, and promote it only if macro-F1 improves."}
              </p>
            )}
          </div>
        </div>
        {error || trainError ? (
          <p role="alert" className="mt-3 text-base text-bad">
            {error ?? `The last round failed: ${trainError}`}
          </p>
        ) : null}
      </div>
    </section>
  );
}
