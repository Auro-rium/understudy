"use client";

import { useMemo, type CSSProperties } from "react";
import { useStore } from "@/lib/store";
import { cx, ProvisionalBadge } from "@/components/ui";
import type { EvalModel, Round } from "@/lib/types";

type Status = "start" | "promoted" | "rejected" | "other";

interface Row {
  name: string;
  label: string;
  status: Status;
  f1: number;
  note: string;
}

const STATUS_TEXT: Record<Status, string> = {
  start: "starting point",
  promoted: "promoted",
  rejected: "rejected",
  other: "",
};

const BAR: Record<Status, string> = {
  start: "bg-ink-3",
  promoted: "bg-local",
  rejected: "",
  other: "bg-ink-3",
};

/** Rejected rounds are hatched grey so the status is not carried by colour alone. */
const HATCH: CSSProperties = {
  backgroundImage:
    "repeating-linear-gradient(135deg, var(--text-3) 0 3px, transparent 3px 7px)",
  boxShadow: "inset 0 0 0 1px var(--text-3)",
};

function labelFor(name: string): string {
  if (name === "base") return "Base model";
  const m = /^round_(\d+)$/.exec(name);
  if (m) return `Round ${m[1]}`;
  return name;
}

function buildRows(models: EvalModel[], rounds: Round[]): Row[] {
  return models.map((m) => {
    const round = rounds.find((r) => r.model_version === m.name);
    const status: Status = m.name === "base" ? "start" : round ? (round.promoted ? "promoted" : "rejected") : "other";
    return { name: m.name, label: labelFor(m.name), status, f1: m.category_macro_f1, note: round?.reason ?? "" };
  });
}

/**
 * The evaluation as a ladder: one bar per model, from the base model up through each
 * training round, drawn from 0 to 1 (macro-F1 on the test set). Promoted rounds are
 * solid blue, a rejected round is hatched grey, and every row says which in words.
 * Everything comes from state.evalCompare and state.rounds.
 */
export function Ladder() {
  const { state } = useStore();
  const ec = state.evalCompare;
  const rows = useMemo(() => (ec ? buildRows(ec.models, state.rounds) : []), [ec, state.rounds]);

  if (!ec || rows.length === 0) return null;

  const summary = rows
    .map((r) => `${r.label} ${r.f1.toFixed(3)}${STATUS_TEXT[r.status] ? `, ${STATUS_TEXT[r.status]}` : ""}`)
    .join("; ");

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="text-lg text-ink-2">Macro-F1 on the test set, 0 to 1. Higher is better.</p>
        {ec.provisional ? <ProvisionalBadge /> : null}
      </div>

      <ol role="img" aria-label={`Macro-F1 by model: ${summary}`} className="grid gap-y-5">
        {rows.map((r) => (
          <li
            key={r.name}
            className="grid grid-cols-[minmax(0,6.25rem)_minmax(0,1fr)_3.75rem] items-center gap-x-3 sm:grid-cols-[9rem_minmax(0,1fr)_4.5rem] sm:gap-x-5"
          >
            <div>
              <p className="text-lg font-semibold leading-tight text-ink">{r.label}</p>
              {STATUS_TEXT[r.status] ? (
                <p className="text-base leading-tight text-ink-3">{STATUS_TEXT[r.status]}</p>
              ) : null}
            </div>
            <div className="h-4 rounded-[4px] bg-surface-3 sm:h-5" aria-hidden>
              <div
                className={cx("h-full rounded-[4px]", BAR[r.status])}
                style={{
                  width: `${Math.max(0, Math.min(1, r.f1)) * 100}%`,
                  ...(r.status === "rejected" ? HATCH : null),
                }}
              />
            </div>
            <p className="num text-right text-xl font-semibold text-ink">{r.f1.toFixed(3)}</p>
            {r.note ? <p className="col-start-2 col-end-4 mt-1 text-base text-ink-3">{r.note}</p> : null}
          </li>
        ))}
      </ol>

      {ec.provisional ? (
        <p className="mt-5 max-w-3xl text-base text-ink-3">
          Provisional: the test labels come from the teacher and are not yet verified by people, so treat these
          scores as a first reading.
        </p>
      ) : null}
    </div>
  );
}
