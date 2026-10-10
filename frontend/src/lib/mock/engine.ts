/**
 * In-browser simulator that implements the whole Understudy API contract.
 * Pages never know whether they talk to this or to FastAPI.
 *
 * - Deterministic (mulberry32, fixed seed) so the demo history is stable.
 * - Created lazily on first use via getEngine() (client only).
 * - Nothing is persisted: a page reload resets the simulation.
 */

import type {
  ClassifyResult,
  EvalCompare,
  EvalModel,
  Health,
  LossPoint,
  Mode,
  ReviewItem,
  Round,
  ServerEvent,
  Snapshot,
  Source,
  Summary,
  TimePoint,
  Ticket,
  TrainProgress,
  TrainRoundRequest,
  TrainRoundResponse,
  TrainStage,
} from "@/lib/types";
import {
  AMBIGUOUS_TEXTS,
  BASE_EVAL,
  CATEGORIES,
  CATEGORY_NAMES,
  HARDWARE,
  PRIORITIES,
  ROUND_SCRIPT,
  TEACHER_COST_PER_TICKET,
  TEACHER_EVAL,
  TICKET_TEXTS,
  mulberry32,
  type RoundScript,
} from "./seed";

/* ---------- constants ---------- */

const SEED = 0x5eed2024;
const HISTORY_TICKETS = 600;
const HISTORY_POINTS = 60;
const HISTORY_TICKET_GAP_MS = 3000; // 600 tickets * 3s = 30 min = 60 points * 30s
const SERIES_WINDOW_HISTORY = 60;
const SERIES_WINDOW_LIVE = 40;
const SHARE_WINDOW = 100;
const TICKET_CAP = 200;
const REVIEW_CAP = 200;
const SERIES_CAP = 240;
const SNAPSHOT_TICKETS = 50;
const LOCAL_THRESHOLD = 0.7;
const AMBIGUOUS_RATE = 0.05;
const DEFAULT_RATE = 40;
const MIN_RATE = 6;
const MAX_RATE = 600;
const TICK_MS = 250;
const LOSS_POINTS = 60;
const TOTAL_STEPS = 600;
const BASE_NAME = "gemma-base";
const TEACHER_NAME = "teacher";
const ROUTER_NAME = "Understudy router";
const CATEGORY_WEIGHTS = [0.24, 0.2, 0.14, 0.18, 0.14, 0.1];
/** 200-ticket held-out test set, rows = true category */
const TEST_ROWS = [48, 40, 28, 36, 28, 20];
const CATEGORY_OFFSETS = [0.05, 0.0, 0.03, 0.06, -0.01, -0.13];
const SUFFIXES = ["Please help.", "Please look into this.", "Thanks.", "This is the second time.", "Waiting for a reply."];
const URGENT_RE = /accident|injur|emergency|hospital|followed|attack|threat|unsafe/;
const BUMP_RE = /urgent|rent|blocked|locked|can't (take|complete|work|log)|cannot|stuck|\b(9|nine|five|four) days|over a week/;

type Handler = (e: ServerEvent) => void;

/* ---------- small helpers ---------- */

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function round(x: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

/** Split an integer total across weights using largest-remainder rounding. */
function distribute(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (total <= 0 || sum <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const out = raw.map((r) => Math.floor(r));
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, f: r - Math.floor(r) }))
    .sort((a, b) => b.f - a.f);
  for (let k = 0; left > 0; k++, left--) {
    out[order[k % order.length].i] += 1;
  }
  return out;
}

function derivePriority(category: number, text: string): string {
  const lower = text.toLowerCase();
  if (category === 5) return URGENT_RE.test(lower) ? "urgent" : "high";
  if (/accident|injur|emergency/.test(lower)) return "urgent";
  const base = [1, 1, 1, 0, 0, 2][category] ?? 1; // medium, medium, medium, low, low, high
  const bumped = BUMP_RE.test(lower) ? Math.min(base + 1, 2) : base;
  return PRIORITIES[bumped];
}

function historyPhase(i: number): { version: string; p: number } {
  if (i < 150) return { version: BASE_NAME, p: 0.3 };
  if (i < 350) return { version: "v1", p: 0.3 + 0.16 * clamp((i - 150) / 100, 0, 1) };
  return { version: "v2", p: 0.46 + 0.18 * clamp((i - 350) / 100, 0, 1) };
}

/* ---------- engine ---------- */

interface TicketSpec {
  text: string;
  trueCat: number;
  localConf: number;
}

interface Job {
  id: string;
  roundNo: number;
  backend: string;
  script: RoundScript;
  curve: LossPoint[];
  tick: number;
  totalTicks: number;
  previousVersion: string;
  candidate: string;
  timer: ReturnType<typeof setInterval> | null;
}

export class MockEngine {
  private rng = mulberry32(SEED);
  private latRng = mulberry32(SEED ^ 0x9e3779b9);
  private handlers = new Set<Handler>();

  private mode: Mode = "online";
  private modelVersion = "v2";
  /** nominal share of tickets the serving model handles locally */
  private targetShare = ROUND_SCRIPT[1].local_share_target;
  /** eased towards targetShare tick by tick so live charts climb smoothly */
  private effShare = ROUND_SCRIPT[1].local_share_target;

  private seq = 0;
  private jobSeq = 0;
  private total = 0;
  private costTotal = 0;
  private ticketList: Ticket[] = [];
  private reviewList: ReviewItem[] = [];
  private seriesList: TimePoint[] = [];
  private roundList: Round[] = [];
  private markers: { at: string; version: string; promoted: boolean }[] = [];

  private streaming = false;
  private ratePerMin = DEFAULT_RATE;
  private streamTimer: ReturnType<typeof setTimeout> | null = null;
  private sinceSeriesPoint = 0;
  private lastSeriesAt = 0;
  private job: Job | null = null;

  constructor() {
    this.buildHistory();
  }

  /* ----- event bus ----- */

  subscribe(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  private emit(e: ServerEvent): void {
    for (const h of Array.from(this.handlers)) {
      try {
        h(e);
      } catch {
        /* a bad subscriber must not break the simulator */
      }
    }
  }

  /* ----- latency wrapper ----- */

  private wait<T>(fn: () => T): Promise<T> {
    const ms = 30 + Math.floor(this.latRng() * 90);
    return new Promise<T>((resolve, reject) => {
      setTimeout(() => {
        try {
          resolve(fn());
        } catch (err) {
          reject(err);
        }
      }, ms);
    });
  }

  /* ----- history ----- */

  private buildHistory(): void {
    const now = Date.now();
    const chron: Ticket[] = [];
    let cost = 0;
    const costPrefix: number[] = [];

    for (let i = 0; i < HISTORY_TICKETS; i++) {
      const phase = historyPhase(i);
      const offline = i >= 520 && i < 524;
      const spec = this.drawSpec(phase.p, offline);
      const ticket = this.buildTicket(
        spec,
        now - (HISTORY_TICKETS - 1 - i) * HISTORY_TICKET_GAP_MS,
        phase.version,
        offline ? "offline" : "online",
      );
      chron.push(ticket);
      cost += ticket.cost_usd;
      if (ticket.source === "review") {
        this.reviewList.unshift({ id: ticket.id, text: ticket.text, created_at: ticket.created_at });
      }
      costPrefix.push(cost);
    }

    // one point per 10 tickets; local share smoothed over a centred window so the
    // curve starts near the base share and ends near the current model's share
    const half = SERIES_WINDOW_HISTORY / 2;
    for (let k = 0; k < HISTORY_POINTS; k++) {
      const end = (k + 1) * 10 - 1;
      const win = chron.slice(Math.max(0, end - half), Math.min(HISTORY_TICKETS, end + half + 1));
      const local = win.filter((t) => t.source === "local").length / win.length;
      this.seriesList.push({
        t: new Date(now - (HISTORY_POINTS - 1 - k) * 30000).toISOString(),
        local_share: round(local, 3),
        cost_cumulative: round(costPrefix[end], 4),
        cost_cloud_only_cumulative: round((end + 1) * TEACHER_COST_PER_TICKET, 4),
      });
    }

    this.ticketList = chron.slice(-TICKET_CAP).reverse();
    this.total = HISTORY_TICKETS;
    this.costTotal = cost;
    this.lastSeriesAt = now;

    // history rounds (promoted, v1 and v2)
    const rounds: Round[] = [];
    for (let n = 1; n <= 2; n++) {
      const script = ROUND_SCRIPT[n - 1];
      rounds.push(this.makeRound(n, script, `v${n}`, this.makeLossCurve(script.final_loss, n), "mlx", true));
    }
    this.roundList = rounds;
    // version switches happened at ticket 150 (v1) and 350 (v2); snap to series points
    this.markers = [
      { at: this.seriesList[14].t, version: "v1", promoted: true },
      { at: this.seriesList[34].t, version: "v2", promoted: true },
    ];
  }

  /** Where the history rounds were promoted, aligned to timeseries points. */
  historyMarkers(): { at: string; version: string; promoted: boolean }[] {
    return this.markers.slice();
  }

  /* ----- ticket generation ----- */

  private pickCategory(): number {
    const r = this.rng();
    let acc = 0;
    for (let i = 0; i < CATEGORY_WEIGHTS.length; i++) {
      acc += CATEGORY_WEIGHTS[i];
      if (r < acc) return i;
    }
    return CATEGORY_WEIGHTS.length - 1;
  }

  private drawSpec(share: number, forceUnsure = false): TicketSpec {
    const r = this.rng;
    const ambiguous = r() < AMBIGUOUS_RATE;
    let trueCat: number;
    let text: string;
    if (ambiguous) {
      const a = AMBIGUOUS_TEXTS[Math.floor(r() * AMBIGUOUS_TEXTS.length)];
      trueCat = a.cat;
      text = a.text;
    } else {
      trueCat = this.pickCategory();
      const texts = TICKET_TEXTS[trueCat];
      text = texts[Math.floor(r() * texts.length)];
      if (r() < 0.3) text += " " + SUFFIXES[Math.floor(r() * SUFFIXES.length)];
    }
    // P(local) = (1 - ambiguous rate) * q  ==> q chosen so the overall rate matches `share`
    const q = clamp(share / (1 - AMBIGUOUS_RATE), 0, 1);
    const confident = !ambiguous && !forceUnsure && r() < q;
    const localConf = confident
      ? 0.72 + 0.26 * Math.pow(r(), 0.8)
      : ambiguous
        ? 0.35 + 0.25 * r()
        : 0.35 + 0.34 * r();
    return { text, trueCat, localConf: round(localConf, 3) };
  }

  private route(confidence: number, mode: Mode): Source {
    if (confidence >= LOCAL_THRESHOLD) return "local";
    return mode === "online" ? "teacher" : "review";
  }

  private buildTicket(spec: TicketSpec, createdAtMs: number, version: string, mode: Mode): Ticket {
    const r = this.rng;
    const source = this.route(spec.localConf, mode);
    let category = spec.trueCat;
    let confidence = spec.localConf;
    let latency: number;
    let cost = 0;

    const wrongCat = (): number => {
      const other = Math.floor(r() * (CATEGORIES.length - 1));
      return other >= spec.trueCat ? other + 1 : other;
    };

    if (source === "teacher") {
      confidence = round(0.9 + 0.09 * r(), 3);
      latency = 900 + Math.floor(r() * 1300);
      cost = TEACHER_COST_PER_TICKET;
    } else if (source === "review") {
      latency = 120 + Math.floor(r() * 280);
      if (r() > 0.55) category = wrongCat();
    } else {
      latency = 120 + Math.floor(r() * 280);
      if (r() < (1 - confidence) * 0.25) category = wrongCat();
    }

    this.seq += 1;
    return {
      id: `tk_${String(this.seq).padStart(6, "0")}`,
      category,
      category_name: CATEGORY_NAMES[category],
      priority: derivePriority(category, spec.text),
      team: CATEGORIES[category].team,
      source,
      confidence,
      latency_ms: latency,
      cost_usd: cost,
      model_version: version,
      text: spec.text,
      created_at: new Date(createdAtMs).toISOString(),
    };
  }

  /** Apply a live ticket to counters/lists and emit it. */
  private record(ticket: Ticket): void {
    this.ticketList.unshift(ticket);
    if (this.ticketList.length > TICKET_CAP) this.ticketList.length = TICKET_CAP;
    this.total += 1;
    this.costTotal += ticket.cost_usd;
    if (ticket.source === "review") {
      this.reviewList.unshift({ id: ticket.id, text: ticket.text, created_at: ticket.created_at });
      if (this.reviewList.length > REVIEW_CAP) this.reviewList.length = REVIEW_CAP;
    }
    this.sinceSeriesPoint += 1;
    const now = Date.now();
    if (this.sinceSeriesPoint >= 5 || now - this.lastSeriesAt >= 5000) this.pushSeriesPoint(now);
    this.emit({ type: "prediction", data: ticket });
  }

  private pushSeriesPoint(nowMs: number): void {
    const t = new Date(nowMs).toISOString();
    const last = this.seriesList[this.seriesList.length - 1];
    this.sinceSeriesPoint = 0;
    this.lastSeriesAt = nowMs;
    if (last && last.t === t) return;
    const win = this.ticketList.slice(0, SERIES_WINDOW_LIVE);
    const local = win.length ? win.filter((x) => x.source === "local").length / win.length : 0;
    this.seriesList.push({
      t,
      local_share: round(local, 3),
      cost_cumulative: round(this.costTotal, 4),
      cost_cloud_only_cumulative: round(this.total * TEACHER_COST_PER_TICKET, 4),
    });
    if (this.seriesList.length > SERIES_CAP) this.seriesList.shift();
  }

  /* ----- stream ----- */

  private generateLive(): void {
    this.effShare += (this.targetShare - this.effShare) * 0.05;
    const spec = this.drawSpec(this.effShare);
    this.record(this.buildTicket(spec, Date.now(), this.modelVersion, this.mode));
  }

  private scheduleNext(): void {
    if (!this.streaming) return;
    const interval = 60000 / this.ratePerMin;
    const delay = Math.max(30, interval * (0.55 + 0.9 * this.rng()));
    this.streamTimer = setTimeout(() => {
      if (!this.streaming) return;
      this.generateLive();
      this.scheduleNext();
    }, delay);
  }

  /* ----- summary / eval helpers ----- */

  private computeSummary(): Summary {
    const w = this.ticketList.slice(0, SHARE_WINDOW);
    const n = w.length || 1;
    const local = round(w.filter((t) => t.source === "local").length / n, 3);
    const teacher = round(w.filter((t) => t.source === "teacher").length / n, 3);
    return {
      total: this.total,
      local_share: local,
      teacher_share: teacher,
      review_share: round(Math.max(0, 1 - local - teacher), 3),
      cost_usd_total: round(this.costTotal, 4),
      cost_avoided_usd: round(Math.max(0, this.total * TEACHER_COST_PER_TICKET - this.costTotal), 4),
      model_version: this.modelVersion,
      mode: this.mode,
    };
  }

  private computeHealth(): Health {
    return { status: "ok", model_version: this.modelVersion, mode: this.mode };
  }

  private promotedRounds(): Round[] {
    return this.roundList.filter((r) => r.promoted);
  }

  private computeEval(): EvalCompare {
    const promoted = this.promotedRounds();
    const models: EvalModel[] = [
      { name: BASE_NAME, ...BASE_EVAL, latency_ms: 310, cost_per_1k: 0 },
      ...promoted.map((r, i) => ({
        name: r.model_version,
        category_acc: r.eval.category_acc,
        category_macro_f1: r.eval.category_macro_f1,
        priority_acc: r.eval.priority_acc,
        latency_ms: 300 - 6 * i,
        cost_per_1k: 0,
      })),
      { name: TEACHER_NAME, ...TEACHER_EVAL },
    ];
    const local = models[models.length - 2];
    const teacher = models[models.length - 1];
    const s = this.computeSummary();
    const served = s.local_share + s.teacher_share;
    const lw = served > 0 ? s.local_share / served : 0;
    const mix = 0.55 + 0.35 * (1 - lw);
    const blend = (a: number, b: number): number => round(Math.min(b, a + (b - a) * mix), 3);
    const router: EvalModel = {
      name: ROUTER_NAME,
      category_acc: blend(local.category_acc, teacher.category_acc),
      category_macro_f1: blend(local.category_macro_f1, teacher.category_macro_f1),
      priority_acc: blend(local.priority_acc, teacher.priority_acc),
      latency_ms: Math.round(lw * local.latency_ms + (1 - lw) * teacher.latency_ms),
      cost_per_1k: round(s.teacher_share * TEACHER_COST_PER_TICKET * 1000, 3),
    };

    const per: Record<string, Record<string, number>> = {};
    const conf: Record<string, number[][]> = {};
    const all = [...models, router];
    all.forEach((m, idx) => {
      let scale = 1;
      if (m.name === TEACHER_NAME) scale = 0.2;
      else if (m.name === ROUTER_NAME) scale = 0.3;
      else if (m.name !== BASE_NAME) scale = 1 - 0.7 * Math.min(1, idx / 5);
      const f1 = this.categoryF1(m.name, m.category_macro_f1, scale);
      per[m.name] = Object.fromEntries(CATEGORY_NAMES.map((c, i) => [c, f1[i]]));
      conf[m.name] = this.confusion(m.name, m.category_acc, f1);
    });

    return { provisional: true, models, router, per_category_f1: per, confusion: conf };
  }

  private categoryF1(name: string, macro: number, scale: number): number[] {
    const r = mulberry32(hashString(name));
    const raw = CATEGORY_OFFSETS.map((o) => o * scale + (r() - 0.5) * 0.03);
    const mean = raw.reduce((a, b) => a + b, 0) / raw.length;
    return raw.map((x) => round(clamp(macro + x - mean, 0.3, 0.995), 3));
  }

  private confusion(name: string, acc: number, f1: number[]): number[][] {
    const r = mulberry32(hashString(name) ^ 0xa5a5);
    const pairs: Record<string, number> = {
      "0,1": 3, "1,0": 3, "2,3": 2, "3,2": 2, "3,4": 2, "4,3": 1.5, "4,0": 1.5,
      "5,4": 2.5, "5,0": 1.5, "5,1": 1.5, "4,5": 1.5, "2,1": 1.5,
    };
    const weighted = TEST_ROWS.reduce((a, n, c) => a + n * f1[c], 0);
    const k = weighted > 0 ? (acc * 200) / weighted : 1;
    return TEST_ROWS.map((n, c) => {
      const diag = Math.min(n, Math.round(n * clamp(f1[c] * k, 0, 0.995)));
      const weights = CATEGORY_NAMES.map((_, j) =>
        j === c ? 0 : (pairs[`${c},${j}`] ?? 1) * (0.8 + 0.4 * r()),
      );
      const off = distribute(n - diag, weights);
      return off.map((v, j) => (j === c ? diag : v));
    });
  }

  /* ----- rounds ----- */

  private makeLossCurve(finalLoss: number, salt: number): LossPoint[] {
    const r = mulberry32(SEED + 101 * salt);
    const start = 0.9 + finalLoss * 2.2;
    const out: LossPoint[] = [];
    for (let i = 0; i < LOSS_POINTS; i++) {
      const x = i / (LOSS_POINTS - 1);
      const decay = finalLoss + (start - finalLoss) * Math.exp(-5 * x);
      const noise = 1 + (r() - 0.5) * 2 * (0.07 * (1 - x) + 0.015);
      out.push({ step: (i + 1) * (TOTAL_STEPS / LOSS_POINTS), loss: round(decay * noise, 4) });
    }
    out[out.length - 1] = { step: TOTAL_STEPS, loss: round(finalLoss, 4) };
    return out;
  }

  private makeRound(
    n: number,
    script: RoundScript,
    version: string,
    curve: LossPoint[],
    backend: string,
    promoted: boolean,
  ): Round {
    const cloud = backend !== "mlx";
    return {
      round: n,
      model_version: version,
      examples: script.examples,
      loss: curve,
      wall_time_s: script.wall_time_s,
      hardware: cloud ? "Cloud GPU (A100) · LoRA" : HARDWARE,
      cost_usd: cloud ? round(script.examples * 0.0008, 4) : round(script.wall_time_s * 0.000004, 4),
      promoted,
      reason: script.reason,
      eval: { ...script.eval },
    };
  }

  private scriptFor(n: number): RoundScript {
    const idx = n - 1;
    if (idx < ROUND_SCRIPT.length) return ROUND_SCRIPT[idx];
    const last = ROUND_SCRIPT[ROUND_SCRIPT.length - 1];
    const k = idx - (ROUND_SCRIPT.length - 1);
    // geometric gains: each extra round gains half of the previous extra round
    const g = Array.from({ length: k }, (_, j) => 0.5 ** (j + 1)).reduce((a, b) => a + b, 0);
    const f1 = round(last.eval.category_macro_f1 + 0.012 * g, 3);
    return {
      promoted: true,
      examples: last.examples + 550 * k,
      wall_time_s: last.wall_time_s + 40 * k,
      local_share_target: round(Math.min(0.97, last.local_share_target + 0.03 * g), 3),
      eval: {
        category_acc: round(last.eval.category_acc + 0.012 * g, 3),
        category_macro_f1: f1,
        priority_acc: round(last.eval.priority_acc + 0.008 * g, 3),
      },
      reason: `Macro-F1 +${(0.012 * 0.5 ** k * 100).toFixed(1)} pts over the current model. Diminishing returns: the teacher still covers the long tail.`,
      final_loss: round(Math.max(0.08, last.final_loss * (1 - 0.08 * k)), 3),
    };
  }

  private jobProgress(job: Job, stage: TrainStage, stageP: number, overall: number): TrainProgress {
    const base: TrainProgress = { job_id: job.id, round: job.roundNo, stage, progress: round(overall, 3) };
    if (stage === "collect") {
      const n = Math.round(job.script.examples * stageP);
      return { ...base, message: `Collecting teacher-labelled tickets: ${n}/${job.script.examples} examples` };
    }
    if (stage === "train") {
      const idx = clamp(Math.ceil(stageP * LOSS_POINTS), 1, LOSS_POINTS);
      const pt = job.curve[idx - 1];
      return {
        ...base,
        step: pt.step,
        total_steps: TOTAL_STEPS,
        loss: pt.loss,
        message: `Fine-tuning LoRA adapters on-device: step ${pt.step}/${TOTAL_STEPS}, loss ${pt.loss.toFixed(3)}`,
      };
    }
    const finalLoss = job.curve[job.curve.length - 1].loss;
    if (stage === "evaluate") {
      return {
        ...base,
        step: TOTAL_STEPS,
        total_steps: TOTAL_STEPS,
        loss: finalLoss,
        message: "Scoring candidate on the 200-ticket held-out set",
      };
    }
    return {
      ...base,
      step: TOTAL_STEPS,
      total_steps: TOTAL_STEPS,
      loss: finalLoss,
      message: "Checking the evaluation gate against the serving model",
    };
  }

  private advanceJob(job: Job): void {
    job.tick += 1;
    const frac = Math.min(1, job.tick / job.totalTicks);
    let stage: TrainStage;
    let stageP: number;
    if (frac < 0.14) {
      stage = "collect";
      stageP = frac / 0.14;
    } else if (frac < 0.74) {
      stage = "train";
      stageP = (frac - 0.14) / 0.6;
    } else if (frac < 0.9) {
      stage = "evaluate";
      stageP = (frac - 0.74) / 0.16;
    } else {
      stage = "promote";
      stageP = (frac - 0.9) / 0.1;
    }
    const progress = this.jobProgress(job, stage, stageP, frac);
    if (job.tick >= job.totalTicks) {
      progress.message = job.script.promoted
        ? `Gate passed: promoting ${job.candidate} to serve live traffic`
        : `Gate rejected ${job.candidate}: keeping ${job.previousVersion}`;
    }
    this.emit({ type: "train_progress", data: progress });
    if (job.tick >= job.totalTicks) this.finishJob(job);
  }

  private finishJob(job: Job): void {
    if (job.timer) clearInterval(job.timer);
    this.job = null;
    const promoted = job.script.promoted;
    const version = promoted ? job.candidate : `${job.candidate}-rejected`;
    const round = this.makeRound(job.roundNo, job.script, version, job.curve, job.backend, promoted);
    this.roundList.push(round);
    const previous = this.modelVersion;
    if (promoted) {
      this.modelVersion = job.candidate;
      this.targetShare = Math.max(this.targetShare, job.script.local_share_target);
    }
    this.emit({ type: "round_complete", data: { job_id: job.id, round, previous_model_version: previous } });
  }

  /* ----- public contract (all async, with latency) ----- */

  health(): Promise<Health> {
    return this.wait(() => this.computeHealth());
  }

  classify(text: string): Promise<ClassifyResult> {
    return this.wait(() => {
      const lower = text.toLowerCase();
      const scores = CATEGORIES.map((c) => c.keywords.filter((k) => lower.includes(k)).length);
      const sorted = scores.map((s, i) => ({ s, i })).sort((a, b) => b.s - a.s);
      const best = sorted[0];
      const second = sorted[1];
      let cat = best.i;
      let conf: number;
      if (best.s === 0) {
        cat = this.pickCategory();
        conf = 0.35 + 0.2 * this.rng();
      } else {
        conf = clamp(
          0.5 + 0.12 * best.s - 0.1 * second.s + (this.effShare - 0.3) * 0.3 + (this.rng() - 0.5) * 0.06,
          0.3,
          0.97,
        );
      }
      const ticket = this.buildTicket(
        { text, trueCat: cat, localConf: round(conf, 3) },
        Date.now(),
        this.modelVersion,
        this.mode,
      );
      this.record(ticket);
      const result: ClassifyResult = {
        id: ticket.id,
        category: ticket.category,
        category_name: ticket.category_name,
        priority: ticket.priority,
        team: ticket.team,
        source: ticket.source,
        confidence: ticket.confidence,
        latency_ms: ticket.latency_ms,
        cost_usd: ticket.cost_usd,
        model_version: ticket.model_version,
      };
      return result;
    });
  }

  summary(): Promise<Summary> {
    return this.wait(() => this.computeSummary());
  }

  timeseries(): Promise<TimePoint[]> {
    return this.wait(() => this.seriesList.slice());
  }

  recentTickets(limit = 50): Promise<Ticket[]> {
    return this.wait(() => this.ticketList.slice(0, Math.max(0, limit)));
  }

  reviewQueue(): Promise<ReviewItem[]> {
    return this.wait(() => this.reviewList.slice());
  }

  rounds(): Promise<Round[]> {
    return this.wait(() => this.roundList.slice());
  }

  evalCompare(): Promise<EvalCompare> {
    return this.wait(() => this.computeEval());
  }

  snapshot(): Promise<Snapshot> {
    return this.wait(() => ({
      generated_at: new Date().toISOString(),
      health: this.computeHealth(),
      summary: this.computeSummary(),
      timeseries: this.seriesList.slice(),
      tickets: this.ticketList.slice(0, SNAPSHOT_TICKETS),
      review_queue: this.reviewList.slice(),
      rounds: this.roundList.slice(),
      eval_compare: this.computeEval(),
    }));
  }

  trainRound(req: TrainRoundRequest): Promise<TrainRoundResponse> {
    return this.wait(() => {
      if (this.job) return { job_id: this.job.id };
      this.jobSeq += 1;
      const roundNo = this.roundList.length + 1;
      const script = this.scriptFor(roundNo);
      const promotedCount = this.promotedRounds().length;
      const job: Job = {
        id: `job_${String(this.jobSeq).padStart(4, "0")}`,
        roundNo,
        backend: req.backend,
        script,
        curve: this.makeLossCurve(script.final_loss, roundNo),
        tick: 0,
        totalTicks: 56 + Math.floor(this.rng() * 17), // 14s .. 18s at 250ms
        previousVersion: this.modelVersion,
        candidate: `v${promotedCount + 1}`,
        timer: null,
      };
      this.job = job;
      this.emit({ type: "train_progress", data: this.jobProgress(job, "collect", 0, 0) });
      job.timer = setInterval(() => this.advanceJob(job), TICK_MS);
      return { job_id: job.id };
    });
  }

  streamStart(ratePerMin: number = DEFAULT_RATE): Promise<{ status: string; rate_per_min: number }> {
    return this.wait(() => {
      const rate = clamp(Number.isFinite(ratePerMin) ? ratePerMin : DEFAULT_RATE, MIN_RATE, MAX_RATE);
      this.ratePerMin = rate;
      if (this.streamTimer) clearTimeout(this.streamTimer);
      this.streaming = true;
      this.scheduleNext();
      return { status: "started", rate_per_min: rate };
    });
  }

  streamStop(): Promise<{ status: string }> {
    return this.wait(() => {
      this.streaming = false;
      if (this.streamTimer) clearTimeout(this.streamTimer);
      this.streamTimer = null;
      return { status: "stopped" };
    });
  }

  setOffline(offline: boolean): Promise<{ mode: Mode }> {
    return this.wait(() => {
      const next: Mode = offline ? "offline" : "online";
      if (next !== this.mode) {
        this.mode = next;
        this.emit({ type: "mode", data: { mode: next } });
      }
      return { mode: this.mode };
    });
  }

  /** Mock-only helper: nominal local share of the serving model (synchronous). */
  peekLocalTarget(): number {
    return this.targetShare;
  }
}

let instance: MockEngine | null = null;

export function getEngine(): MockEngine {
  if (!instance) instance = new MockEngine();
  return instance;
}
