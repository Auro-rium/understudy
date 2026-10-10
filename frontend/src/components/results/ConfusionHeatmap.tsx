"use client";

import { motion, useReducedMotion } from "motion/react";
import { useMemo, useState } from "react";
import { Card, cx } from "@/components/ui";
import { categoryLabel } from "@/lib/categories";
import { fmtInt, fmtPct } from "@/lib/format";
import type { EvalCompare } from "@/lib/types";
import { buildRows, latestTrained, rampColor } from "./model-meta";
import { Segmented } from "./Segmented";

/** Blue sequential ramp (globals.css --seq-*), reversed for the dark surface: few = recedes, many = bright. */
const RAMP = ["#0d366b", "#1c5cab", "#3987e5", "#86b6ef", "#cde2fb"];
const INK_DARK = "#0b0d14";
const INK_LIGHT = "#f2f0ea";

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}
function contrast(a: number, b: number): number {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Square-root scale so small confusions (1-4 tickets) stay visible next to a
 * diagonal of ~30; the legend states this. Zero keeps the quiet surface colour.
 */
function cellColor(count: number, max: number): string {
  if (count <= 0 || max <= 0) return "var(--surface-2)";
  return rampColor(RAMP, Math.sqrt(count / max));
}
function textColor(count: number, max: number): string {
  if (count <= 0 || max <= 0) return "var(--text-3)";
  const L = luminance(rampColor(RAMP, Math.sqrt(count / max)));
  return contrast(L, luminance(INK_DARK)) >= contrast(L, luminance(INK_LIGHT)) ? INK_DARK : INK_LIGHT;
}

const LEGEND_GRADIENT = `linear-gradient(to right, var(--surface-2), ${Array.from({ length: 11 }, (_, k) => {
  const f = k / 10; // fraction of max
  return `${rampColor(RAMP, Math.sqrt(f))} ${Math.round(f * 100)}%`;
}).join(", ")})`;

interface Hover {
  i: number;
  j: number;
}

export function ConfusionHeatmap({ evalCompare }: { evalCompare: EvalCompare }) {
  const reduce = useReducedMotion();
  const keys = useMemo(() => Object.keys(evalCompare.confusion), [evalCompare.confusion]);
  const rows = useMemo(() => buildRows(evalCompare), [evalCompare]);

  const defaultKey = useMemo(() => {
    const latest = latestTrained(rows)?.model.name;
    if (latest && keys.includes(latest)) return latest;
    return keys[keys.length - 1];
  }, [rows, keys]);

  const [picked, setPicked] = useState<string | null>(null);
  const [asTable, setAsTable] = useState(false);
  const [hover, setHover] = useState<Hover | null>(null);

  const active = picked && keys.includes(picked) ? picked : defaultKey;
  const matrix = active ? evalCompare.confusion[active] : undefined;

  if (!active || !matrix || matrix.length === 0) return null;

  const n = matrix.length;
  const keyed = Object.keys(evalCompare.per_category_f1[active] ?? {}).map(categoryLabel);
  const names =
    keyed.length === n ? keyed : Array.from({ length: n }, (_, i) => keyed[i] ?? `Category ${i + 1}`);
  const rowTotals = matrix.map((r) => r.reduce((a, b) => a + b, 0));
  const max = Math.max(0, ...matrix.flat());
  const total = rowTotals.reduce((a, b) => a + b, 0);
  const correct = matrix.reduce((a, r, i) => a + (r[i] ?? 0), 0);

  const describe = (i: number, j: number) => {
    const c = matrix[i][j];
    const p = rowTotals[i] > 0 ? c / rowTotals[i] : 0;
    return `true ${names[i]} → predicted ${names[j]}: ${fmtInt(c)} ${c === 1 ? "ticket" : "tickets"} (${fmtPct(p, 1)} of true ${names[i]})`;
  };

  const gridCols = `minmax(7.5rem, 13rem) repeat(${n}, minmax(4.25rem, 1fr))`;

  return (
    <Card
      title="Where the model gets confused"
      action={
        <button
          type="button"
          onClick={() => setAsTable((v) => !v)}
          aria-pressed={asTable}
          className="min-h-9 rounded-md border border-line px-3 text-base text-ink-2 hover:border-line-strong hover:text-ink"
        >
          {asTable ? "Show as heatmap" : "Show as table"}
        </button>
      }
    >
      <p className="mb-3 text-base text-ink-3">
        Each row is the true category of a test ticket; each column is what the model predicted. The
        diagonal is correct.
      </p>
      <Segmented
        label="Model"
        options={keys.map((k) => ({ value: k, label: k }))}
        value={active}
        onChange={(v) => {
          setPicked(v);
          setHover(null);
        }}
        className="mb-2"
      />
      <p className="mb-4 text-lg text-ink-2">
        <span className="num font-semibold text-ink">
          {fmtInt(correct)} of {fmtInt(total)}
        </span>{" "}
        test tickets on the diagonal ({fmtPct(total > 0 ? correct / total : 0, 1)} correct) for {active}.
      </p>

      {asTable ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] border-separate border-spacing-0 text-left">
            <caption className="sr-only">
              Confusion matrix for {active}. Rows are true categories, columns are predicted categories,
              cells are ticket counts.
            </caption>
            <thead>
              <tr>
                <th scope="col" className="px-3 py-2 text-sm font-medium text-ink-3">
                  True ↓ / Predicted →
                </th>
                {names.map((nm, j) => (
                  <th key={j} scope="col" className="px-2 py-2 text-right text-sm font-medium text-ink-3">
                    {nm}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matrix.map((r, i) => (
                <tr key={i}>
                  <th scope="row" className="border-t border-line px-3 py-2 text-left text-base font-normal text-ink">
                    {names[i]}
                  </th>
                  {r.map((c, j) => (
                    <td
                      key={j}
                      className={cx(
                        "num border-t border-line px-2 py-2 text-right text-base",
                        i === j ? "font-bold text-ink" : "text-ink-2",
                      )}
                    >
                      {fmtInt(c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto pb-2">
            <div
              key={active}
              role="group"
              aria-label={`Confusion matrix for ${active}. Rows are true categories, columns are predicted.`}
              className="grid min-w-[36rem] gap-[2px]"
              style={{ gridTemplateColumns: gridCols }}
              onMouseLeave={() => setHover(null)}
            >
              {/* header row */}
              <div className="flex items-end pb-1 pr-2 text-sm leading-tight text-ink-3">
                True ↓ &nbsp;/&nbsp; Predicted →
              </div>
              {names.map((nm, j) => (
                <div
                  key={`h${j}`}
                  title={nm}
                  className={cx(
                    "flex items-end justify-center px-1 pb-1 text-center text-sm leading-tight",
                    hover?.j === j ? "font-semibold text-ink" : "text-ink-2",
                  )}
                >
                  <span className="line-clamp-3 break-words">{nm}</span>
                </div>
              ))}

              {matrix.map((r, i) => (
                <RowCells key={i}>
                  <div
                    title={`${names[i]} (${fmtInt(rowTotals[i])} test tickets)`}
                    className={cx(
                      "flex flex-col justify-center pr-3 text-right text-base leading-tight",
                      hover?.i === i ? "font-semibold text-ink" : "text-ink-2",
                    )}
                  >
                    <span className="line-clamp-2 break-words">{names[i]}</span>
                    <span className="num text-sm font-normal text-ink-3">{fmtInt(rowTotals[i])} true</span>
                  </div>
                  {r.map((c, j) => {
                    const diag = i === j;
                    const isHover = hover?.i === i && hover?.j === j;
                    return (
                      <motion.button
                        key={j}
                        type="button"
                        title={describe(i, j)}
                        aria-label={describe(i, j)}
                        onMouseEnter={() => setHover({ i, j })}
                        onFocus={() => setHover({ i, j })}
                        onBlur={() => setHover(null)}
                        initial={reduce ? false : { opacity: 0, scale: 0.92 }}
                        whileInView={{ opacity: 1, scale: 1 }}
                        viewport={{ once: true, amount: 0.1 }}
                        transition={{ duration: 0.35, ease: "easeOut", delay: reduce ? 0 : (i + j) * 0.05 }}
                        className={cx(
                          "num relative flex aspect-square items-center justify-center rounded-[4px] text-lg",
                          diag ? "font-extrabold" : "font-medium",
                        )}
                        style={{
                          background: cellColor(c, max),
                          color: textColor(c, max),
                          boxShadow: isHover
                            ? "inset 0 0 0 3px var(--spot)"
                            : diag
                              ? "inset 0 0 0 2px rgba(242,240,234,0.9)"
                              : undefined,
                        }}
                      >
                        {fmtInt(c)}
                      </motion.button>
                    );
                  })}
                </RowCells>
              ))}
            </div>
          </div>

          <p className="mt-3 min-h-14 text-lg text-ink sm:min-h-8" aria-live="off">
            {hover ? (
              <span className="num">{describe(hover.i, hover.j)}</span>
            ) : (
              <span className="text-ink-3">
                Hover or focus a cell for details. Cells with a white outline and bold count are correct
                predictions.
              </span>
            )}
          </p>

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-2">
            <span>0</span>
            <span
              aria-hidden
              className="h-3 w-48 rounded-[3px] border border-line"
              style={{ background: LEGEND_GRADIENT }}
            />
            <span className="num">{fmtInt(max)} tickets</span>
            <span className="text-ink-3">Colour scale is square-root so small confusions stay visible.</span>
          </div>
        </>
      )}
    </Card>
  );
}

/** Fragment wrapper so each matrix row keeps a stable key inside the CSS grid. */
function RowCells({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
