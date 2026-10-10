"use client";

import { motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { AnimatedNumber, Card, cx } from "@/components/ui";
import { fmtInt } from "@/lib/format";
import { StatusTag } from "./chart-parts";
import { METRICS, baseRow, bestNames, isImprovement, type ModelRow } from "./model-meta";

export function ComparisonTable({ rows, testSize }: { rows: ModelRow[]; testSize: number | null }) {
  const reduce = useReducedMotion();
  const best = useMemo(() => METRICS.map((m) => bestNames(rows, m)), [rows]);
  const base = baseRow(rows);
  const costTied = useMemo(() => {
    const m = METRICS.find((x) => x.key === "cost_per_1k");
    if (!m || rows.length === 0) return false;
    return rows.every((r) => r.model[m.key] === rows[0].model[m.key]);
  }, [rows]);

  // Stagger only the first reveal; rows that appear later (new training round) enter immediately.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSettled(true), 1500);
    return () => clearTimeout(t);
  }, []);

  return (
    <Card title="Model comparison" as="section">
      <p className="-mt-1 mb-2 text-base text-ink-3">
        Every model on the same {testSize !== null ? `${fmtInt(testSize)} ` : ""}test tickets. Changes are
        against the base model.
      </p>
      <div className="-mx-1 overflow-x-auto">
        <table className="w-full min-w-[56rem] border-separate border-spacing-0 text-left">
          <caption className="sr-only">
            Evaluation metrics per model: category accuracy, macro-F1, priority accuracy, latency and
            cost per 1,000 tickets, with the change against the base model.
          </caption>
          <thead>
            <tr>
              <th scope="col" className="px-3 py-3 text-base font-medium text-ink-3">
                Model
              </th>
              {METRICS.map((m) => (
                <th
                  key={m.key}
                  scope="col"
                  className="px-3 py-3 text-right text-base font-medium text-ink-3"
                >
                  {m.head}
                  <span className="block text-base font-normal text-ink-3/80">
                    {m.higherBetter ? "higher is better" : "lower is better"}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const cell = "border-t border-line px-3 py-3.5 text-right align-top";
              return (
                <motion.tr
                  key={r.model.name}
                  initial={reduce ? false : { opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.4, ease: "easeOut", delay: settled ? 0 : i * 0.07 }}
                  className={cx(r.isCurrent && "bg-spot/[0.08]")}
                >
                  <th
                    scope="row"
                    className={cx(
                      "border-t border-line px-3 py-3.5 text-left align-top font-normal",
                      r.isCurrent && "border-l-4 border-l-spot",
                    )}
                  >
                    <span className="flex items-start gap-3">
                      <span
                        aria-hidden
                        className="mt-1.5 size-3.5 flex-none rounded-sm"
                        style={{ background: r.color }}
                      />
                      <span>
                        <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                          <span
                            className={cx(
                              "text-lg leading-tight",
                              r.isCurrent ? "font-bold text-ink" : "font-medium text-ink",
                            )}
                          >
                            {r.label}
                          </span>
                          <StatusTag row={r} />
                        </span>
                        <span className="mt-0.5 block text-base text-ink-3">{r.role}</span>
                        {r.reason ? <span className="block max-w-[22rem] text-base text-ink-3">{r.reason}</span> : null}
                      </span>
                    </span>
                  </th>
                  {METRICS.map((m, mi) => {
                    const v = r.model[m.key];
                    const isBest = best[mi].has(r.model.name);
                    const d = base && r.kind !== "base" ? m.delta(v, base.model[m.key]) : null;
                    const good = base ? isImprovement(m, v, base.model[m.key]) : null;
                    return (
                      <td key={m.key} className={cell}>
                        <span className="flex flex-col items-end">
                          <span className="inline-flex items-center justify-end gap-2">
                            {isBest ? (
                              <span
                                className="rounded border border-good/60 px-1.5 py-px text-base font-semibold leading-6 text-good"
                                title={`Best ${m.label.toLowerCase()} in this table`}
                              >
                                ▲ best
                              </span>
                            ) : null}
                            <AnimatedNumber
                              value={v}
                              format={m.format}
                              className={cx("text-lg", isBest ? "font-bold text-ink" : "text-ink-2")}
                            />
                          </span>
                          {d ? (
                            <span
                              className={cx(
                                "num text-base",
                                good === true ? "text-good" : good === false ? "text-bad" : "text-ink-3",
                              )}
                            >
                              {d} <span className="text-ink-3">vs base</span>
                            </span>
                          ) : null}
                        </span>
                      </td>
                    );
                  })}
                </motion.tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-base text-ink-3">
        Best = highest accuracy or F1, lowest latency or cost; nothing is marked when every model ties.
        {costTied && rows.length > 0
          ? ` Cost per 1,000 tickets is ${METRICS[4].format(rows[0].model.cost_per_1k)} for every model listed.`
          : ""}
      </p>
    </Card>
  );
}
