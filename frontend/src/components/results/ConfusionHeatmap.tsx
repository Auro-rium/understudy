"use client";

import { motion, useReducedMotion } from "motion/react";
import { useMemo, useState, type ReactNode } from "react";
import { Card, cx } from "@/components/ui";
import { CATEGORY_LETTERS, categoryLabel, categoryOrder } from "@/lib/categories";
import { fmtInt, fmtPct } from "@/lib/format";
import type { EvalCompare } from "@/lib/types";
import { currentRow, type ModelRow } from "./model-meta";
import { Segmented } from "./Segmented";
import { useNarrow } from "./useNarrow";

/** Blue sequential ramp (globals.css --seq-*), reversed for the dark surface: few = recedes, many = bright. */
const RAMP = ["#0d366b", "#1c5cab", "#3987e5", "#86b6ef", "#cde2fb"];
const INK_DARK = "#0b0d14";
const INK_LIGHT = "#f2f0ea";

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Linear interpolation along a list of hex stops; t in 0..1. */
function rampColor(stops: string[], t: number): string {
  const x = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const a = hexToRgb(stops[i]);
  const b = hexToRgb(stops[i + 1]);
  const hex = [0, 1, 2].map((k) => Math.round(a[k] + (b[k] - a[k]) * f).toString(16).padStart(2, "0"));
  return `#${hex.join("")}`;
}

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
 * diagonal of ~25; the legend states this. Zero keeps the quiet surface colour.
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
  /** viewport coordinates of the hovered cell, for the floating tooltip */
  rect: { left: number; top: number; width: number; bottom: number };
}

const DIAG_STEP = 0.07; // seconds between diagonal cells
const OFF_STEP = 0.018; // seconds per step away from the top-left, for the off-diagonal cells

export function ConfusionHeatmap({ evalCompare, rows }: { evalCompare: EvalCompare; rows: ModelRow[] }) {
  const reduce = useReducedMotion();
  const narrow = useNarrow();

  // Models that have a matrix, in model order (base, round_1 ...), then any extra keys.
  const models = useMemo(() => {
    const out: { name: string; label: string; row?: ModelRow }[] = [];
    for (const r of rows) {
      if (evalCompare.confusion[r.model.name]?.length) out.push({ name: r.model.name, label: r.label, row: r });
    }
    for (const k of Object.keys(evalCompare.confusion)) {
      if (!out.some((m) => m.name === k) && evalCompare.confusion[k]?.length) out.push({ name: k, label: k });
    }
    return out;
  }, [rows, evalCompare.confusion]);

  const defaultKey = useMemo(() => {
    const cur = currentRow(rows)?.model.name;
    if (cur && models.some((m) => m.name === cur)) return cur;
    return models[models.length - 1]?.name;
  }, [rows, models]);

  const [picked, setPicked] = useState<string | null>(null);
  const [asTable, setAsTable] = useState(false);
  const [hover, setHover] = useState<Hover | null>(null);

  const active = picked && models.some((m) => m.name === picked) ? picked : defaultKey;
  const matrix = active ? evalCompare.confusion[active] : undefined;
  const activeModel = models.find((m) => m.name === active);

  if (!active || !matrix || matrix.length === 0) return null;

  const n = matrix.length;
  // Rows/cols are in the same order as categoryOrder() (letters A..H); names always come from categoryLabel().
  const order = categoryOrder(evalCompare);
  const letters = Array.from({ length: n }, (_, i) => order[i] ?? CATEGORY_LETTERS[i] ?? "");
  const names = letters.map((l, i) => (l ? categoryLabel(l) : `Category ${i + 1}`));
  const rowTotals = matrix.map((r) => r.reduce((a, b) => a + b, 0));
  const max = Math.max(0, ...matrix.flat());
  const total = rowTotals.reduce((a, b) => a + b, 0);
  const correct = matrix.reduce((a, r, i) => a + (r[i] ?? 0), 0);
  const modelText = activeModel ? `${activeModel.label}${activeModel.row ? ` (${activeModel.row.tag.toLowerCase()})` : ""}` : active;

  const describe = (i: number, j: number) => {
    const c = matrix[i]?.[j] ?? 0;
    const p = rowTotals[i] > 0 ? c / rowTotals[i] : 0;
    return i === j
      ? `True ${names[i]}, predicted ${names[j]} (correct): ${fmtInt(c)} ${c === 1 ? "ticket" : "tickets"}, ${fmtPct(p, 1)} of true ${names[i]}`
      : `True ${names[i]}, predicted ${names[j]}: ${fmtInt(c)} ${c === 1 ? "ticket" : "tickets"}, ${fmtPct(p, 1)} of true ${names[i]}`;
  };

  const gridCols = narrow ? `6.75rem repeat(${n}, minmax(0, 1fr))` : `minmax(7.5rem, 13rem) repeat(${n}, minmax(4.25rem, 1fr))`;

  // Diagonal first, then the rest fills in from the top-left.
  const delayFor = (i: number, j: number) => {
    if (reduce) return 0;
    if (i === j) return i * DIAG_STEP;
    return n * DIAG_STEP + 0.15 + (i + j) * OFF_STEP;
  };

  const tip = hover
    ? (() => {
        const w = 288;
        const vw = typeof window === "undefined" ? 1200 : window.innerWidth;
        const left = Math.min(Math.max(8, hover.rect.left + hover.rect.width / 2 - w / 2), vw - w - 8);
        const above = hover.rect.top > 150;
        return { left, w, above, top: above ? hover.rect.top - 8 : hover.rect.bottom + 8 };
      })()
    : null;


  return (
    <Card
      title="Where the model gets confused"
      action={
        <button
          type="button"
          onClick={() => setAsTable((v) => !v)}
          aria-pressed={asTable}
          className="min-h-10 rounded-md border border-line px-3 text-base text-ink-2 hover:border-line-strong hover:text-ink"
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
        options={models.map((m) => ({ value: m.name, label: m.row ? `${m.label} · ${m.row.tag.toLowerCase()}` : m.label }))}
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
        test tickets on the diagonal ({fmtPct(total > 0 ? correct / total : 0, 1)} correct) for {modelText}.
      </p>

      {asTable ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] border-separate border-spacing-0 text-left">
            <caption className="sr-only">
              Confusion matrix for {modelText}. Rows are true categories, columns are predicted categories,
              cells are ticket counts.
            </caption>
            <thead>
              <tr>
                <th scope="col" className="px-3 py-2 text-base font-medium text-ink-3">
                  True ↓ / Predicted →
                </th>
                {names.map((nm, j) => (
                  <th key={j} scope="col" className="px-2 py-2 text-right text-base font-medium text-ink-3">
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
          <div className={cx(!narrow && "overflow-x-auto", "pb-2")}>
            <div
              key={active}
              role="group"
              aria-label={`Confusion matrix for ${modelText}. Rows are true categories, columns are predicted.`}
              className={cx("grid gap-[2px]", !narrow && "min-w-[36rem]")}
              style={{ gridTemplateColumns: gridCols }}
              onMouseLeave={() => setHover(null)}
            >
              {/* header row */}
              <div className="flex items-end pb-1 pr-2 text-base leading-tight text-ink-3">
                {narrow ? "True ↓ Pred. →" : "True ↓ / Predicted →"}
              </div>
              {names.map((nm, j) => (
                <div
                  key={`h${j}`}
                  title={nm}
                  className={cx(
                    "flex pb-1 text-base leading-tight",
                    "h-32 items-start justify-center",
                    hover?.j === j ? "font-semibold text-ink" : "text-ink-2",
                  )}
                >
                  <span
                    className="whitespace-nowrap"
                    style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
                  >
                    {nm}
                  </span>
                </div>
              ))}

              {matrix.map((r, i) => (
                  <RowCells key={i}>
                    <div
                      title={`${names[i]} (${fmtInt(rowTotals[i])} test tickets)`}
                      className={cx(
                        "flex flex-col justify-center pr-2 text-right text-base leading-tight",
                        hover?.i === i ? "font-semibold text-ink" : "text-ink-2",
                      )}
                    >
                      <span className="line-clamp-2 break-words">{names[i]}</span>
                      <span className="num text-base font-normal text-ink-3">{fmtInt(rowTotals[i])} true</span>
                    </div>
                    {r.map((c, j) => {
                      const diag = i === j;
                      const isHover = hover?.i === i && hover?.j === j;
                      const show = (el: HTMLElement) => {
                        const b = el.getBoundingClientRect();
                        setHover({ i, j, rect: { left: b.left, top: b.top, width: b.width, bottom: b.bottom } });
                      };
                      return (
                        <motion.button
                          key={j}
                          type="button"
                          aria-label={describe(i, j)}
                          onMouseEnter={(e) => show(e.currentTarget)}
                          onFocus={(e) => show(e.currentTarget)}
                          onBlur={() => setHover(null)}
                          initial={reduce ? false : { opacity: 0, scale: 0.9 }}
                          whileInView={{ opacity: 1, scale: 1 }}
                          viewport={{ once: true, amount: 0.1 }}
                          transition={{ duration: 0.35, ease: "easeOut", delay: delayFor(i, j) }}
                          className={cx(
                            "num relative flex aspect-square items-center justify-center rounded-[4px] text-base sm:text-lg",
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

          <p className="mt-3 text-base text-ink-3">
            Hover or focus a cell for details. Cells with a white outline and bold count are correct
            predictions.
          </p>

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-base text-ink-2">
            <span>0</span>
            <span
              aria-hidden
              className="h-3 w-48 rounded-[3px] border border-line"
              style={{ background: LEGEND_GRADIENT }}
            />
            <span className="num">{fmtInt(max)} tickets</span>
            <span className="text-ink-3">Colour scale is square-root so small confusions stay visible.</span>
          </div>

          {hover && tip ? (
            <div
              role="status"
              className="pointer-events-none fixed z-50 rounded-md border border-line-strong bg-surface-2 px-3.5 py-2.5 text-base shadow-lg"
              style={{
                left: tip.left,
                top: tip.top,
                width: tip.w,
                transform: tip.above ? "translateY(-100%)" : undefined,
              }}
            >
              <p className="font-semibold text-ink">
                True {names[hover.i]} <span aria-hidden>→</span> predicted {names[hover.j]}
              </p>
              <p className="num text-ink-2">
                <strong className="text-ink">{fmtInt(matrix[hover.i]?.[hover.j] ?? 0)}</strong>{" "}
                {(matrix[hover.i]?.[hover.j] ?? 0) === 1 ? "ticket" : "tickets"},{" "}
                {fmtPct(rowTotals[hover.i] > 0 ? (matrix[hover.i]?.[hover.j] ?? 0) / rowTotals[hover.i] : 0, 1)} of
                the {fmtInt(rowTotals[hover.i])} true {names[hover.i]} tickets
              </p>
              <p className="text-ink-3">{hover.i === hover.j ? "Correct prediction" : "Misclassified"}</p>
            </div>
          ) : null}
        </>
      )}
    </Card>
  );
}

/** Fragment wrapper so each matrix row keeps a stable key inside the CSS grid. */
function RowCells({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
