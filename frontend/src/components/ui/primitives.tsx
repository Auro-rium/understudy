"use client";

import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { cx } from "./cx";

interface CardProps {
  title?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
  /** "raised" = filled surface, "plain" = hairline panel only. */
  tone?: "plain" | "raised";
  as?: "section" | "div" | "article";
}

export function Card({
  title,
  action,
  children,
  className,
  tone = "raised",
  as: Tag = "section",
}: CardProps) {
  return (
    <Tag
      className={cx(
        "rounded-lg border p-4 sm:p-5",
        tone === "raised" ? "border-line bg-surface" : "border-line",
        className,
      )}
    >
      {title || action ? (
        <header className="mb-3 flex items-baseline justify-between gap-3">
          {title ? <h2 className="text-xl font-semibold text-ink">{title}</h2> : <span />}
          {action ? <div className="text-base text-ink-2">{action}</div> : null}
        </header>
      ) : null}
      {children}
    </Tag>
  );
}

export function EmptyState({
  title,
  hint,
  icon,
  className,
}: {
  title: string;
  hint?: string;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "flex flex-col items-start gap-1 rounded-lg border border-dashed border-line-strong px-5 py-6",
        className,
      )}
    >
      {icon ? <div className="mb-1 text-ink-3">{icon}</div> : null}
      <p className="text-lg font-medium text-ink">{title}</p>
      {hint ? <p className="text-base text-ink-3">{hint}</p> : null}
    </div>
  );
}

export function ProgressBar({
  value = 0,
  label,
  indeterminate,
  className,
  fillClassName = "bg-local",
}: {
  value?: number;
  label?: string;
  indeterminate?: boolean;
  className?: string;
  /** Tailwind bg-* class for the fill. */
  fillClassName?: string;
}) {
  const reduce = useReducedMotion();
  const v = Math.min(1, Math.max(0, value));
  return (
    <div className={className}>
      {label ? (
        <div className="mb-1 flex justify-between text-base text-ink-2">
          <span>{label}</span>
          {indeterminate ? null : <span className="num">{Math.round(v * 100)}%</span>}
        </div>
      ) : null}
      <div
        role="progressbar"
        aria-label={label ?? "Progress"}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={indeterminate ? undefined : Math.round(v * 100)}
        className="relative h-2.5 overflow-hidden rounded-full bg-surface-3"
      >
        {indeterminate ? (
          <motion.div
            className={cx("absolute inset-y-0 w-1/3 rounded-full", fillClassName)}
            initial={{ left: reduce ? "33%" : "-33%" }}
            animate={reduce ? undefined : { left: ["-33%", "100%"] }}
            transition={{ duration: 1.4, ease: "easeInOut", repeat: Infinity }}
          />
        ) : (
          <div
            className={cx("h-full rounded-full transition-[width] duration-500 ease-out", fillClassName)}
            style={{ width: `${v * 100}%` }}
          />
        )}
      </div>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cx("animate-pulse rounded-md bg-surface-3/70", className)} />;
}
