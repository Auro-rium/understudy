"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import { fmtTime } from "@/lib/format";

/** Sliding window so the charts keep moving smoothly during a long session. */
export const WINDOW = 120;

export function axisTime(iso: string): string {
  return fmtTime(iso).slice(0, 5);
}

/** Shared tooltip chrome: surface card, ink text, swatch + label + exact value rows. */
export function TipBox({ time, children }: { time: string; children: ReactNode }) {
  return (
    <div className="min-w-48 rounded-lg border border-line-strong bg-surface-2 px-4 py-3 shadow-xl shadow-black/40">
      <p className="num mb-2 text-base text-ink-3">{time}</p>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

export function TipRow({
  swatch,
  label,
  value,
}: {
  swatch: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center justify-between gap-6 text-lg">
      <span className="flex items-center gap-2 text-ink-2">
        {swatch}
        {label}
      </span>
      <span className="num font-semibold text-ink">{value}</span>
    </div>
  );
}

export function LegendItem({ swatch, label }: { swatch: ReactNode; label: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-base text-ink-2">
      {swatch}
      {label}
    </span>
  );
}

export const LineSwatch = ({ color }: { color: string }) => (
  <span aria-hidden className="inline-block h-0.5 w-5 rounded-full" style={{ background: color }} />
);

export const FillSwatch = ({ color }: { color: string }) => (
  <span aria-hidden className="inline-block size-3 rounded-sm" style={{ background: color, opacity: 0.45 }} />
);

/** matchMedia as an external store (SSR-safe: false on the server). */
export function useMinWidth(px: number): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(`(min-width: ${px}px)`);
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => window.matchMedia(`(min-width: ${px}px)`).matches,
    () => false,
  );
}
