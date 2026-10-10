import type { ReactNode } from "react";
import { cx } from "@/components/ui";
import type { ModelRow } from "./model-meta";

/** Shared chart text: always a text token, never a series colour. */
export const AXIS_TEXT = "var(--text-2)";
export const MUTED_TEXT = "var(--text-3)";
export const GRID = "var(--line)";
export const AXIS_LINE = "var(--line-strong)";

export function TooltipShell({ title, children }: { title?: ReactNode; children: ReactNode }) {
  return (
    <div className="max-w-xs rounded-md border border-line-strong bg-surface-2 px-3.5 py-2.5 text-base shadow-lg">
      {title ? <p className="mb-1.5 font-semibold text-ink">{title}</p> : null}
      {children}
    </div>
  );
}

/** Split a label into at most `maxLines` lines of roughly `width` chars, on word boundaries. */
export function wrapLabel(text: string, width: number, maxLines = 2): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur && (cur + " " + w).length > width) {
      lines.push(cur);
      cur = w;
    } else {
      cur = cur ? `${cur} ${w}` : w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const head = lines.slice(0, maxLines - 1);
    const tail = lines.slice(maxLines - 1).join(" ");
    return [...head, tail.length > width ? `${tail.slice(0, width - 1)}…` : tail];
  }
  return lines.map((l) => (l.length > width + 4 ? `${l.slice(0, width + 3)}…` : l));
}

export interface AxisTickProps {
  x?: number | string;
  y?: number | string;
  payload?: { value: string | number };
}

/** Status in words (with a glyph), so promoted / not promoted never rests on colour alone. */
export function StatusTag({ row, className }: { row: ModelRow; className?: string }) {
  const tone =
    row.status === "current"
      ? "border-spot text-spot"
      : row.status === "rejected"
        ? "border-bad/70 text-bad"
        : row.status === "superseded"
          ? "border-line-strong text-ink-2"
          : "border-line text-ink-3";
  const glyph =
    row.status === "current" ? "●" : row.status === "rejected" ? "✕" : row.status === "superseded" ? "✓" : "";
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded border px-1.5 py-px text-base font-semibold leading-6",
        tone,
        className,
      )}
    >
      {glyph ? <span aria-hidden>{glyph}</span> : null}
      {row.tag}
    </span>
  );
}
