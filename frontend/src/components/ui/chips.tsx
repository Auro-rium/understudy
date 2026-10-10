import type { Source } from "@/lib/types";
import { fmtPct } from "@/lib/format";
import { cx } from "./cx";

const SOURCE: Record<Source, { label: string; dot: string; text: string; ring: string }> = {
  local: { label: "Local", dot: "bg-local", text: "text-local", ring: "border-local/40" },
  teacher: { label: "Teacher", dot: "bg-teacher", text: "text-teacher", ring: "border-teacher/40" },
  review: { label: "Review", dot: "bg-review", text: "text-review", ring: "border-review/40" },
};

export function SourceChip({ source, className }: { source: Source; className?: string }) {
  const s = SOURCE[source] ?? SOURCE.local;
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-sm font-medium leading-6",
        s.ring,
        s.text,
        className,
      )}
    >
      <span aria-hidden className={cx("size-2 rounded-full", s.dot)} />
      {s.label}
    </span>
  );
}

const PRIORITY: Record<string, string> = {
  urgent: "text-bad border-bad/50",
  high: "text-spot border-spot/50",
  medium: "text-ink-2 border-line-strong",
  low: "text-ink-3 border-line",
};

export function PriorityChip({ priority, className }: { priority: string; className?: string }) {
  const key = priority.toLowerCase();
  const label = key.charAt(0).toUpperCase() + key.slice(1);
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-sm font-medium leading-6",
        PRIORITY[key] ?? PRIORITY.medium,
        className,
      )}
    >
      {label}
    </span>
  );
}

/** Fill grows via CSS transition (globally neutralised under reduced motion). */
export function ConfidenceBar({
  value,
  source,
  className,
}: {
  value: number;
  source?: Source;
  className?: string;
}) {
  const v = Math.min(1, Math.max(0, value));
  const fill = source ? SOURCE[source].dot : "bg-ink-2";
  return (
    <div className={cx("flex items-center gap-2", className)}>
      <div
        role="meter"
        aria-label="Confidence"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(v * 100)}
        className="h-2 w-16 flex-none overflow-hidden rounded-full bg-surface-3"
      >
        <div
          className={cx("h-full rounded-full transition-[width] duration-700 ease-out", fill)}
          style={{ width: `${v * 100}%` }}
        />
      </div>
      <span className="num w-10 text-right text-sm text-ink-2">{fmtPct(v)}</span>
    </div>
  );
}

export function VersionChip({ version, className }: { version: string; className?: string }) {
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-md border border-line-strong bg-surface-2 px-2 py-0.5 font-mono text-sm text-ink",
        className,
      )}
      title="Model version being served"
    >
      {version}
    </span>
  );
}
