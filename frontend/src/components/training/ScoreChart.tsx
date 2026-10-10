"use client";

import { useNarrow } from "@/components/results/useNarrow";
import { useInView, useReducedMotion } from "motion/react";
import { useRef } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, ProvisionalBadge, cx } from "@/components/ui";
import { fmtPct } from "@/lib/format";
import { useStore } from "@/lib/store";

const PROMOTED = "#3987e5"; // --local
const REJECTED = "#f2c14e"; // --spot
const INK = "#f2f0ea";
const INK_3 = "#8d92a8";
const SURFACE = "#12151f";

type Status = "baseline" | "promoted" | "rejected";

interface Point {
  label: string;
  version: string;
  f1: number;
  status: Status;
  reason: string;
  /** the line of models that were actually promoted: base and promoted rounds only */
  promotedF1: number | null;
  rejectedF1: number | null;
}

const STATUS_TEXT: Record<Status, string> = {
  baseline: "Starting point",
  promoted: "Promoted",
  rejected: "Not promoted",
};

interface DotProps {
  cx?: number;
  cy?: number;
  index?: number;
  payload?: Point;
}

/** Filled circle = base / promoted. Hollow diamond + "Not promoted" text = rejected. */
function renderDot(kind: "promoted" | "rejected") {
  function Dot({ cx, cy, index, payload }: DotProps) {
    const k = `${kind}-${index ?? 0}`;
    if (cx == null || cy == null || !payload) return <g key={k} />;
    if (kind === "promoted" ? payload.promotedF1 == null : payload.rejectedF1 == null) return <g key={k} />;
    if (kind === "promoted") {
      return (
        <g key={k}>
          <circle cx={cx} cy={cy} r={7.5} fill={PROMOTED} stroke={SURFACE} strokeWidth={2} />
          <text x={cx} y={cy - 18} textAnchor="middle" fontSize={20} fontWeight={600} fill={INK} className="num">
            {fmtPct(payload.f1, 1)}
          </text>
        </g>
      );
    }
    const d = 9;
    return (
      <g key={k}>
        <path
          d={`M${cx} ${cy - d} L${cx + d} ${cy} L${cx} ${cy + d} L${cx - d} ${cy} Z`}
          fill={SURFACE}
          stroke={REJECTED}
          strokeWidth={3}
        />
        <text x={cx} y={cy + 34} textAnchor="middle" fontSize={20} fontWeight={600} fill={INK} className="num">
          {fmtPct(payload.f1, 1)}
        </text>
        <text x={cx} y={cy + 56} textAnchor="middle" fontSize={17} fontWeight={600} fill={REJECTED}>
          Not promoted
        </text>
      </g>
    );
  }
  return Dot;
}

const PromotedDot = renderDot("promoted");
const RejectedDot = renderDot("rejected");

function ScoreTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: Point }> }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="max-w-xs rounded-lg border border-line-strong bg-surface-2 px-3 py-2 text-base text-ink shadow-lg">
      <p className="font-semibold">
        {p.label} <span className="font-mono font-normal text-ink-2">{p.version}</span>
      </p>
      <p className="num">Macro-F1 {fmtPct(p.f1, 1)}</p>
      <p className={p.status === "rejected" ? "text-spot" : "text-ink-2"}>{STATUS_TEXT[p.status]}</p>
      {p.reason ? <p className="mt-1 text-ink-2">{p.reason}</p> : null}
    </div>
  );
}

/** Own component so the in-view ref is attached on first mount (the parent renders nothing until data arrives). */
function ScoreLine({ points, yMin, yMax }: { points: Point[]; yMin: number; yMax: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "0px 0px -10% 0px" });
  const reduce = useReducedMotion();
  const narrow = useNarrow();
  return (
    <div
      ref={ref}
      className="h-[22rem] sm:h-[26rem]"
      role="img"
      aria-label={`Macro-F1 for ${points
        .map((p) => `${p.label} ${fmtPct(p.f1, 1)}${p.status === "rejected" ? " not promoted" : ""}`)
        .join(", ")}`}
    >
      {inView ? (
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 34, right: narrow ? 12 : 28, bottom: 4, left: 0 }}>
            <CartesianGrid stroke="#262b3b" strokeOpacity={0.7} vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: narrow ? 16 : 17, fill: "#bcc0d0" }}
              tickLine={false}
              axisLine={{ stroke: "#353c52" }}
              padding={{ left: narrow ? 30 : 36, right: narrow ? 26 : 36 }}
              height={36}
            />
            <YAxis
              domain={[yMin, yMax]}
              tickCount={Math.round((yMax - yMin) * 10) + 1}
              tick={{ fontSize: 16, fill: INK_3 }}
              tickLine={false}
              axisLine={false}
              width={narrow ? 46 : 52}
              tickFormatter={(v: number) => fmtPct(v, 0)}
            />
            <Tooltip content={<ScoreTooltip />} cursor={{ stroke: "#353c52" }} />
            <Line
              dataKey="promotedF1"
              stroke={PROMOTED}
              strokeWidth={2.5}
              connectNulls
              dot={PromotedDot}
              activeDot={false}
              isAnimationActive={!reduce}
              animationDuration={1100}
              animationEasing="ease-out"
            />
            <Line
              dataKey="rejectedF1"
              stroke="none"
              dot={RejectedDot}
              activeDot={false}
              isAnimationActive={false}
              legendType="none"
            />
          </LineChart>
        </ResponsiveContainer>
      ) : null}
    </div>
  );
}

/** Macro-F1 of the base model and of each round's adapter, from the exported eval. */
export function ScoreChart() {
  const { state } = useStore();
  const { rounds, evalCompare } = state;
  const sorted = [...rounds].sort((a, b) => a.round - b.round);
  const base = evalCompare?.models.find((m) => m.name === "base") ?? null;
  const points: Point[] = [];
  if (base) {
    points.push({
      label: "Base",
      version: base.name,
      f1: base.category_macro_f1,
      status: "baseline",
      reason: "Scored before any training round.",
      promotedF1: base.category_macro_f1,
      rejectedF1: null,
    });
  }
  for (const r of sorted) {
    const f1 = r.eval.category_macro_f1;
    points.push({
      label: `Round ${r.round}`,
      version: r.model_version,
      f1,
      status: r.promoted ? "promoted" : "rejected",
      reason: r.reason,
      promotedF1: r.promoted ? f1 : null,
      rejectedF1: r.promoted ? null : f1,
    });
  }

  if (points.length < 2) return null;

  const lo = Math.min(...points.map((p) => p.f1));
  const hi = Math.max(...points.map((p) => p.f1));
  const yMin = Math.max(0, Math.floor((lo - 0.1) * 10) / 10);
  const yMax = Math.min(1, Math.ceil((hi + 0.05) * 10) / 10);
  const rejectedCount = points.filter((p) => p.status === "rejected").length;

  return (
    <Card
      title="Macro-F1 across rounds"
      action={evalCompare?.provisional ? <ProvisionalBadge /> : undefined}
      className="sm:p-6"
    >
      <p className="max-w-3xl text-lg text-ink-2">
        Macro-F1 averages the F1 score of the eight categories, so a round cannot win by being good only at the common
        ones. The solid line follows the models that were promoted; a round that scored lower than the model in use
        sits off the line.
      </p>

      <div className="mt-4 grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] lg:gap-8">
        <div>
          <ScoreLine points={points} yMin={yMin} yMax={yMax} />
          <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-base text-ink-2">
            <li className="flex items-center gap-2">
              <svg width="30" height="14" aria-hidden>
                <line x1="0" y1="7" x2="30" y2="7" stroke={PROMOTED} strokeWidth="2.5" />
                <circle cx="15" cy="7" r="5.5" fill={PROMOTED} />
              </svg>
              Base model and promoted rounds
            </li>
            {rejectedCount > 0 ? (
              <li className="flex items-center gap-2">
                <svg width="16" height="16" aria-hidden>
                  <path d="M8 1 L15 8 L8 15 L1 8 Z" fill={SURFACE} stroke={REJECTED} strokeWidth="2.5" />
                </svg>
                Not promoted (did not beat the model in use)
              </li>
            ) : null}
          </ul>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[20rem] border-collapse text-left text-lg">
            <caption className="sr-only">Macro-F1 and promotion result for each model</caption>
            <thead>
              <tr className="border-b border-line-strong text-base text-ink-3">
                <th scope="col" className="py-2 pr-3 font-medium">
                  Model
                </th>
                <th scope="col" className="num py-2 pr-3 text-right font-medium">
                  Macro-F1
                </th>
                <th scope="col" className="py-2 font-medium">
                  Result
                </th>
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.version} className="border-b border-line align-top">
                  <th scope="row" className="py-2.5 pr-3 font-mono text-base font-medium text-ink">
                    {p.version}
                  </th>
                  <td className="num py-2.5 pr-3 text-right font-semibold text-ink">{fmtPct(p.f1, 1)}</td>
                  <td
                    className={cx(
                      "py-2.5 text-base font-medium",
                      p.status === "rejected" ? "text-spot" : p.status === "promoted" ? "text-good" : "text-ink-2",
                    )}
                  >
                    {STATUS_TEXT[p.status]}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {evalCompare?.provisional ? (
            <p className="mt-3 text-base text-ink-3">
              Provisional: the evaluation labels come from the teacher model and were not checked by people.
            </p>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
