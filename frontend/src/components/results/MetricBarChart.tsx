"use client";

import { useReducedMotion } from "motion/react";
import { useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from "recharts";
import { Card } from "@/components/ui";
import { AXIS_LINE, AXIS_TEXT, GRID, MUTED_TEXT, TooltipShell, wrapLabel, type AxisTickProps } from "./chart-parts";
import { METRICS, baseRow, type MetricDef, type MetricKey, type ModelRow } from "./model-meta";
import { Segmented } from "./Segmented";
import { useNarrow } from "./useNarrow";

interface Datum {
  name: string;
  label: string;
  value: number;
  color: string;
  row: ModelRow;
}

/** Round a max up to 1 / 2 / 2.5 / 5 x 10^k so the value axis ends on a clean number. */
function niceCeil(x: number): number {
  if (!(x > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  for (const m of [1, 2, 2.5, 5, 10]) if (x <= m * p) return m * p;
  return 10 * p;
}

function ModelTick({ x = 0, y = 0, payload, rows }: AxisTickProps & { rows: ModelRow[] }) {
  const name = String(payload?.value ?? "");
  const row = rows.find((r) => r.model.name === name);
  const px = Number(x);
  const py = Number(y);
  const label = row?.label ?? name;
  const tagLines = row ? wrapLabel(row.tag, 15, 2) : [];
  return (
    <g>
      <title>{row ? `${label}: ${row.tag}` : name}</title>
      {row ? <circle cx={px - 6} cy={py} r={6} fill={row.color} /> : null}
      <text
        x={px - 20}
        y={py}
        textAnchor="end"
        style={{ fill: AXIS_TEXT, fontSize: 17, fontWeight: row?.isCurrent ? 700 : 500 }}
      >
        <tspan x={px - 20} dy={row ? (tagLines.length > 1 ? "-0.9em" : "-0.2em") : "0.35em"}>
          {label}
        </tspan>
        {tagLines.map((l, i) => (
          <tspan key={i} x={px - 20} dy="1.25em" style={{ fill: MUTED_TEXT, fontSize: 16, fontWeight: 400 }}>
            {l}
          </tspan>
        ))}
      </text>
    </g>
  );
}

function MetricTooltip({
  active,
  payload,
  metric,
  rows,
}: Partial<TooltipContentProps> & { metric: MetricDef; rows: ModelRow[] }) {
  if (!active || !payload || payload.length === 0) return null;
  const d = payload[0].payload as Datum;
  const base = baseRow(rows);
  const delta = base && d.row.kind !== "base" ? metric.delta(d.value, base.model[metric.key]) : null;
  return (
    <TooltipShell title={d.label}>
      <p className="text-ink-2">{d.row.tag}</p>
      <p className="text-ink-3">{d.row.role}</p>
      <p className="mt-1 text-ink">
        {metric.label}: <strong className="num">{metric.format(d.value)}</strong>
      </p>
      {delta && base ? (
        <p className="num text-ink-2">
          {delta} vs {base.label.toLowerCase()}
        </p>
      ) : null}
      {d.row.reason ? <p className="mt-1 text-ink-3">{d.row.reason}</p> : null}
    </TooltipShell>
  );
}

export function MetricBarChart({ rows }: { rows: ModelRow[] }) {
  const reduce = useReducedMotion();
  const narrow = useNarrow();
  const [metricKey, setMetricKey] = useState<MetricKey>("category_macro_f1");
  const metric = METRICS.find((m) => m.key === metricKey) ?? METRICS[0];

  const data: Datum[] = rows.map((r) => ({
    name: r.model.name,
    label: r.label,
    value: r.model[metric.key],
    color: r.color,
    row: r,
  }));
  const allZero = data.length > 0 && data.every((d) => d.value === 0);
  const max = Math.max(0, ...data.map((d) => d.value));
  const domainMax = metric.isPct ? 1 : niceCeil(max);
  const height = rows.length * 62 + 56;

  return (
    <Card
      title="Quality, speed and cost by model"
      action={metric.higherBetter ? "Longer bar is better" : "Shorter bar is better"}
    >
      <Segmented
        label="Metric"
        options={METRICS.map((m) => ({ value: m.key, label: m.label }))}
        value={metricKey}
        onChange={setMetricKey}
        className="mb-4"
      />

      <ul className="mb-3 flex flex-wrap gap-x-5 gap-y-1.5 text-base text-ink-2" aria-label="Legend">
        {rows.map((r) => (
          <li key={r.model.name} className="flex items-center gap-2">
            <span aria-hidden className="size-3 rounded-sm" style={{ background: r.color }} />
            {r.label}
            <span className="text-ink-3">({r.tag.toLowerCase()})</span>
          </li>
        ))}
      </ul>

      <div
        role="figure"
        aria-label={`${metric.label} per model. Exact values are in the comparison table above.`}
        style={{ height }}
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            key={metric.key}
            data={data}
            layout="vertical"
            margin={{ top: 4, right: narrow ? 64 : 90, bottom: 4, left: 0 }}
            barCategoryGap="28%"
            style={{ overflow: "visible" }}
          >
            <CartesianGrid horizontal={false} stroke={GRID} strokeWidth={1} />
            <XAxis
              type="number"
              domain={[0, domainMax]}
              tickFormatter={metric.tick}
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tick={{ fill: AXIS_TEXT, fontSize: 16 }}
              interval="preserveStartEnd"
            />
            <YAxis
              type="category"
              dataKey="name"
              width={narrow ? 150 : 230}
              tickLine={false}
              axisLine={{ stroke: AXIS_LINE }}
              interval={0}
              tick={<ModelTick rows={rows} />}
            />
            <Tooltip
              cursor={{ fill: "rgba(242,240,234,0.05)" }}
              content={(p: TooltipContentProps) => <MetricTooltip {...p} metric={metric} rows={rows} />}
              isAnimationActive={false}
            />
            <Bar
              dataKey="value"
              maxBarSize={26}
              radius={[0, 4, 4, 0]}
              isAnimationActive={!reduce}
              animationDuration={800}
              animationEasing="ease-out"
            >
              {data.map((d) => (
                <Cell key={d.name} fill={d.color} />
              ))}
              <LabelList
                dataKey="value"
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
                      x={x + Math.max(0, width) + 10}
                      y={y + h / 2}
                      dy="0.35em"
                      style={{ fill: "var(--text)", fontSize: narrow ? 16 : 18, fontWeight: 600 }}
                    >
                      {metric.format(value)}
                    </text>
                  );
                }}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-2 text-base text-ink-3">
        Grey is the base model; blue shades are the training rounds, lighter = earlier, darker = later.
        Colour marks the round, not how well it did; the status next to each name says whether it was
        promoted. Metrics are shown one at a time because they use different units.
        {allZero ? ` Every model scores ${metric.format(0)} on this metric, so there are no bars to compare.` : ""}
      </p>
    </Card>
  );
}
