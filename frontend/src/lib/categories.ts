/**
 * The ONLY place that knows the backend's category letter -> name mapping
 * (backend/schemas.py: CATEGORIES, TEAMS). Everything else goes through here.
 */

export const CATEGORY_LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H"] as const;
export type CategoryLetter = (typeof CATEGORY_LETTERS)[number];

const NAME_BY_LETTER: Record<CategoryLetter, string> = {
  A: "payment_delay",
  B: "payment_dispute",
  C: "onboarding_kyc",
  D: "task_assignment",
  E: "app_technical",
  F: "task_submission",
  G: "account_status",
  H: "other",
};

export const TEAM_BY_LETTER: Record<CategoryLetter, string> = {
  A: "Payments",
  B: "Payments",
  C: "Onboarding",
  D: "Ops",
  E: "Tech",
  F: "Quality",
  G: "Trust & Safety",
  H: "General",
};

function isLetter(v: string): v is CategoryLetter {
  return Object.prototype.hasOwnProperty.call(NAME_BY_LETTER, v);
}

/** Normalises "a" / "A" / " A " / "payment_delay" / "Payment delay" to a letter, or null. */
export function categoryLetter(letterOrName: string): string | null {
  const raw = letterOrName.trim();
  if (isLetter(raw.toUpperCase()) && raw.length === 1) return raw.toUpperCase();
  const key = raw.toLowerCase().replace(/[\s-]+/g, "_");
  for (const l of CATEGORY_LETTERS) {
    if (NAME_BY_LETTER[l] === key) return l;
  }
  return null;
}

/** Letter -> raw backend name ("A" -> "payment_delay"). Unknown input is returned unchanged. */
export function categoryName(letter: string): string {
  const l = letter.trim().toUpperCase();
  return isLetter(l) ? NAME_BY_LETTER[l] : letter;
}

/** Letter or raw name -> sentence-case label ("A" / "payment_delay" -> "Payment delay", "onboarding_kyc" -> "Onboarding KYC"). */
export function categoryLabel(letterOrName: string): string {
  const raw = categoryName(letterOrName).trim();
  if (!raw) return raw;
  const words = raw.split(/[_\s]+/).filter(Boolean).map((w) => w.toLowerCase());
  const text = words
    .map((w, i) => (w === "kyc" ? "KYC" : i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
  return text;
}

/** Team for a category letter (or raw name); "" when unknown. */
export function teamFor(letterOrName: string): string {
  const l = categoryLetter(letterOrName);
  return l && isLetter(l) ? TEAM_BY_LETTER[l] : "";
}

/**
 * Category display order: the key order of the snapshot's per_category_f1 where available,
 * otherwise A..H. Only ever returns keys as the data spells them (letters).
 */
export function categoryOrder(
  evalCompare?: { per_category_f1?: Record<string, Record<string, number>> } | null,
): string[] {
  const per = evalCompare?.per_category_f1;
  if (per) {
    for (const model of Object.keys(per)) {
      const keys = Object.keys(per[model] ?? {});
      if (keys.length > 0) return keys;
    }
  }
  return [...CATEGORY_LETTERS];
}
