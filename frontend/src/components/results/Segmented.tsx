"use client";

import { cx } from "@/components/ui";

interface SegmentedProps<T extends string> {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
}

/** Single-select button group. Selected state is carried by fill + weight, not colour alone. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  className,
}: SegmentedProps<T>) {
  return (
    <div role="group" aria-label={label} className={cx("flex flex-wrap gap-1.5", className)}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.value)}
            className={cx(
              "min-h-10 rounded-md border px-3.5 text-base transition-colors",
              on
                ? "border-ink-3 bg-surface-3 font-semibold text-ink"
                : "border-line bg-transparent text-ink-2 hover:border-line-strong hover:bg-surface-2 hover:text-ink",
            )}
          >
            {on ? <span aria-hidden className="mr-1.5 text-spot">●</span> : null}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
