"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "motion/react";
import { useStore } from "@/lib/store";
import { fmtInt, fmtPct, fmtUsd } from "@/lib/format";
import { AnimatedNumber, EmptyState, Skeleton, StatTile } from "@/components/ui";
import { Lineup } from "./Lineup";

/**
 * The hero is one idea: the page's own headline, a row of "seats" that fill
 * with the most recent real tickets (blue = the understudy handled it), and
 * the three numbers that summarise the whole run. Nothing here is decorative.
 */
export function Hero() {
  const { state } = useStore();
  const reduce = useReducedMotion();
  const s = state.summary;

  const rise = (delay: number) =>
    reduce
      ? {}
      : {
          initial: { opacity: 0, y: 14 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.6, delay, ease: [0.16, 1, 0.3, 1] as const },
        };

  const hasData = state.loaded && s !== null && s.total > 0;

  return (
    <section className="stage-glow border-b border-line">
      <div className="mx-auto max-w-[110rem] px-4 pb-12 pt-12 sm:px-8 sm:pb-16 sm:pt-16 lg:pt-20">
        <motion.h1
          {...rise(0)}
          className="display max-w-[22ch] text-[clamp(2.5rem,1.2rem+4.6vw,5.75rem)] font-semibold leading-[1.02] text-ink"
        >
          A local model that learns from a teacher, and gradually needs it less.
        </motion.h1>

        <motion.div {...rise(0.12)} className="mt-6 flex flex-wrap items-center gap-x-8 gap-y-4">
          <p className="max-w-2xl text-xl text-ink-2">
            Gig workers send support tickets in plain English. A small model on this machine routes them. It
            asks a larger cloud model only when it is unsure, and keeps what it learns.
          </p>
          <div className="flex items-center gap-5">
            <Link
              href="/live"
              className="rounded-md bg-spot px-5 py-2.5 text-lg font-semibold text-bg transition-opacity hover:opacity-90"
            >
              Start the demo
            </Link>
            <Link href="/results" className="text-lg text-ink-2 underline decoration-line-strong underline-offset-4 hover:text-ink">
              Jump to results
            </Link>
          </div>
        </motion.div>

        <motion.div {...rise(0.24)} className="mt-12">
          <Lineup />
        </motion.div>

        <motion.div {...rise(0.36)} className="mt-12">
          {!state.loaded ? (
            <div className="grid gap-8 sm:grid-cols-3" aria-busy="true">
              <Skeleton className="h-36" />
              <Skeleton className="h-36" />
              <Skeleton className="h-36" />
            </div>
          ) : hasData && s ? (
            <div className="grid gap-x-10 gap-y-9 sm:grid-cols-3">
              <StatTile
                label="Handled on this machine"
                accent="local"
                value={<AnimatedNumber value={s.local_share} format={(n) => fmtPct(n, 0)} />}
                sub={`of ${fmtInt(s.total)} tickets, no internet needed`}
              />
              <StatTile
                label="Paid to the cloud teacher"
                accent="teacher"
                value={<AnimatedNumber value={s.cost_usd_total} format={fmtUsd} />}
                sub="cloud cost so far"
              />
              <StatTile
                label="Cost avoided"
                accent="save"
                value={<AnimatedNumber value={s.cost_avoided_usd} format={fmtUsd} />}
                sub="compared with sending every ticket to the cloud"
              />
            </div>
          ) : (
            <EmptyState
              title="No tickets handled yet"
              hint={
                s === null
                  ? "The backend is not reachable and there is no saved snapshot. Open Live once it is running."
                  : "Start the demo and the numbers here fill in as tickets arrive."
              }
            />
          )}
        </motion.div>
      </div>
    </section>
  );
}
