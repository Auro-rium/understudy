"use client";

import { useMemo, useState } from "react";
import { useStore } from "@/lib/store";
import { fmtPct } from "@/lib/format";
import { cx } from "@/components/ui";

interface Option {
  version: string;
  available: boolean;
  f1: number | null;
}

/**
 * Segmented control next to the serving-model chip: pick base / round_1 / ... and the backend
 * hot-swaps the weights (a few seconds). Disabled with a reason while a training round runs,
 * for versions that are not available, on a saved snapshot, or when the backend is unreachable.
 */
export function ModelSwitch({ className }: { className?: string }) {
  const { state, actions } = useStore();
  const [error, setError] = useState<string | null>(null);

  const options = useMemo<Option[]>(() => {
    if (state.modelVersions.length > 0) {
      return state.modelVersions.map((v) => ({ version: v.version, available: v.available, f1: v.category_macro_f1 }));
    }
    // no /api/model/versions (snapshot, older backend): show what the evaluation knows, read-only
    return (state.evalCompare?.models ?? [])
      .filter((m) => m.name !== "teacher")
      .map((m) => ({ version: m.name, available: true, f1: m.category_macro_f1 }));
  }, [state.modelVersions, state.evalCompare]);

  if (options.length === 0) return null;

  const switching = state.switchingModel;
  const training = state.trainProgress !== null;
  const hasVersions = state.modelVersions.length > 0;
  const locked = !state.canControl || !hasVersions;
  const globalOff = locked || training || switching !== null;

  const note = switching
    ? `Loading ${switching} - this takes a few seconds`
    : !state.canControl
      ? "Saved snapshot - not connected"
      : !hasVersions
        ? "Model switching is not offered by this backend"
        : training
          ? "Unavailable while a training round runs"
          : null;

  const pick = async (version: string) => {
    setError(null);
    try {
      await actions.activateModel(version);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not switch the model.");
    }
  };

  return (
    <div className={cx("min-w-0", className)}>
      <div
        role="radiogroup"
        aria-label="Serving model"
        aria-busy={switching !== null}
        className="flex flex-wrap gap-1.5"
      >
        {options.map((o) => {
          const on = o.version === state.modelVersion;
          const loading = switching === o.version;
          const off = globalOff || !o.available;
          return (
            <button
              key={o.version}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={off || on}
              title={o.available ? undefined : `${o.version} is not available on this backend`}
              onClick={() => void pick(o.version)}
              className={cx(
                "inline-flex min-h-10 flex-col items-start justify-center rounded-md border px-3 text-left transition-colors disabled:cursor-not-allowed",
                on
                  ? "border-ink-3 bg-surface-3 text-ink"
                  : "border-line bg-transparent text-ink-2 enabled:hover:border-line-strong enabled:hover:bg-surface-2 enabled:hover:text-ink",
                !on && off && "opacity-50",
                loading && "animate-pulse border-spot text-ink opacity-100",
              )}
            >
              <span className={cx("font-mono text-base leading-5", on && "font-semibold")}>
                {on ? <span aria-hidden className="mr-1.5 text-spot">●</span> : null}
                {loading ? <span aria-hidden className="mr-1.5 text-spot">…</span> : null}
                {o.version}
              </span>
              <span className="num text-base leading-5 text-ink-3">
                {o.f1 === null ? "F1 –" : `F1 ${fmtPct(o.f1, 1)}`}
                {o.available ? "" : " · n/a"}
              </span>
            </button>
          );
        })}
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-base text-bad">
          {error}
        </p>
      ) : note ? (
        <p role="status" className={cx("mt-2 text-base", switching ? "text-spot" : "text-ink-3")}>
          {note}
        </p>
      ) : null}
    </div>
  );
}
