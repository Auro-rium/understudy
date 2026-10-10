"use client";

import type { Mode } from "@/lib/types";
import { useStore } from "@/lib/store";
import { cx } from "./cx";

/** Visible only when the store is serving seeded mock data. */
export function MockBadge({ className }: { className?: string }) {
  const { state } = useStore();
  if (!state.isMock) return null;
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-md border border-spot bg-spot/10 px-2 py-0.5 text-base font-bold tracking-wide text-spot",
        className,
      )}
      title="The backend isn't providing these numbers; they are seeded sample data."
    >
      MOCK DATA
    </span>
  );
}

export function ProvisionalBadge({ className }: { className?: string }) {
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-md border border-dashed border-spot/70 px-2 py-0.5 text-base font-medium text-spot",
        className,
      )}
      title="Provisional: the backend marked this evaluation as not final."
    >
      Provisional
    </span>
  );
}

export function ModeBadge({ mode, className }: { mode: Mode; className?: string }) {
  const online = mode === "online";
  return (
    <span
      className={cx(
        "inline-flex items-center gap-2 rounded-full border px-3 py-0.5 text-base font-medium leading-6",
        online ? "border-good/50 text-good" : "border-spot/60 bg-spot/10 text-spot",
        className,
      )}
    >
      <span aria-hidden className={cx("size-2 rounded-full", online ? "bg-good" : "bg-spot")} />
      {online ? "Online" : "Offline"}
    </span>
  );
}
