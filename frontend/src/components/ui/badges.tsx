"use client";

import { useSyncExternalStore } from "react";
import type { Mode } from "@/lib/types";
import { fmtDateTime } from "@/lib/format";
import { getApiHost, getApiUrl, serverApiHost, subscribeRuntime } from "@/lib/runtime";
import { useStore } from "@/lib/store";
import { cx } from "./cx";

/** Visible only when the app is showing a saved snapshot (localStorage cache or bundled export), never for live data. */
export function DataBadge({ className }: { className?: string }) {
  const { state } = useStore();
  if (!state.loaded || state.dataSource === "live") return null;
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-md border border-spot bg-spot/10 px-2 py-0.5 text-base font-bold tracking-wide text-spot",
        className,
      )}
      title="Saved export from the backend, not live data"
    >
      SNAPSHOT{state.snapshotAt ? ` · ${fmtDateTime(state.snapshotAt)}` : ""}
    </span>
  );
}

/** Which backend this page talks to (resolved at runtime from ?api= / saved / env). Empty until the browser has resolved it. */
export function ApiHostTag({ className }: { className?: string }) {
  const { state } = useStore();
  const host = useSyncExternalStore(subscribeRuntime, getApiHost, serverApiHost);
  if (!state.apiConfigured || !host) return null;
  return (
    <span
      className={cx("max-w-[16rem] truncate font-mono text-base text-ink-3", className)}
      title={`Backend: ${getApiUrl()} (change with ?api=...)`}
    >
      API: {host}
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
