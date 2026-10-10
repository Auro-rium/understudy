"use client";

import { useInView, useReducedMotion } from "motion/react";
import { useRef } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { LossPoint } from "@/lib/types";

const LINE = "#3987e5";
const AXIS = { fontSize: 16, fill: "#8d92a8" } as const;

interface LossChartProps {
  data: LossPoint[];
  /** "draw": mounts when scrolled into view and draws itself once. "live": grows with data, no tween. */
  mode: "draw" | "live";
  /** fixed x-axis end (live mode: total steps) */
  xMax?: number;
  /** shared y-axis ceiling so charts of different rounds are comparable */
  yMax?: number;
  height?: number;
}

export function LossChart({ data, mode, xMax, yMax, height = 240 }: LossChartProps) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "0px 0px -10% 0px" });
  const reduce = useReducedMotion();
  const show = mode === "live" || inView;
  const animate = mode === "draw" && !reduce;

  return (
    <div
      ref={ref}
      style={{ height }}
      role="img"
      aria-label={
        data.length
          ? `Training loss over ${data.length} recorded points, step ${data[0].step} to step ${data[data.length - 1].step}, from ${data[0].loss.toFixed(2)} to ${data[data.length - 1].loss.toFixed(2)}`
          : "Training loss, waiting for the first step"
      }
    >
      {show ? (
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
            <CartesianGrid stroke="#262b3b" strokeOpacity={0.7} vertical={false} />
            <XAxis
              dataKey="step"
              type="number"
              domain={[0, xMax ?? "dataMax"]}
              tick={AXIS}
              tickLine={false}
              axisLine={{ stroke: "#353c52", strokeWidth: 1 }}
              height={32}
              label={{ value: "training step", position: "insideBottomRight", offset: -2, style: AXIS }}
            />
            <YAxis
              domain={[0, yMax ?? "auto"]}
              tick={AXIS}
              tickLine={false}
              axisLine={false}
              width={44}
              tickFormatter={(v: number) => v.toFixed(1)}
            />
            <Tooltip
              cursor={{ stroke: "#353c52" }}
              contentStyle={{
                background: "#181c29",
                border: "1px solid #353c52",
                borderRadius: 8,
                fontSize: 16,
                color: "#f2f0ea",
              }}
              labelStyle={{ color: "#bcc0d0" }}
              itemStyle={{ color: "#f2f0ea" }}
              labelFormatter={(step) => `Step ${String(step)}`}
              formatter={(v) => [typeof v === "number" ? v.toFixed(3) : String(v), "Loss"]}
            />
            <Line
              type="linear"
              dataKey="loss"
              stroke={LINE}
              strokeWidth={2.25}
              dot={false}
              activeDot={{ r: 4, fill: LINE, stroke: "#0b0d14" }}
              isAnimationActive={animate}
              animationDuration={1200}
              animationEasing="ease-out"
            />
          </LineChart>
        </ResponsiveContainer>
      ) : null}
    </div>
  );
}
