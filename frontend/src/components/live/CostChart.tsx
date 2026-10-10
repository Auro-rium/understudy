"use client";

import { useMemo } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  useCartesianScale,
  usePlotArea,
} from "recharts";
import { useStore } from "@/lib/store";
import { fmtTime, fmtUsd } from "@/lib/format";
import { Card, EmptyState } from "@/components/ui";
import { FillSwatch, LegendItem, LineSwatch, TipBox, TipRow, WINDOW, axisTime, useMinWidth } from "./chartBits";

interface Row {
  t: string;
  actual: number;
  cloud: number;
  gap: number;
}

const halo = {
  stroke: "var(--surface)",
  strokeWidth: 4,
  paintOrder: "stroke" as const,
};

/** Direct labels at the right edge plus "Saved $X" between the two lines. */
function EndLabels({ last, saved }: { last: Row; saved: number }) {
  const plot = usePlotArea();
  const a = useCartesianScale({ x: last.t, y: last.actual });
  const c = useCartesianScale({ x: last.t, y: last.cloud });
  if (!a || !c || !plot) return null;

  const wide = plot.width > 300;
  let yCloud = c.y;
  let yActual = a.y;
  if (yActual - yCloud < 22) {
    const mid = (yActual + yCloud) / 2;
    yCloud = mid - 11;
    yActual = mid + 11;
  }
  const gapPx = a.y - c.y;
  const savedY = gapPx > 26 ? (a.y + c.y) / 2 + 5 : c.y - 12;

  return (
    <g pointerEvents="none">
      {wide ? (
        <>
          <text x={c.x + 10} y={yCloud + 5} fontSize={15} fontWeight={600} fill="var(--text)" {...halo}>
            {`Cloud-only ${fmtUsd(last.cloud)}`}
          </text>
          <text x={a.x + 10} y={yActual + 5} fontSize={15} fontWeight={600} fill="var(--text)" {...halo}>
            {`Actual ${fmtUsd(last.actual)}`}
          </text>
        </>
      ) : null}
      <text x={a.x - 12} y={savedY} textAnchor="end" fontSize={17} fontWeight={700} fill="var(--text)" {...halo}>
        {`Saved ${fmtUsd(saved)}`}
      </text>
    </g>
  );
}

interface TipProps {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: Row }>;
}

function CostTip({ active, payload }: TipProps) {
  const p = payload?.[0]?.payload;
  if (!active || !p) return null;
  return (
    <TipBox time={fmtTime(p.t)}>
      <TipRow swatch={<LineSwatch color="var(--local)" />} label="Actual cost" value={fmtUsd(p.actual)} />
      <TipRow swatch={<LineSwatch color="var(--teacher)" />} label="Cloud-only cost" value={fmtUsd(p.cloud)} />
      <TipRow swatch={<FillSwatch color="var(--good)" />} label="Saved" value={fmtUsd(p.gap)} />
    </TipBox>
  );
}

export function CostChart() {
  const { state } = useStore();
  const saved = state.summary?.cost_avoided_usd ?? 0;
  const roomy = useMinWidth(560);

  const data = useMemo<Row[]>(
    () =>
      state.timeseries.slice(-WINDOW).map((p) => ({
        t: p.t,
        actual: p.cost_cumulative,
        cloud: p.cost_cloud_only_cumulative,
        gap: Math.max(0, p.cost_cloud_only_cumulative - p.cost_cumulative),
      })),
    [state.timeseries],
  );
  const last = data[data.length - 1];

  return (
    <Card title="Cost: actual vs cloud-only">
      <p className="-mt-2 mb-3 text-base text-ink-3">
        Cumulative spend. The green gap is what the local model saved.
      </p>
      <div className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-1" aria-label="Legend">
        <LegendItem swatch={<LineSwatch color="var(--local)" />} label="Actual cost" />
        <LegendItem swatch={<LineSwatch color="var(--teacher)" />} label="Cloud-only cost" />
        <LegendItem swatch={<FillSwatch color="var(--good)" />} label="Saved" />
      </div>
      {data.length < 2 || !last ? (
        <EmptyState title="No cost data yet" hint="Costs accumulate as tickets are routed." />
      ) : (
        <div className="h-72 w-full sm:h-80" role="img" aria-label="Cumulative actual cost versus cloud-only cost">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 8, right: roomy ? 150 : 12, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--line)" strokeDasharray="2 4" />
              <XAxis
                dataKey="t"
                tickFormatter={axisTime}
                tick={{ fontSize: 14, fill: "var(--text-3)" }}
                tickLine={false}
                axisLine={{ stroke: "var(--line-strong)" }}
                minTickGap={64}
              />
              <YAxis
                domain={[0, "auto"]}
                tickCount={5}
                tickFormatter={(v: number) => fmtUsd(v)}
                tick={{ fontSize: 14, fill: "var(--text-3)" }}
                tickLine={false}
                axisLine={false}
                width={64}
              />
              <Tooltip content={CostTip} cursor={{ stroke: "var(--text-3)", strokeWidth: 1 }} isAnimationActive={false} />
              {/* invisible base + visible gap stacked on top = the filled band between the lines */}
              <Area
                type="monotone"
                dataKey="actual"
                stackId="band"
                stroke="none"
                fill="none"
                legendType="none"
                tooltipType="none"
                activeDot={false}
                isAnimationActive={false}
              />
              <Area
                type="monotone"
                dataKey="gap"
                stackId="band"
                stroke="none"
                fill="var(--good)"
                fillOpacity={0.24}
                legendType="none"
                tooltipType="none"
                activeDot={false}
                isAnimationActive
                animationDuration={600}
              />
              <Line
                type="monotone"
                dataKey="cloud"
                stroke="var(--teacher)"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 5, fill: "var(--teacher)", stroke: "var(--surface)", strokeWidth: 2 }}
                isAnimationActive
                animationDuration={600}
              />
              <Line
                type="monotone"
                dataKey="actual"
                stroke="var(--local)"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 5, fill: "var(--local)", stroke: "var(--surface)", strokeWidth: 2 }}
                isAnimationActive
                animationDuration={600}
              />
              <EndLabels last={last} saved={saved} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}
