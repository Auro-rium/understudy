"use client";

import { useEffect, useState } from "react";
import { useStore, type LastRound } from "@/lib/store";

const FRESH_MS = 12000;
const SHOW_MS = 8000;

/**
 * Returns the latest finished training round while it is "news": fresh when
 * the page opened (within 12s) and visible for ~8s, or until dismissed.
 */
export function useRoundHighlight(): { round: LastRound | null; dismiss: () => void } {
  const { state } = useStore();
  const lastRound = state.lastRound;
  const at = lastRound?.at ?? null;
  const [mountedAt] = useState(() => Date.now());
  const [closedAt, setClosedAt] = useState<number | null>(null);

  useEffect(() => {
    if (at === null) return;
    const remaining = Math.max(0, SHOW_MS - (Date.now() - at));
    const id = setTimeout(() => setClosedAt(at), remaining);
    return () => clearTimeout(id);
  }, [at]);

  const visible = at !== null && at >= mountedAt - FRESH_MS && at !== closedAt;
  return {
    round: visible ? lastRound : null,
    dismiss: () => {
      if (at !== null) setClosedAt(at);
    },
  };
}
