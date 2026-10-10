"use client";

import { useReducedMotion } from "motion/react";
import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from "recharts";
import { Card, cx } from "@/components/ui";
import { categoryLabel, categoryOrder } from "@/lib/categories";
import { fmtDelta, fmtInt, fmtPct } from "@/lib/format";
import type { EvalCompare } from "@/lib/types";
import {
  AXIS_LINE,
  AXIS_TEXT,
  GRID,
  TooltipShell,
  wrapLabel,
  type AxisTickProps,
} from "./chart-parts";
import { baseRow, currentRow, type ModelRow } from "./model-meta";
import { useNarrow } from "./useNarrow";

function CategoryTick({ x = 0, y = 0, payload, narrow }: AxisTickProps & { narrow: boolean }) {
  const name = String(payload?.value ?? "");
  const lines = wrapLabel(name, narrow ? 13 : 24, 2);
  const px = Number(x);
  const py = Number(y);
  return (
    <g>
      <title>{name}</title>
      <text x={px - 10} y={py} textAnchor="end" style={{ fill: AXIS_TEXT, fontSize: 16 }}>
        {lines.map((l, i) => (
          <tspan key={i} x={px - 10} dy={i === 0 ? (lines.length > 1 ? "-0.35em" : "0.35em") : "1.15em"}>
            {l}
          </tspan>
        ))}
      </text>
    </g>
  );
}

/** One row of chart data: category display label plus one F1 value per model name. */
type Datum = { key: string; category: string } & Record<string, number | string | undefined>;

function F1Tooltip({
  active,
  payload,
  series,
}: Partial<TooltipContentProps> & { series: ModelRow[] }) {
  if (!active || !payload || payload.length === 0) return null;
  const d = payload[0].payload as Datum;
  return (
    <TooltipShell title={d.category}>
      <ul className="space-y-1">
        {series.map((s) => {
          const v = d[s.model.name];
          return (
            <li key={s.model.name} className="flex items-center gap-2.5 text-ink-2">
              <span aria-hidden className="size-3 flex-none rounded-sm" style={{ background: s.color }} />
              <span className="flex-1">
                {s.label}
                <span className="text-ink-3"> ({s.tag.toLowerCase()})</span>
              </span>
              <strong className="num text-ink">{typeof v === "number" ? fmtPct(v, 1) : "–"}</strong>
            </li>
          );
        })}
      </ul>
    </TooltipShell>
  );
}

export function CategoryF1Chart({ evalCompare, rows }: { evalCompare: EvalCompare; rows: ModelRow[] }) {
  const reduce = useReducedMotion();
  const narrow = useNarrow();
  const [asTable, setAsTable] = useState(false);
  const [picked, setPicked] = useState<string[] | null>(null);

  const per = evalCompare.per_category_f1;
  /** Models that actually have per-category scores; the rest cannot be drawn. */
  const available = useMemo(() => rows.filter((r) => per[r.model.name]), [rows, per]);
  const cats = useMemo(() => categoryOrder(evalCompare), [evalCompare]);

  // Default: the base and the model in use. The reader can add any other model.
  const defaults = useMemo(() => {
    const names = new Set<string>();
    const b = baseRow(available);
    const c = currentRow(available);
    if (b) names.add(b.model.name);
    if (c) names.add(c.model.name);
    if (names.size === 0 && available[0]) names.add(available[0].model.name);
    return names;
  }, [available]);

  const selected = useMemo(() => {
    const valid = picked ? picked.filter((n) => available.some((r) => r.model.name === n)) : [];
    const set = valid.length > 0 ? new Set(valid) : defaults;
    return available.filter((r) => set.has(r.model.name));
  }, [picked, available, defaults]);

  const data: Datum[] = useMemo(
    () =>
      cats.map((c) => {
        const row: Datum = { key: c, category: categoryLabel(c) };
        for (const r of selected) row[r.model.name] = per[r.model.name]?.[c];
        return row;
      }),
    [cats, selected, per],
  );

  const callouts = useMemo(() => {
    const out: string[] = [];
    const b = baseRow(available);
    const cur = currentRow(available);
    if (b && cur && b !== cur) {
      let bestC = "";
      let bestGain = -Infinity;
      for (const c of cats) {
        const bv = per[b.model.name]?.[c];
        const cv = per[cur.model.name]?.[c];
        if (typeof bv === "number" && typeof cv === "number" && (cv - bv) * 100 > bestGain) {
          bestGain = (cv - bv) * 100;
          bestC = c;
        }
      }
      if (bestC) {
        out.push(
          bestGain > 0
            ? `Biggest gain: ${categoryLabel(bestC)}, ${fmtDelta(bestGain)} from ${b.label.toLowerCase()} to ${cur.label.toLowerCase()} (${fmtPct(
                per[b.model.name][bestC],
                1,
              )} to ${fmtPct(per[cur.model.name][bestC], 1)} F1).`
            : `No category has improved over ${b.label.toLowerCase()}.`,
        );
      }
    }
    if (cur) {
      let weakC = "";
      let weak = Infinity;
      for (const c of cats) {
        const v = per[cur.model.name]?.[c];
        if (typeof v === "number" && v < weak) {
          weak = v;
          weakC = c;
        }
      }
      if (weakC) {
        out.push(`Weakest category for ${cur.label.toLowerCase()}: ${categoryLabel(weakC)} at ${fmtPct(weak, 1)} F1.`);
      }
    }
    return out;
  }, [available, cats, per]);

  // How many test tickets each category has (true-class row totals of the confusion matrix).
  const supportNote = useMemo(() => {
    const lead = selected[selected.length - 1];
    const m = lead ? evalCompare.confusion[lead.model.name] : undefined;
    if (!m || m.length === 0) return "";
    const totals = m.map((r) => r.reduce((a, b) => a + b, 0)).filter((t) => t > 0);
    if (totals.length === 0) return "";
    const lo = Math.min(...totals);
    const hi = Math.max(...totals);
    return `Each category has ${lo === hi ? fmtInt(lo) : `${fmtInt(lo)} to ${fmtInt(hi)}`} test tickets, so one or two tickets can move a category's F1 noticeably.`;
  }, [selected, evalCompare.confusion]);

  if (available.length === 0 || data.length === 0 || selected.length === 0) return null;

  const toggle = (name: string) => {
    const cur = new Set(selected.map((r) => r.model.name));
    if (cur.has(name)) {
      if (cur.size === 1) return; // keep at least one series
      cur.delete(name);
    } else {
      cur.add(name);
    }
    setPicked(available.filter((r) => cur.has(r.model.name)).map((r) => r.model.name));
  };

  const storyName = (currentRow(selected) ?? selected[selected.length - 1]).model.name;

  // Horizontal grouped bars: category names are long and every model shares one 0-100% axis.
  const barSize = selected.length > 2 ? 14 : 20;
  const groupH = selected.length * barSize + (selected.length - 1) * 2 + (narrow ? 30 : 36);
  const height = data.length * groupH + 48;

  return (
    <Card
      title="F1 by ticket category"
      action={
        <button
          type="button"
          onClick={() => setAsTable((v) => !v)}
          aria-pressed={asTable}
          className="min-h-10 rounded-md border border-line px-3 text-base text-ink-2 hover:border-line-strong hover:text-ink"
        >
          {asTable ? "Show as chart" : "Show as table"}
        </button>
      }
    >
      <div role="group" aria-label="Models to show" className="mb-3 flex flex-wrap gap-1.5">
        {available.map((r) => {
          const on = selected.some((s) => s.model.name === r.model.name);
          return (
            <button
              key={r.model.name}
              type="button"
              aria-pressed={on}
              onClick={() => toggle(r.model.name)}
              className={cx(
                "inline-flex min-h-10 items-center gap-2 rounded-md border px-3 text-base transition-colors",
                on
                  ? "border-ink-3 bg-surface-3 font-semibold text-ink"
                  : "border-line text-ink-2 hover:border-line-strong hover:bg-surface-2 hover:text-ink",
              )}
            >
              <span
                aria-hidden
                className={cx("size-3 rounded-sm", !on && "opacity-50")}
                style={{ background: r.color }}
              />
              {r.label}
              <span className={cx("font-normal", on ? "text-ink-2" : "text-ink-3")}>{r.tag.toLowerCase()}</span>
            </button>
          );
        })}
      </div>

      {callouts.length > 0 ? (
        <div className="mb-4 space-y-1 rounded-md border border-line bg-surface-2 px-4 py-3 text-lg text-ink">
          {callouts.map((c, i) => (
            <p key={i} className={cx(i > 0 && "text-base text-ink-2")}>
              {c}
            </p>
          ))}
        </div>
      ) : null}

      {asTable ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[30rem] border-separate border-spacing-0 text-left">
            <caption className="sr-only">F1 score per ticket category for each selected model.</caption>
            <thead>
              <tr>
                <th scope="col" className="px-3 py-2 text-base font-medium text-ink-3">
                  Category
                </th>
                {selected.map((s) => (
                  <th key={s.model.name} scope="col" className="px-3 py-2 text-right text-base font-medium text-ink-3">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.key}>
                  <th scope="row" className="border-t border-line px-3 py-2.5 text-left font-normal text-ink">
                    {d.category}
                  </th>
                  {selected.map((s) => {
                    const v = d[s.model.name];
                    return (
                      <td key={s.model.name} className="num border-t border-line px-3 py-2.5 text-right text-ink-2">
                        {typeof v === "number" ? fmtPct(v, 1) : "–"}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div
          role="figure"
          aria-label={`F1 per ticket category for ${selected.map((s) => s.label).join(", ")}. Use Show as table for exact values.`}
          style={{ height }}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={data}
              layout="vertical"
              margin={{ top: 4, right: narrow ? 48 : 64, bottom: 4, left: 0 }}
              barCategoryGap="22%"
              barGap={2}
              style={{ overflow: "visible" }}
            >
              <CartesianGrid horizontal={false} stroke={GRID} strokeWidth={1} />
              <XAxis
                type="number"
                domain={[0, 1]}
                ticks={[0, 0.25, 0.5, 0.75, 1]}
                tickFormatter={(v: number) => fmtPct(v, 0)}
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                tick={{ fill: AXIS_TEXT, fontSize: 16 }}
              />
              <YAxis
                type="category"
                dataKey="category"
                width={narrow ? 120 : 210}
                tickLine={false}
                axisLine={{ stroke: AXIS_LINE }}
                interval={0}
                tick={<CategoryTick narrow={narrow} />}
              />
              <Tooltip
                cursor={{ fill: "rgba(242,240,234,0.05)" }}
                content={(p: TooltipContentProps) => <F1Tooltip {...p} series={selected} />}
                isAnimationActive={false}
              />
              {selected.map((s, i) => (
                <Bar
                  key={s.model.name}
                  dataKey={s.model.name}
                  name={s.label}
                  fill={s.color}
                  maxBarSize={barSize}
                  radius={[0, 4, 4, 0]}
                  isAnimationActive={!reduce}
                  animationDuration={800}
                  animationBegin={i * 120}
                  animationEasing="ease-out"
                >
                  {/* Only the story series (the model in use) is labelled; the rest live in the tooltip / table. */}
                  {s.model.name === storyName ? (
                    <LabelList
                      dataKey={s.model.name}
                      content={(p) => {
                        const { x, y, width, height: h, value } = p as unknown as {
                          x: number;
                          y: number;
                          width: number;
                          height: number;
                          value: number;
                        };
                        if (!Number.isFinite(value)) return null;
                        return (
                          <text
                            x={x + Math.max(0, width) + 8}
                            y={y + h / 2}
                            dy="0.35em"
                            style={{ fill: "var(--text)", fontSize: 16, fontWeight: 600 }}
                          >
                            {fmtPct(value, 0)}
                          </text>
                        );
                      }}
                    />
                  ) : null}
                </Bar>
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
      {supportNote ? <p className="mt-3 text-base text-ink-3">{supportNote}</p> : null}
    </Card>
  );
}
