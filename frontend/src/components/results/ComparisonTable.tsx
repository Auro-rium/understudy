"use client";

import { motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { AnimatedNumber, Card, cx } from "@/components/ui";
import type { EvalCompare } from "@/lib/types";
import { METRICS, bestNames, buildRows } from "./model-meta";

export function ComparisonTable({ evalCompare }: { evalCompare: EvalCompare }) {
  const reduce = useReducedMotion();
  const rows = useMemo(() => buildRows(evalCompare), [evalCompare]);
  const best = useMemo(() => METRICS.map((m) => bestNames(rows, m)), [rows]);

  // Stagger only the first reveal; rows that appear later (new training round) enter immediately.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSettled(true), 1500);
    return () => clearTimeout(t);
  }, []);

  return (
    <Card title="Model comparison" as="section">
      <p className="-mt-1 mb-2 text-base text-ink-3">
        Every model on the same 200 test tickets. Best in each column is marked.
      </p>
      <div className="-mx-1 overflow-x-auto">
        <table className="w-full min-w-[46rem] border-separate border-spacing-0 text-left">
          <caption className="sr-only">
            Evaluation metrics per model: category accuracy, macro-F1, priority accuracy, latency and
            cost per 1,000 tickets.
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
                  <span className="block text-sm font-normal text-ink-3/80">
                    {m.higherBetter ? "higher is better" : "lower is better"}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const headline = r.kind === "router";
              const cell = "border-t border-line px-3 py-3.5 text-right align-middle";
              return (
                <motion.tr
                  key={r.model.name}
                  initial={reduce ? false : { opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.4, ease: "easeOut", delay: settled ? 0 : i * 0.07 }}
                  className={cx(headline && "bg-spot/[0.08]")}
                >
                  <th
                    scope="row"
                    className={cx(
                      "border-t border-line px-3 py-3.5 text-left align-middle font-normal",
                      headline && "border-l-4 border-l-spot",
                    )}
                  >
                    <span className="flex items-center gap-3">
                      <span
                        aria-hidden
                        className="size-3 flex-none rounded-sm"
                        style={{ background: r.color }}
                      />
                      <span>
                        <span
                          className={cx(
                            "block text-lg leading-tight",
                            headline ? "font-bold text-ink" : "font-medium text-ink",
                          )}
                        >
                          {r.model.name}
                          {headline ? (
                            <span className="ml-2 rounded border border-spot px-1.5 py-px align-middle text-xs font-bold uppercase tracking-wide text-spot">
                              Headline
                            </span>
                          ) : null}
                        </span>
                        <span className="block text-sm text-ink-3">{r.role}</span>
                      </span>
                    </span>
                  </th>
                  {METRICS.map((m, mi) => {
                    const isBest = best[mi].has(r.model.name);
                    return (
                      <td key={m.key} className={cell}>
                        <span className="inline-flex items-center justify-end gap-2">
                          {isBest ? (
                            <span
                              className="rounded border border-good/60 px-1.5 py-px text-xs font-semibold uppercase tracking-wide text-good"
                              title={`Best ${m.label.toLowerCase()} in this table`}
                            >
                              ▲ best
                            </span>
                          ) : null}
                          <AnimatedNumber
                            value={r.model[m.key]}
                            format={m.format}
                            className={cx("text-lg", isBest ? "font-bold text-ink" : "text-ink-2")}
                          />
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
      <p className="mt-3 text-sm text-ink-3">
        Best = highest accuracy or F1, lowest latency or cost. Ties are all marked.
      </p>
    </Card>
  );
}
