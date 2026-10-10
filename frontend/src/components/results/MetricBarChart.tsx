"use client";

import { useReducedMotion } from "motion/react";
import { useMemo, useState } from "react";
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
import { fmtDelta } from "@/lib/format";
import type { EvalCompare } from "@/lib/types";
import {
  AXIS_LINE,
  AXIS_TEXT,
  GRID,
  TooltipShell,
  wrapLabel,
  type AxisTickProps,
} from "./chart-parts";
import { METRICS, buildRows, type MetricDef, type MetricKey, type ModelRow } from "./model-meta";
import { Segmented } from "./Segmented";
import { useNarrow } from "./useNarrow";

interface Datum {
  name: string;
  value: number;
  color: string;
  kind: ModelRow["kind"];
  role: string;
}

/** Round a max up to 1 / 2 / 2.5 / 5 x 10^k so the value axis ends on a clean number. */
function niceCeil(x: number): number {
  if (!(x > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  for (const m of [1, 2, 2.5, 5, 10]) if (x <= m * p) return m * p;
  return 10 * p;
}

function ModelTick({
  x = 0,
  y = 0,
  payload,
  rows,
  narrow,
}: AxisTickProps & { rows: ModelRow[]; narrow: boolean }) {
  const name = String(payload?.value ?? "");
  const row = rows.find((r) => r.model.name === name);
  const lines = wrapLabel(name, narrow ? 12 : 22, 2);
  const px = Number(x);
  const py = Number(y);
  const headline = row?.kind === "router";
  return (
    <g>
      <title>{name}</title>
      {row ? <circle cx={px - 6} cy={py} r={5} fill={row.color} /> : null}
      <text
        x={px - 18}
        y={py}
        textAnchor="end"
        style={{ fill: AXIS_TEXT, fontSize: narrow ? 14 : 16, fontWeight: headline ? 700 : 400 }}
      >
        {lines.map((l, i) => (
          <tspan key={i} x={px - 18} dy={i === 0 ? (lines.length > 1 ? "-0.35em" : "0.35em") : "1.15em"}>
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
  const base = rows.find((r) => r.kind === "base");
  const showDelta = metric.isPct && base && d.kind !== "base";
  return (
    <TooltipShell title={d.name}>
      <p className="text-ink-3">{d.role}</p>
      <p className="mt-1 text-ink">
        {metric.label}: <strong className="num">{metric.format(d.value)}</strong>
      </p>
      {showDelta ? (
        <p className="num text-ink-2">
          {fmtDelta((d.value - base.model[metric.key]) * 100)} vs {base.model.name}
        </p>
      ) : null}
    </TooltipShell>
  );
}

export function MetricBarChart({ evalCompare }: { evalCompare: EvalCompare }) {
  const reduce = useReducedMotion();
  const narrow = useNarrow();
  const [metricKey, setMetricKey] = useState<MetricKey>("category_acc");
  const metric = METRICS.find((m) => m.key === metricKey) ?? METRICS[0];
  const rows = useMemo(() => buildRows(evalCompare), [evalCompare]);

  const data: Datum[] = rows.map((r) => ({
    name: r.model.name,
    value: r.model[metric.key],
    color: r.color,
    kind: r.kind,
    role: r.role,
  }));
  const max = Math.max(0, ...data.map((d) => d.value));
  const domainMax = metric.isPct ? 1 : niceCeil(max);
  const height = rows.length * 50 + 56;

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
            {r.model.name}
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
            margin={{ top: 4, right: narrow ? 56 : 84, bottom: 4, left: 0 }}
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
              tick={{ fill: AXIS_TEXT, fontSize: 14 }}
              interval="preserveStartEnd"
            />
            <YAxis
              type="category"
              dataKey="name"
              width={narrow ? 120 : 220}
              tickLine={false}
              axisLine={{ stroke: AXIS_LINE }}
              interval={0}
              tick={<ModelTick rows={rows} narrow={narrow} />}
            />
            <Tooltip
              cursor={{ fill: "rgba(242,240,234,0.05)" }}
              content={(p: TooltipContentProps) => <MetricTooltip {...p} metric={metric} rows={rows} />}
              isAnimationActive={false}
            />
            <Bar
              dataKey="value"
              maxBarSize={24}
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
                      style={{ fill: "var(--text)", fontSize: narrow ? 14 : 17, fontWeight: 600 }}
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
      <p className="mt-2 text-sm text-ink-3">
        Blue shades are the trained versions, lighter = older, darker = newer. Latency and cost are
        shown one at a time because they use different units.
      </p>
    </Card>
  );
}
