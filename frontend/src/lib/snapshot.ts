import type { Snapshot } from "@/lib/types";

const KEY = "understudy.snapshot.v1";

export function saveSnapshot(s: Snapshot): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable or full: caching is best-effort */
  }
}

export function loadSnapshot(): Snapshot | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "generated_at" in parsed &&
      "summary" in parsed &&
      "health" in parsed
    ) {
      return parsed as Snapshot;
    }
    return null;
  } catch {
    return null;
  }
}

export function snapshotLabel(s: Snapshot): string {
  const d = new Date(s.generated_at);
  if (Number.isNaN(d.getTime())) return "Snapshot from an unknown time";
  const time = d.toLocaleTimeString("en-GB", { hour12: false });
  return `Snapshot from ${time}`;
}
