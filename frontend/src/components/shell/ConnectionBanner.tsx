"use client";

import { useStore } from "@/lib/store";
import { fmtTime } from "@/lib/format";
import { cx } from "@/components/ui";

export function ConnectionBanner() {
  const { state } = useStore();

  let text: string | null = null;
  let tone: "amber" | "red" | "muted" = "muted";

  if (state.mode === "offline") {
    text = "Offline mode — uncertain tickets go to the human review queue";
    tone = "amber";
  } else if (state.connection === "down" && !state.loaded) {
    text = "Can't reach the backend";
    tone = "red";
  } else if (state.connection === "snapshot") {
    text = `Snapshot from ${state.snapshotAt ? fmtTime(state.snapshotAt) : "earlier"} — backend unreachable`;
    tone = "muted";
  } else if (state.connection === "polling") {
    text = "Realtime stream unavailable — updating every 2 seconds";
    tone = "muted";
  }

  if (!text) return null;

  return (
    <div
      role="status"
      data-banner
      className={cx(
        "border-b px-4 py-1.5 text-center text-base sm:px-8",
        tone === "amber" && "border-spot/40 bg-spot/10 text-spot",
        tone === "red" && "border-bad/40 bg-bad/10 text-bad",
        tone === "muted" && "border-line bg-surface-2 text-ink-2",
      )}
    >
      {text}
    </div>
  );
}
