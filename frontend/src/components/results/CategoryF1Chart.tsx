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
import { fmtDelta, fmtPct } from "@/lib/format";
import type { EvalCompare } from "@/lib/types";
import {
  AXIS_LINE,
  AXIS_TEXT,
  GRID,
  TooltipShell,
  wrapLabel,
  type AxisTickProps,
} from "./chart-parts";
import { buildRows, latestTrained, type ModelRow } from "./model-meta";
import { useNarrow } from "./useNarrow";

interface Series {
  id: string;
  /** model name as in per_category_f1 */
  name: string;
  /** legend wording, e.g. "Latest trained (v2)" */
  label: string;
  color: string;
}

function CategoryTick({ x = 0, y = 0, payload, narrow }: AxisTickProps & { narrow: boolean }) {
  const name = String(payload?.value ?? "");
  const lines = wrapLabel(name, narrow ? 14 : 24, 2);
  const px = Number(x);
  const py = Number(y);
  return (
    <g>
      <title>{name}</title>
      <text x={px - 10} y={py} textAnchor="end" style={{ fill: AXIS_TEXT, fontSize: narrow ? 14 : 16 }}>
        {lines.map((l, i) => (
          <tspan key={i} x={px - 10} dy={i === 0 ? (lines.length > 1 ? "-0.35em" : "0.35em") : "1.15em"}>
            {l}
          </tspan>
        ))}
      </text>
    </g>
  );
}

type Datum = { category: string } & Record<string, number | string | undefined>;

function F1Tooltip({
  active,
  payload,
  series,
}: Partial<TooltipContentProps> & { series: Series[] }) {
  if (!active || !payload || payload.length === 0) return null;
  const d = payload[0].payload as Datum;
  return (
    <TooltipShell title={d.category}>
      <ul className="space-y-1">
        {series.map((s) => {
          const v = d[s.id];
          return (
            <li key={s.id} className="flex items-center gap-2.5 text-ink-2">
              <span aria-hidden className="size-3 flex-none rounded-sm" style={{ background: s.color }} />
              <span className="flex-1">{s.label}</span>
              <strong className="num text-ink">{typeof v === "number" ? fmtPct(v, 1) : "–"}</strong>
            </li>
          );
        })}
      </ul>
    </TooltipShell>
  );
}

export function CategoryF1Chart({ evalCompare }: { evalCompare: EvalCompare }) {
  const reduce = useReducedMotion();
  const narrow = useNarrow();
  const [asTable, setAsTable] = useState(false);

  const rows = useMemo(() => buildRows(evalCompare), [evalCompare]);
  const per = evalCompare.per_category_f1;

  const { series, data, callouts } = useMemo(() => {
    const base: ModelRow | undefined = rows.find((r) => r.kind === "base");
    const latest = latestTrained(rows);
    const teacher: ModelRow | undefined = rows.find((r) => r.kind === "teacher");

    const s: Series[] = [];
    const add = (r: ModelRow | undefined, id: string, label: string) => {
      if (r && per[r.model.name]) s.push({ id, name: r.model.name, label, color: r.color });
    };
    add(base, "base", `${base?.model.name ?? "Base"} (before training)`);
    add(latest, "latest", `${latest?.model.name ?? "Latest"} (latest trained)`);
    add(teacher, "teacher", `${teacher?.model.name ?? "Teacher"} (cloud)`);

    // Category names come from the data itself, in the order the API sent them.
    const cats: string[] = [];
    for (const ser of s) for (const c of Object.keys(per[ser.name])) if (!cats.includes(c)) cats.push(c);

    const d: Datum[] = cats.map((c) => {
      const row: Datum = { category: c };
      for (const ser of s) row[ser.id] = per[ser.name]?.[c];
      return row;
    });

    // Callouts, computed from the data only.
    const out: string[] = [];
    const sb = s.find((x) => x.id === "base");
    const sl = s.find((x) => x.id === "latest");
    const st = s.find((x) => x.id === "teacher");
    if (sb && sl) {
      let bestC = "";
      let bestGain = -Infinity;
      for (const c of cats) {
        const b = per[sb.name]?.[c];
        const l = per[sl.name]?.[c];
        if (typeof b === "number" && typeof l === "number" && (l - b) * 100 > bestGain) {
          bestGain = (l - b) * 100;
          bestC = c;
        }
      }
      if (bestC && bestGain > 0) {
        out.push(
          `Biggest improvement: ${bestC}, ${fmtDelta(bestGain)} from ${sb.name} to ${sl.name} (${fmtPct(
            per[sb.name][bestC],
            1,
          )} to ${fmtPct(per[sl.name][bestC], 1)} F1).`,
        );
      } else if (bestC) {
        out.push(`No category has improved over ${sb.name} yet.`);
      }
    }
    if (sl && st) {
      let gapC = "";
      let gap = 0;
      for (const c of cats) {
        const l = per[sl.name]?.[c];
        const t = per[st.name]?.[c];
        if (typeof l === "number" && typeof t === "number" && (t - l) * 100 > gap) {
          gap = (t - l) * 100;
          gapC = c;
        }
      }
      if (gapC) {
        out.push(`Largest remaining gap to the teacher: ${gapC}, ${fmtDelta(-gap)} (${sl.name} vs ${st.name}).`);
      }
    }
    return { series: s, data: d, callouts: out };
  }, [rows, per]);

  if (series.length === 0 || data.length === 0) return null;

  // Horizontal grouped bars (not 6 small multiples): category names are long, three series fit
  // one shared 0-100% axis, and the reader compares all three within a category at a glance.
  const groupH = series.length * 14 + (series.length - 1) * 2 + 30;
  const height = data.length * groupH + 48;

  return (
    <Card
      title="F1 by ticket category"
      action={
        <button
          type="button"
          onClick={() => setAsTable((v) => !v)}
          aria-pressed={asTable}
          className="min-h-9 rounded-md border border-line px-3 text-base text-ink-2 hover:border-line-strong hover:text-ink"
        >
          {asTable ? "Show as chart" : "Show as table"}
        </button>
      }
    >
      <ul className="mb-3 flex flex-wrap gap-x-5 gap-y-1.5 text-base text-ink-2" aria-label="Legend">
        {series.map((s) => (
          <li key={s.id} className="flex items-center gap-2">
            <span aria-hidden className="size-3 rounded-sm" style={{ background: s.color }} />
            {s.label}
          </li>
        ))}
      </ul>

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
          <table className="w-full min-w-[34rem] border-separate border-spacing-0 text-left">
            <caption className="sr-only">F1 score per ticket category for each compared model.</caption>
            <thead>
              <tr>
                <th scope="col" className="px-3 py-2 text-base font-medium text-ink-3">
                  Category
                </th>
                {series.map((s) => (
                  <th key={s.id} scope="col" className="px-3 py-2 text-right text-base font-medium text-ink-3">
                    {s.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.category}>
                  <th scope="row" className="border-t border-line px-3 py-2.5 text-left font-normal text-ink">
                    {d.category}
                  </th>
                  {series.map((s) => {
                    const v = d[s.id];
                    return (
                      <td key={s.id} className="num border-t border-line px-3 py-2.5 text-right text-ink-2">
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
          aria-label="F1 per ticket category for the base model, the latest trained model and the teacher. Use Show as table for exact values."
          style={{ height }}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={data}
              layout="vertical"
              margin={{ top: 4, right: narrow ? 44 : 60, bottom: 4, left: 0 }}
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
                tick={{ fill: AXIS_TEXT, fontSize: 14 }}
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
                content={(p: TooltipContentProps) => <F1Tooltip {...p} series={series} />}
                isAnimationActive={false}
              />
              {series.map((s, i) => (
                <Bar
                  key={s.id}
                  dataKey={s.id}
                  name={s.label}
                  fill={s.color}
                  maxBarSize={14}
                  radius={[0, 4, 4, 0]}
                  isAnimationActive={!reduce}
                  animationDuration={800}
                  animationBegin={i * 120}
                  animationEasing="ease-out"
                >
                  {/* Only the story series (latest trained) is labelled; the rest live in the tooltip/table. */}
                  {s.id === "latest" ? (
                    <LabelList
                      dataKey={s.id}
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
                            style={{ fill: "var(--text)", fontSize: narrow ? 13 : 15, fontWeight: 600 }}
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
    </Card>
  );
}
