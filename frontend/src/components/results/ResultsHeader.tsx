"use client";

import { ProvisionalBadge, StatTile } from "@/components/ui";
import { fmtDelta, fmtInt, fmtPct } from "@/lib/format";
import type { EvalCompare } from "@/lib/types";
import { METRICS, baseRow, currentRow, testSetSize, type ModelRow } from "./model-meta";

const TILE_KEYS = ["category_macro_f1", "category_acc", "priority_acc"] as const;

/** One honest sentence about the test set; the copy depends on whether the labels are verified. */
function TestSetNote({ evalCompare }: { evalCompare: EvalCompare }) {
  const size = testSetSize(evalCompare);
  if (!evalCompare.provisional) {
    return (
      <p className="mt-3 text-xl text-ink-2">
        Test set: {size !== null ? <span className="num">{fmtInt(size)}</span> : null}
        {size !== null ? " " : ""}human-labelled tickets
      </p>
    );
  }
  return (
    <div className="mt-3 max-w-4xl">
      <p className="text-xl text-ink-2">
        Test set: {size !== null ? <><span className="num">{fmtInt(size)}</span> tickets</> : "tickets"}
      </p>
      <p className="mt-1 text-lg text-ink-2">
        The test labels come from the teacher model and have not been verified by humans yet, so treat
        these numbers as provisional.
      </p>
    </div>
  );
}

function Headline({ rows }: { rows: ModelRow[] }) {
  const base = baseRow(rows);
  const cur = currentRow(rows);
  if (!cur) return null;

  const trained = rows.filter((r) => r.kind === "round");
  const rejected = trained.filter((r) => r.status === "rejected").length;
  const promoted = trained.filter((r) => r.status === "current" || r.status === "superseded").length;
  const moved = base && cur.kind !== "base" ? (cur.model.category_macro_f1 - base.model.category_macro_f1) * 100 : null;

  return (
    <>
      {moved !== null && base ? (
        <p className="mt-5 max-w-4xl text-xl leading-snug text-ink">
          Macro-F1 {moved >= 0 ? "rose" : "fell"} from{" "}
          <strong className="num font-semibold">{fmtPct(base.model.category_macro_f1, 1)}</strong> for{" "}
          {base.label.toLowerCase()} to{" "}
          <strong className="num font-semibold">{fmtPct(cur.model.category_macro_f1, 1)}</strong> for{" "}
          {cur.label.toLowerCase()}, the model in use now ({fmtDelta(moved)}).{" "}
          <span className="text-ink-2">
            {trained.length} training {trained.length === 1 ? "round" : "rounds"}: {promoted} promoted
            {rejected > 0 ? `, ${rejected} not promoted` : ""}.
          </span>
        </p>
      ) : (
        <p className="mt-5 max-w-4xl text-xl leading-snug text-ink">
          No trained round has been promoted yet, so the {cur.label.toLowerCase()} model is in use.
        </p>
      )}

      <div className="mt-7 grid grid-cols-1 gap-x-10 gap-y-6 md:grid-cols-3">
        {TILE_KEYS.map((key) => {
          const m = METRICS.find((x) => x.key === key);
          if (!m) return null;
          const value = cur.model[key];
          const sub =
            base && cur.kind !== "base" ? (
              <span className="num">
                from {m.format(base.model[key])} for {base.label.toLowerCase()}
                {m.delta(value, base.model[key]) ? ` · ${m.delta(value, base.model[key])}` : ""}
              </span>
            ) : (
              <span>{cur.label} model</span>
            );
          return (
            <StatTile
              key={key}
              label={`${m.label}, ${cur.label.toLowerCase()}`}
              value={m.format(value)}
              sub={sub}
              accent="local"
            />
          );
        })}
      </div>
    </>
  );
}

export function ResultsHeader({ evalCompare, rows }: { evalCompare: EvalCompare; rows: ModelRow[] }) {
  return (
    <header className="mb-8 sm:mb-10">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="display text-[clamp(2.25rem,1.5rem+3vw,3.75rem)] font-semibold leading-none">
          Results
        </h1>
        {evalCompare.provisional ? <ProvisionalBadge className="text-base" /> : null}
      </div>
      <TestSetNote evalCompare={evalCompare} />
      <Headline rows={rows} />
    </header>
  );
}
