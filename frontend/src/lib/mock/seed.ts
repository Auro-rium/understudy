/**
 * Static seed data for the MOCK layer. Everything here is illustrative dummy
 * data: it exists so the UI can be demonstrated before the backend is ready,
 * and it is always shown next to a "MOCK DATA" badge.
 */

export const CATEGORIES = [
  { id: 0, name: "Payment delay", team: "Payments Ops", keywords: ["not paid", "payment", "haven't received", "still waiting", "pending payout", "delayed", "not credited", "transfer"] },
  { id: 1, name: "Payout deduction dispute", team: "Payments Disputes", keywords: ["deduct", "deduction", "less than", "wrong amount", "penalty", "fine", "charged", "short"] },
  { id: 2, name: "KYC & account verification", team: "Onboarding", keywords: ["kyc", "verification", "aadhaar", "document", "pan", "blocked account", "account locked", "selfie", "bank details"] },
  { id: 3, name: "App or technical issue", team: "Tech Support", keywords: ["app", "crash", "login", "otp", "gps", "bug", "error", "freezes", "update", "notification"] },
  { id: 4, name: "Task assignment & ratings", team: "Field Operations", keywords: ["rating", "assigned", "no tasks", "cancelled", "order", "shift", "slot", "unfair", "allocation"] },
  { id: 5, name: "Safety & conduct", team: "Trust & Safety", keywords: ["unsafe", "harass", "abuse", "threat", "accident", "rude", "inappropriate", "injured", "attack"] },
] as const;

export const CATEGORY_NAMES: string[] = CATEGORIES.map((c) => c.name);

/** Priority is a function of category + wording in the mock. */
export const PRIORITIES = ["low", "medium", "high", "urgent"] as const;

export const TICKET_TEXTS: Record<number, string[]> = {
  0: [
    "I finished 14 deliveries on Monday and my payout still hasn't arrived. It's been five days.",
    "Weekly payment was supposed to be credited yesterday. Nothing in my bank account yet.",
    "My earnings show as pending for over a week. Please release the money, rent is due.",
    "Payout for last Sunday shows 'processing' but never completed. Can you check?",
    "I haven't received my payment for the 3 tasks I completed on the 2nd.",
    "Transfer to my bank failed and the app says it will retry, but it has been four days.",
    "Instant cash-out button is greyed out and my balance has been stuck since Friday.",
    "Money not credited even after the confirmation SMS. Please look into it urgently.",
  ],
  1: [
    "You deducted ₹180 from my payout and I don't know why. There is no explanation in the app.",
    "I got a penalty for a late delivery but the customer's address was wrong. Please reverse it.",
    "My payout is less than what the earnings screen showed by almost ₹300.",
    "Charged a fine for cancelling, but the restaurant was closed. I want this refunded.",
    "Why was a platform fee taken twice this week? My total is short.",
    "The incentive for 20 orders is missing from my payout. I completed all 22.",
    "Deduction labelled 'equipment' appeared, but I already returned my bag.",
    "Wrong amount paid for the long-distance trip. Distance in the app was 12 km, I rode 19 km.",
  ],
  2: [
    "My KYC has been under review for 9 days. I can't take any tasks until it's approved.",
    "App rejected my Aadhaar upload twice, the photo is clear. What should I do?",
    "Account is blocked after I updated my bank details. I need access back to work.",
    "Selfie verification keeps failing even in good light.",
    "I changed my phone number and now can't verify my account.",
    "PAN card name doesn't match bank name, how do I fix this?",
    "Document verification says 'expired' but my licence is valid till 2028.",
    "I registered last week and still see 'verification pending'. No one has contacted me.",
  ],
  3: [
    "The app crashes every time I open the task list. Reinstalling didn't help.",
    "I'm not getting the OTP to log in. Tried five times since morning.",
    "GPS shows my location 2 km away so I keep missing pickups.",
    "After the latest update the notifications for new tasks don't come at all.",
    "App freezes on the delivery confirmation screen and I can't complete the order.",
    "Can't upload the proof-of-delivery photo, it says 'error 500'.",
    "The map doesn't load and navigation is blank.",
    "Keeps logging me out in the middle of a shift.",
  ],
  4: [
    "I've been online for six hours and got zero tasks while others nearby are busy. Is this fair?",
    "My rating dropped to 3.9 because of one cancelled order that wasn't my fault.",
    "Task was cancelled after I reached the pickup. I should be compensated for the trip.",
    "Shift slot I booked for tomorrow disappeared from my schedule.",
    "Customer gave a 1-star for something the restaurant did. Can this be removed?",
    "Order assigned to me was 25 km away at a ₹60 payout. Why was it allocated to me?",
    "I was removed from the priority list without notice. What changed?",
    "The slot allocation always gives me the night shift, I asked for mornings.",
  ],
  5: [
    "A customer shouted abuse at me and threatened to report me. I don't feel safe delivering there.",
    "I had a minor accident on the way to a delivery. I'm injured and need help.",
    "A support agent was very rude when I asked about my payout.",
    "Someone followed me after I left the pickup point. Please help.",
    "A customer made inappropriate comments and asked for my personal number.",
    "The delivery address was inside an unsafe area at night. I want to report this location.",
    "I was harassed at the restaurant by the staff. This is not the first time.",
    "A dog attacked me at the customer's gate while I was on the clock.",
  ],
};

/** A few off-distribution tickets the mock produces occasionally. */
export const AMBIGUOUS_TEXTS: Array<{ text: string; cat: number }> = [
  { text: "Money missing and the app is also not letting me log in to check anything.", cat: 0 },
  { text: "Was fined and then my account got locked the same day, are these related?", cat: 1 },
  { text: "I got abused by a customer and the payout for that order was reduced.", cat: 5 },
  { text: "App says my documents are verified but I'm not getting any tasks.", cat: 4 },
];

/* ---------- deterministic RNG (mulberry32) ---------- */

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- training script ---------- */

export interface RoundScript {
  promoted: boolean;
  examples: number;
  wall_time_s: number;
  /** fraction of unsure tickets the new model now answers locally (promoted rounds) */
  local_share_target: number;
  eval: { category_acc: number; category_macro_f1: number; priority_acc: number };
  reason: string;
  /** final loss at end of curve */
  final_loss: number;
}

/**
 * Round 1 and 2 are "already happened" history; later rounds run when the
 * user clicks "Run training round". One round is deliberately rejected by the
 * evaluation gate so the gate is visibly real.
 */
export const ROUND_SCRIPT: RoundScript[] = [
  {
    promoted: true, examples: 412, wall_time_s: 388, local_share_target: 0.46,
    eval: { category_acc: 0.725, category_macro_f1: 0.703, priority_acc: 0.745 },
    reason: "Macro-F1 +9.1 pts over base on the held-out set. No category dropped more than 3 pts.",
    final_loss: 0.41,
  },
  {
    promoted: true, examples: 1096, wall_time_s: 604, local_share_target: 0.64,
    eval: { category_acc: 0.815, category_macro_f1: 0.797, priority_acc: 0.81 },
    reason: "Macro-F1 +9.4 pts over v1. Largest gain in 'KYC & account verification' (+14 pts).",
    final_loss: 0.33,
  },
  {
    promoted: true, examples: 1830, wall_time_s: 733, local_share_target: 0.8,
    eval: { category_acc: 0.88, category_macro_f1: 0.866, priority_acc: 0.855 },
    reason: "Macro-F1 +6.9 pts over v2. Gate passed: every category at or above v2.",
    final_loss: 0.24,
  },
  {
    promoted: false, examples: 2210, wall_time_s: 781, local_share_target: 0.8,
    eval: { category_acc: 0.885, category_macro_f1: 0.862, priority_acc: 0.86 },
    reason: "Rejected by the evaluation gate: accuracy +0.5 pts, but 'Safety & conduct' F1 fell 7.2 pts (limit: 3 pts). Kept the current model.",
    final_loss: 0.22,
  },
  {
    promoted: true, examples: 2790, wall_time_s: 842, local_share_target: 0.89,
    eval: { category_acc: 0.915, category_macro_f1: 0.903, priority_acc: 0.885 },
    reason: "Macro-F1 +3.7 pts over the current model. Safety & conduct recovered after adding 140 targeted examples.",
    final_loss: 0.17,
  },
  {
    promoted: true, examples: 3340, wall_time_s: 890, local_share_target: 0.92,
    eval: { category_acc: 0.93, category_macro_f1: 0.918, priority_acc: 0.9 },
    reason: "Macro-F1 +1.5 pts. Gains are flattening; the teacher still covers the long tail.",
    final_loss: 0.14,
  },
];

/** Base Gemma before any LoRA round. */
export const BASE_EVAL = { category_acc: 0.61, category_macro_f1: 0.585, priority_acc: 0.665 };
export const BASE_LOCAL_SHARE = 0.3;

export const TEACHER_EVAL = {
  category_acc: 0.95,
  category_macro_f1: 0.94,
  priority_acc: 0.92,
  latency_ms: 1480,
  cost_per_1k: 12,
};

export const HARDWARE = "MacBook Air (Apple silicon) · MLX LoRA";

/** Cloud teacher cost for one ticket (USD). */
export const TEACHER_COST_PER_TICKET = 0.012;
