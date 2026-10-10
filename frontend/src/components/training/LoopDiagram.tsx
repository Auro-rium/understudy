"use client";

import { motion, useReducedMotion } from "motion/react";
import type { ActiveStage } from "@/lib/store";

/**
 * Hand-written SVG loop diagram. Two layouts (wide / tall) share the same node
 * and edge model; CSS shows exactly one of them. Every node carries a text
 * label, colour is only the identity layer. The active stage is driven entirely
 * by `stage` from the store.
 */

type NodeId = "ticket" | "router" | "local" | "teacher" | "data" | "lora" | "gate" | "swap";
type ColorKey = "neutral" | "local" | "teacher" | "spot";

const COLOR: Record<ColorKey, string> = {
  neutral: "#bcc0d0",
  local: "#3987e5",
  teacher: "#d95926",
  spot: "#f2c14e",
};

interface NodeDef {
  id: NodeId;
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  sub: string;
  color: ColorKey;
}

interface EdgeDef {
  id: string;
  d: string;
  color: ColorKey;
  /** stages during which this edge carries the bright flow */
  stages: ActiveStage[];
  label?: { x: number; y: number; text: string; anchor?: "start" | "middle" | "end" };
}

interface LayoutDef {
  key: string;
  vbW: number;
  vbH: number;
  titleSize: number;
  subSize: number;
  labelSize: number;
  nodes: NodeDef[];
  edges: EdgeDef[];
}

/** Which stage lights up which node. */
const NODE_STAGE: Record<NodeId, ActiveStage[]> = {
  ticket: [],
  router: ["routing"],
  local: ["routing"],
  teacher: ["routing"],
  data: ["collect"],
  lora: ["train"],
  gate: ["evaluate"],
  swap: ["promote"],
};

const WIDE: LayoutDef = {
  key: "wide",
  vbW: 1200,
  vbH: 510,
  titleSize: 24,
  subSize: 19,
  labelSize: 19,
  nodes: [
    { id: "ticket", x: 20, y: 118, w: 200, h: 88, title: "Ticket", sub: "Gig worker message", color: "neutral" },
    { id: "router", x: 290, y: 118, w: 200, h: 88, title: "Router", sub: "Checks confidence", color: "neutral" },
    { id: "local", x: 590, y: 18, w: 240, h: 88, title: "Local Gemma", sub: "Free and fast", color: "local" },
    { id: "teacher", x: 590, y: 218, w: 240, h: 88, title: "Cloud teacher", sub: "Costs money, slower", color: "teacher" },
    { id: "data", x: 900, y: 218, w: 280, h: 88, title: "Teacher answers", sub: "become training data", color: "teacher" },
    { id: "lora", x: 900, y: 400, w: 280, h: 88, title: "LoRA training round", sub: "Trains small adapters", color: "local" },
    { id: "gate", x: 590, y: 400, w: 240, h: 88, title: "Evaluation gate", sub: "Held-out tickets", color: "spot" },
    { id: "swap", x: 290, y: 400, w: 200, h: 88, title: "Hot-swap", sub: "Better model live", color: "local" },
  ],
  edges: [
    { id: "e1", d: "M220 162 H284", color: "neutral", stages: ["routing"] },
    {
      id: "e2",
      d: "M490 162 C545 162 535 62 584 62",
      color: "local",
      stages: ["routing"],
      label: { x: 550, y: 142, text: "confident", anchor: "start" },
    },
    {
      id: "e3",
      d: "M490 162 C545 162 535 262 584 262",
      color: "teacher",
      stages: ["routing"],
      label: { x: 550, y: 198, text: "unsure", anchor: "start" },
    },
    { id: "e4", d: "M830 262 H894", color: "teacher", stages: ["collect"] },
    {
      id: "e5",
      d: "M1040 306 V394",
      color: "teacher",
      stages: ["train"],
      label: { x: 1030, y: 356, text: "labelled examples", anchor: "end" },
    },
    { id: "e6", d: "M900 444 H836", color: "local", stages: ["evaluate"] },
    { id: "e7", d: "M590 444 H496", color: "spot", stages: ["promote"] },
    {
      id: "e8",
      d: "M390 394 V212",
      color: "local",
      stages: ["promote"],
      label: { x: 404, y: 340, text: "new model serves tickets", anchor: "start" },
    },
  ],
};

const TALL: LayoutDef = {
  key: "tall",
  vbW: 410,
  vbH: 880,
  titleSize: 20,
  subSize: 16,
  labelSize: 16,
  nodes: [
    { id: "ticket", x: 65, y: 10, w: 280, h: 76, title: "Ticket", sub: "Gig worker message", color: "neutral" },
    { id: "router", x: 65, y: 138, w: 280, h: 76, title: "Router", sub: "Checks confidence", color: "neutral" },
    { id: "local", x: 20, y: 266, w: 170, h: 76, title: "Local Gemma", sub: "When confident", color: "local" },
    { id: "teacher", x: 210, y: 266, w: 170, h: 76, title: "Cloud teacher", sub: "When unsure", color: "teacher" },
    { id: "data", x: 65, y: 394, w: 280, h: 76, title: "Teacher answers", sub: "become training data", color: "teacher" },
    { id: "lora", x: 65, y: 522, w: 280, h: 76, title: "LoRA training round", sub: "Trains small adapters", color: "local" },
    { id: "gate", x: 65, y: 650, w: 280, h: 76, title: "Evaluation gate", sub: "Held-out tickets", color: "spot" },
    { id: "swap", x: 65, y: 778, w: 280, h: 76, title: "Hot-swap", sub: "Better model goes live", color: "local" },
  ],
  edges: [
    { id: "e1", d: "M205 86 V132", color: "neutral", stages: ["routing"] },
    { id: "e2", d: "M205 214 C205 244 105 234 105 260", color: "local", stages: ["routing"] },
    { id: "e3", d: "M205 214 C205 244 295 234 295 260", color: "teacher", stages: ["routing"] },
    { id: "e4", d: "M295 342 C295 372 205 362 205 388", color: "teacher", stages: ["collect"] },
    { id: "e5", d: "M205 470 V516", color: "teacher", stages: ["train"] },
    { id: "e6", d: "M205 598 V644", color: "local", stages: ["evaluate"] },
    { id: "e7", d: "M205 726 V772", color: "spot", stages: ["promote"] },
    { id: "e8", d: "M345 816 H398 V176 H351", color: "local", stages: ["promote"] },
  ],
};

function nodeActive(id: NodeId, stage: ActiveStage): boolean {
  return NODE_STAGE[id].includes(stage);
}

const STAGE_LABEL: Record<ActiveStage, string> = {
  idle: "Idle",
  routing: "Routing tickets",
  collect: "Teacher answers becoming training data",
  train: "LoRA training",
  evaluate: "Evaluation gate",
  promote: "Hot-swap",
};

export function stageLabel(stage: ActiveStage): string {
  return STAGE_LABEL[stage];
}

function Layout({ layout, stage, reduce }: { layout: LayoutDef; stage: ActiveStage; reduce: boolean }) {
  const p = layout.key;
  const markerId = (c: ColorKey) => `${p}-arrow-${c}`;
  return (
    <svg
      viewBox={`0 0 ${layout.vbW} ${layout.vbH}`}
      className="h-auto w-full"
      role="img"
      aria-label="Loop diagram: a ticket reaches the router, which answers with the local Gemma model when confident or asks the cloud teacher when unsure. Teacher answers become training data for a LoRA round, an evaluation gate decides whether the new model is promoted, and a hot-swap returns the better model to the router."
    >
      <defs>
        {(Object.keys(COLOR) as ColorKey[]).map((c) => (
          <marker
            key={c}
            id={markerId(c)}
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0 0 L10 5 L0 10 z" fill={COLOR[c]} />
          </marker>
        ))}
      </defs>

      {/* edges */}
      {layout.edges.map((e) => {
        const active = e.stages.includes(stage);
        const color = COLOR[e.color];
        const n = active ? 4 : 2;
        const dur = active ? 1.5 : 3.2;
        return (
          <g key={e.id}>
            <path
              d={e.d}
              fill="none"
              stroke={color}
              strokeWidth={active ? 4 : 2.5}
              strokeOpacity={active ? 0.95 : 0.35}
              strokeLinecap="round"
              markerEnd={`url(#${markerId(e.color)})`}
            />
            {!reduce &&
              Array.from({ length: n }, (_, i) => (
                <circle
                  key={`${active ? "a" : "i"}-${i}`}
                  r={active ? 6.5 : 4.5}
                  fill={e.color === "neutral" ? "#f2f0ea" : color}
                  fillOpacity={active ? 1 : 0.55}
                >
                  <animateMotion
                    dur={`${dur}s`}
                    repeatCount="indefinite"
                    begin={`${(-(i * dur) / n).toFixed(2)}s`}
                    path={e.d}
                    calcMode="linear"
                  />
                </circle>
              ))}
            {e.label ? (
              <text
                x={e.label.x}
                y={e.label.y}
                textAnchor={e.label.anchor ?? "start"}
                fontSize={layout.labelSize}
                fill="#8d92a8"
                fontStyle="italic"
              >
                {e.label.text}
              </text>
            ) : null}
          </g>
        );
      })}

      {/* nodes */}
      {layout.nodes.map((n) => {
        const active = nodeActive(n.id, stage);
        const color = COLOR[n.color];
        return (
          <g key={n.id}>
            {active ? (
              <motion.rect
                x={n.x - 8}
                y={n.y - 8}
                width={n.w + 16}
                height={n.h + 16}
                rx={20}
                fill="none"
                stroke="#f2c14e"
                strokeWidth={4}
                initial={{ opacity: 0 }}
                animate={reduce ? { opacity: 1 } : { opacity: [1, 0.3, 1] }}
                transition={reduce ? { duration: 0 } : { duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
              />
            ) : null}
            <rect
              x={n.x}
              y={n.y}
              width={n.w}
              height={n.h}
              rx={14}
              fill={`color-mix(in srgb, ${color} ${active ? 26 : 12}%, #12151f)`}
              stroke={color}
              strokeWidth={active ? 3 : 2}
              strokeOpacity={active ? 1 : 0.7}
            />
            <text
              x={n.x + n.w / 2}
              y={n.y + n.h / 2 - 5}
              textAnchor="middle"
              fontSize={layout.titleSize}
              fontWeight={600}
              fill="#f2f0ea"
            >
              {n.title}
            </text>
            <text
              x={n.x + n.w / 2}
              y={n.y + n.h / 2 + layout.subSize + 1}
              textAnchor="middle"
              fontSize={layout.subSize}
              fill="#bcc0d0"
            >
              {n.sub}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function LoopDiagram({ stage }: { stage: ActiveStage }) {
  const reduce = useReducedMotion() ?? false;
  return (
    <div>
      <div className="mx-auto hidden max-w-[1400px] lg:block">
        <Layout layout={WIDE} stage={stage} reduce={reduce} />
      </div>
      <div className="mx-auto max-w-[420px] lg:hidden">
        <Layout layout={TALL} stage={stage} reduce={reduce} />
      </div>
    </div>
  );
}
