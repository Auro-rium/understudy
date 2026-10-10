/** Tiny class joiner. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export type Accent = "local" | "teacher" | "review" | "save" | "spot";

export const accentText: Record<Accent, string> = {
  local: "text-local",
  teacher: "text-teacher",
  review: "text-review",
  save: "text-good",
  spot: "text-spot",
};

export const accentBg: Record<Accent, string> = {
  local: "bg-local",
  teacher: "bg-teacher",
  review: "bg-review",
  save: "bg-save",
  spot: "bg-spot",
};

export const accentBorder: Record<Accent, string> = {
  local: "border-local",
  teacher: "border-teacher",
  review: "border-review",
  save: "border-save",
  spot: "border-spot",
};
