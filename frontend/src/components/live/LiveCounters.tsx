"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useStore } from "@/lib/store";
import { fmtInt, fmtPct, fmtUsd } from "@/lib/format";
import { AnimatedNumber, EmptyState, ModeBadge, Skeleton, StatTile, cx } from "@/components/ui";
import { ModelSwitch } from "./ModelSwitch";

/** Version tile: the big version string flips like a departure board when it changes. */
function VersionTile({ version, mode, pulse }: { version: string; mode: "online" | "offline"; pulse: boolean }) {
  const reduce = useReducedMotion();
  return (
    <div className="relative pl-5">
      <span aria-hidden className="absolute bottom-1 left-0 top-1 w-1 rounded-full bg-spot" />
      <p className="text-lg text-ink-2">Model serving</p>
      <div className="mt-0.5 inline-block rounded-xl" style={{ perspective: 600 }}>
        <div className={cx("rounded-xl", pulse && "pulse-ring")}>
          <AnimatePresence mode="wait" initial={false}>
            <motion.p
              key={version}
              initial={reduce ? { opacity: 0 } : { opacity: 0, rotateX: -80, y: 12 }}
              animate={reduce ? { opacity: 1 } : { opacity: 1, rotateX: 0, y: 0 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, rotateX: 80, y: -12 }}
              transition={{ duration: 0.35, ease: "easeOut" }}
              className="num display px-1 text-[clamp(3rem,2rem+4.5vw,6rem)] font-semibold leading-[1.02] text-ink 2xl:text-[4.75rem]"
              style={{ transformOrigin: "50% 50%" }}
            >
              {version || "–"}
            </motion.p>
          </AnimatePresence>
        </div>
      </div>
      <div className="mt-1 flex items-center gap-3">
        <ModeBadge mode={mode} className="text-lg!" />
        <span className="text-lg text-ink-3">{mode === "online" ? "teacher reachable" : "no cloud teacher"}</span>
      </div>
      <ModelSwitch className="mt-3" />
    </div>
  );
}

export function LiveCounters({ pulse }: { pulse: boolean }) {
  const { state } = useStore();
  const s = state.summary;

  if (!state.loaded) {
    return (
      <div className="grid gap-8 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-44" />
        ))}
      </div>
    );
  }
  if (!s) {
    return <EmptyState title="No data to show" hint="The backend is unreachable and no saved snapshot is available." />;
  }

  const idle = !(s.total > 0);

  return (
    <section aria-label="Headline numbers" className="grid gap-x-10 gap-y-8 sm:grid-cols-2 xl:grid-cols-4 2xl:gap-y-0">
      <StatTile
        valueClassName="2xl:text-[4.75rem]"
        label="Handled locally"
        accent="local"
        value={
          idle ? (
            <span aria-label="No tickets yet">–</span>
          ) : (
            <AnimatedNumber value={s.local_share} format={(n) => fmtPct(n, 1)} />
          )
        }
        sub={
          idle
            ? "No live traffic recorded yet"
            : `${fmtInt(s.total)} tickets · teacher ${fmtPct(s.teacher_share)} · review ${fmtPct(s.review_share)}`
        }
      />
      <StatTile
        valueClassName="2xl:text-[4.75rem]"
        label="Cloud cost so far"
        accent="teacher"
        value={<AnimatedNumber value={s.cost_usd_total} format={fmtUsd} />}
        sub="paid to the cloud teacher"
      />
      <StatTile
        valueClassName="2xl:text-[4.75rem]"
        label="Cost avoided"
        accent="save"
        value={<AnimatedNumber value={s.cost_avoided_usd} format={fmtUsd} />}
        sub="vs. sending every ticket to the cloud"
      />
      <VersionTile version={state.modelVersion} mode={state.mode} pulse={pulse} />
    </section>
  );
}
