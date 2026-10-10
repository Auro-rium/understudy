"use client";

import { useId, useMemo } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  usePlotArea,
} from "recharts";
import { useStore } from "@/lib/store";
import { fmtPct, fmtTime } from "@/lib/format";
import { Card, EmptyState } from "@/components/ui";
import type { TimePoint } from "@/lib/types";
import { TipBox, TipRow, WINDOW, axisTime } from "./chartBits";

interface MarkerGroup {
  at: string;
  text: string;
  rejected: boolean;
}

function MarkerLabel({
  viewBox,
  text,
  rejected,
  row,
}: {
  viewBox?: unknown;
  text: string;
  rejected: boolean;
  row: number;
}) {
  const plot = usePlotArea();
  const vb = (viewBox ?? {}) as { x?: number; y?: number };
  const x = vb.x ?? 0;
  const y = (vb.y ?? 0) + 18 + row * 22;
  const flip = plot ? x > plot.x + plot.width - 120 : false;
  return (
    <text
      x={flip ? x - 8 : x + 8}
      y={y}
      textAnchor={flip ? "end" : "start"}
      fontSize={16}
      fontWeight={600}
      fill={rejected ? "var(--spot)" : "var(--text-2)"}
      stroke="var(--surface)"
      strokeWidth={4}
      paintOrder="stroke"
    >
      {text}
    </text>
  );
}

interface TipProps {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: TimePoint }>;
}

function ShareTip({ active, payload }: TipProps) {
  const p = payload?.[0]?.payload;
  if (!active || !p) return null;
  return (
    <TipBox time={fmtTime(p.t)}>
      <TipRow
        swatch={<span aria-hidden className="inline-block h-0.5 w-4 rounded-full bg-local" />}
        label="Handled locally"
        value={fmtPct(p.local_share, 1)}
      />
    </TipBox>
  );
}

export function ShareChart() {
  const { state } = useStore();
  const gid = useId().replace(/:/g, "");
  const data = useMemo(() => state.timeseries.slice(-WINDOW), [state.timeseries]);

  const markers = useMemo<MarkerGroup[]>(() => {
    const inWindow = new Set(data.map((d) => d.t));
    const by = new Map<string, MarkerGroup>();
    for (const m of state.roundMarkers) {
      if (!inWindow.has(m.at)) continue;
      const label = m.promoted ? m.version : "gate rejected";
      const g = by.get(m.at);
      if (g) {
        g.text = `${g.text} · ${label}`;
        g.rejected = g.rejected || !m.promoted;
      } else {
        by.set(m.at, { at: m.at, text: label, rejected: !m.promoted });
      }
    }
    return [...by.values()];
  }, [data, state.roundMarkers]);

  const latest = data[data.length - 1];

  return (
    <Card
      className="2xl:flex 2xl:min-h-0 2xl:flex-col"
      title="Local share over time"
      action={
        latest ? (
          <span className="num text-lg font-semibold text-ink">{fmtPct(latest.local_share, 1)} now</span>
        ) : null
      }
    >
      <p className="-mt-2 mb-3 text-base text-ink-3">
        <span className="2xl:hidden">Share of tickets the local model handled itself. </span>
        Dashed lines mark training rounds.
      </p>
      {data.length < 2 ? (
        <EmptyState title="No history yet" hint="The line draws itself once tickets start flowing." />
      ) : (
        <div className="h-72 w-full sm:h-80 2xl:h-auto 2xl:min-h-48 2xl:flex-1" role="img" aria-label="Line chart of local share over time">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id={`${gid}-fill`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--local)" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="var(--local)" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke="var(--line)" strokeDasharray="2 4" />
              <XAxis
                dataKey="t"
                tickFormatter={axisTime}
                tick={{ fontSize: 16, fill: "var(--text-3)" }}
                tickLine={false}
                axisLine={{ stroke: "var(--line-strong)" }}
                minTickGap={64}
              />
              <YAxis
                domain={[0, 1]}
                ticks={[0, 0.25, 0.5, 0.75, 1]}
                tickFormatter={(v: number) => fmtPct(v)}
                tick={{ fontSize: 16, fill: "var(--text-3)" }}
                tickLine={false}
                axisLine={false}
                width={48}
              />
              <Tooltip
                content={ShareTip}
                cursor={{ stroke: "var(--text-3)", strokeWidth: 1 }}
                isAnimationActive={false}
              />
              {markers.map((m, i) => (
                <ReferenceLine
                  key={m.at}
                  x={m.at}
                  stroke={m.rejected ? "var(--spot)" : "var(--text-3)"}
                  strokeWidth={1.5}
                  strokeDasharray={m.rejected ? "2 5" : "6 4"}
                  ifOverflow="hidden"
                  label={{
                    content: (p: { viewBox?: unknown }) => (
                      <MarkerLabel viewBox={p.viewBox} text={m.text} rejected={m.rejected} row={i % 2} />
                    ),
                  }}
                />
              ))}
              <Area
                type="monotone"
                dataKey="local_share"
                stroke="var(--local)"
                strokeWidth={2}
                fill={`url(#${gid}-fill)`}
                dot={false}
                activeDot={{ r: 5, fill: "var(--local)", stroke: "var(--surface)", strokeWidth: 2 }}
                isAnimationActive
                animationDuration={600}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}
