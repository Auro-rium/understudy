"use client";

import { ProvisionalBadge } from "@/components/ui";
import { fmtPct, fmtUsd } from "@/lib/format";
import type { EvalCompare } from "@/lib/types";
import { buildRows } from "./model-meta";

export function ResultsHeader({ evalCompare }: { evalCompare: EvalCompare }) {
  const rows = buildRows(evalCompare);
  const router = rows.find((r) => r.kind === "router");
  const teacher = rows.find((r) => r.kind === "teacher");

  return (
    <header className="mb-8 sm:mb-10">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="display text-[clamp(2.25rem,1.5rem+3vw,3.75rem)] font-semibold leading-none">
          Results
        </h1>
        {evalCompare.provisional ? <ProvisionalBadge className="text-base" /> : null}
      </div>
      <p className="mt-3 text-xl text-ink-2">Test set: 200 human-labelled tickets</p>
      {evalCompare.provisional ? (
        <p className="mt-1 text-base text-ink-3">
          Provisional: the backend marked this evaluation as not final.
        </p>
      ) : null}
      {router ? (
        <p className="mt-5 max-w-4xl text-xl leading-snug text-ink">
          The Understudy router gets{" "}
          <strong className="num font-semibold">{fmtPct(router.model.category_acc, 1)}</strong> category
          accuracy at{" "}
          <strong className="num font-semibold">{fmtUsd(router.model.cost_per_1k)}</strong> per 1,000
          tickets
          {teacher ? (
            <>
              , versus <strong className="num font-semibold">{fmtUsd(teacher.model.cost_per_1k)}</strong>{" "}
              per 1,000 for the cloud teacher on its own
            </>
          ) : null}
          .
        </p>
      ) : null}
    </header>
  );
}
