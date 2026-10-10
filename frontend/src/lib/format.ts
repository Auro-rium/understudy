/** Display formatting helpers. Pure functions, no locale surprises (en-US). */

export function clamp(x: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, x));
}

const intFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** 0..1 -> "73%" (digits controls decimals). */
export function fmtPct(x: number, digits = 0): string {
  if (!Number.isFinite(x)) return "–";
  return `${(x * 100).toFixed(digits)}%`;
}

/** Adaptive dollars: under $1 keeps 3-4 decimals, otherwise cents. */
export function fmtUsd(x: number): string {
  if (!Number.isFinite(x)) return "–";
  const sign = x < 0 ? "-" : "";
  const a = Math.abs(x);
  if (a === 0) return "$0.00";
  if (a >= 1000) return `${sign}$${intFmt.format(a)}`;
  if (a >= 1) return `${sign}$${a.toFixed(2)}`;
  if (a >= 0.01) return `${sign}$${a.toFixed(3)}`;
  return `${sign}$${a.toFixed(4)}`;
}

export function fmtInt(x: number): string {
  if (!Number.isFinite(x)) return "–";
  return intFmt.format(Math.round(x));
}

export function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return "–";
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)} s`;
  return `${Math.round(ms)} ms`;
}

/** Seconds -> "6m 28s", "45s", "1h 02m". */
export function fmtDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "–";
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(r).padStart(2, "0")}s`;
  return `${r}s`;
}

/** ISO timestamp -> HH:MM:SS in local time. */
export function fmtTime(iso: string | number | Date): string {
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return "–";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Percentage-point delta. Input is already in points (12.4 -> "+12.4 pts"). */
export function fmtDelta(pts: number, digits = 1): string {
  if (!Number.isFinite(pts)) return "–";
  const sign = pts > 0 ? "+" : pts < 0 ? "−" : "";
  return `${sign}${Math.abs(pts).toFixed(digits)} pts`;
}
