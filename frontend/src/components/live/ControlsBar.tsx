"use client";

import { useCallback, useState } from "react";
import { useStore } from "@/lib/store";
import { fmtInt } from "@/lib/format";
import { AnimatedNumber, ProgressBar, cx } from "@/components/ui";
import type { TrainStage } from "@/lib/types";
import { ReviewDrawer } from "./ReviewDrawer";

const RATES = [20, 40, 90] as const;

const STAGE_LABEL: Record<TrainStage, string> = {
  collect: "Collecting teacher answers",
  train: "Training LoRA",
  evaluate: "Evaluating",
  promote: "Promoting",
};

const btn =
  "inline-flex min-h-12 items-center justify-center gap-2 rounded-lg px-5 text-lg font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50";

function Group({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cx("flex min-w-0 flex-col gap-2", className)}>
      <p className="text-sm font-medium uppercase tracking-wider text-ink-3">{label}</p>
      {children}
    </div>
  );
}

export function ControlsBar() {
  const { state, actions } = useStore();
  const [rate, setRate] = useState<number>(40);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  const closeDrawer = useCallback(() => setDrawer(false), []);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That action failed.");
    } finally {
      setBusy(null);
    }
  };

  const offline = state.mode === "offline";
  const tp = state.trainProgress;
  const training = tp !== null;
  const queue = state.reviewQueue.length;

  return (
    <section aria-label="Demo controls" className="rounded-xl border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-start gap-x-8 gap-y-6">
        {/* stream */}
        <Group label="Ticket stream">
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              aria-pressed={state.streaming}
              disabled={busy === "stream"}
              onClick={() =>
                run("stream", () => (state.streaming ? actions.stopStream() : actions.startStream(rate)))
              }
              className={cx(
                btn,
                state.streaming
                  ? "border border-spot bg-spot/10 text-spot hover:bg-spot/20"
                  : "bg-local text-white hover:brightness-110",
              )}
            >
              <span aria-hidden>{state.streaming ? "■" : "▶"}</span>
              {state.streaming ? "Stop stream" : "Start stream"}
            </button>
            <div role="radiogroup" aria-label="Tickets per minute" className="flex items-center gap-1 rounded-lg border border-line-strong p-1">
              {RATES.map((r) => (
                <button
                  key={r}
                  type="button"
                  role="radio"
                  aria-checked={rate === r}
                  onClick={() => {
                    setRate(r);
                    if (state.streaming) void run("stream", () => actions.startStream(r));
                  }}
                  className={cx(
                    "min-h-12 min-w-14 rounded-md px-3 text-lg font-semibold num transition-colors",
                    rate === r ? "bg-surface-3 text-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink",
                  )}
                >
                  {r}
                </button>
              ))}
              <span className="px-2 text-base text-ink-3">/ min</span>
            </div>
          </div>
        </Group>

        {/* training */}
        <Group label="Training" className="min-w-[18rem] flex-1 basis-[26rem]">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
            <button
              type="button"
              disabled={training || busy === "train"}
              onClick={() => run("train", () => actions.runTrainingRound())}
              className={cx(btn, "border border-line-strong bg-surface-2 text-ink hover:bg-surface-3")}
            >
              Run training round
            </button>
            <div className="min-w-[14rem] flex-1">
              {tp ? (
                <>
                  <ProgressBar
                    value={tp.progress}
                    label={STAGE_LABEL[tp.stage]}
                    fillClassName={tp.stage === "promote" ? "bg-good" : "bg-local"}
                  />
                  <p className="num mt-1 flex flex-wrap gap-x-4 text-base text-ink-2">
                    <span>Round {tp.round}</span>
                    {tp.total_steps ? (
                      <span>
                        step {fmtInt(tp.step ?? 0)}/{fmtInt(tp.total_steps)}
                      </span>
                    ) : null}
                    {tp.loss !== undefined ? <span>loss {tp.loss.toFixed(3)}</span> : null}
                  </p>
                </>
              ) : (
                <p className="text-base text-ink-3">
                  Idle. A round trains Gemma on the teacher answers collected so far.
                </p>
              )}
            </div>
          </div>
        </Group>

        {/* offline */}
        <Group label="Connectivity">
          <button
            type="button"
            role="switch"
            aria-checked={offline}
            disabled={busy === "offline"}
            onClick={() => run("offline", () => actions.setOffline(!offline))}
            className={cx(
              btn,
              "justify-between gap-4 border",
              offline
                ? "border-spot bg-spot/10 text-spot"
                : "border-line-strong bg-surface-2 text-ink hover:bg-surface-3",
            )}
          >
            <span>Force offline</span>
            <span
              aria-hidden
              className={cx(
                "relative h-7 w-12 rounded-full transition-colors",
                offline ? "bg-spot" : "bg-surface-3 ring-1 ring-line-strong",
              )}
            >
              <span
                className={cx(
                  "absolute top-0.5 size-6 rounded-full bg-ink transition-[left]",
                  offline ? "left-[1.375rem] bg-bg" : "left-0.5",
                )}
              />
            </span>
          </button>
          <p className={cx("text-base", offline ? "text-spot" : "text-ink-3")}>
            {offline ? "Offline: unsure tickets go to review" : "Online: teacher available"}
          </p>
        </Group>

        {/* review */}
        <Group label="Human review">
          <button
            type="button"
            aria-haspopup="dialog"
            aria-expanded={drawer}
            onClick={() => setDrawer(true)}
            className={cx(btn, "gap-3 border border-review/50 bg-surface-2 text-ink hover:bg-surface-3")}
          >
            <span>Review queue</span>
            <span className="num rounded-md bg-review/20 px-2.5 py-0.5 text-xl text-ink">
              <AnimatedNumber value={queue} format={fmtInt} durationMs={500} />
            </span>
          </button>
        </Group>
      </div>

      {error ? (
        <p role="alert" className="mt-4 text-base text-bad">
          {error}
        </p>
      ) : null}

      <ReviewDrawer open={drawer} onClose={closeDrawer} items={state.reviewQueue} />
    </section>
  );
}
