"use client";

import { useStore } from "@/lib/store";
import { fmtPct, fmtUsd } from "@/lib/format";
import { AnimatedNumber, Skeleton, StatTile } from "@/components/ui";

/** Placeholder landing: proves store -> components -> shell works end to end. */
export default function Home() {
  const { state } = useStore();
  const s = state.summary;

  return (
    <div className="stage-glow">
      <div className="mx-auto max-w-[110rem] px-4 py-10 sm:px-8 sm:py-16">
        <h1 className="display text-[clamp(2.5rem,1.5rem+4vw,5rem)] font-semibold leading-none">
          Understudy
        </h1>
        <p className="mt-3 max-w-2xl text-xl text-ink-2">
          A small local model that learns from a cloud teacher, one ticket at a time.
        </p>

        <div className="mt-12 grid gap-10 sm:grid-cols-3">
          {state.loaded && s ? (
            <>
              <StatTile
                label="Answered locally"
                accent="local"
                value={<AnimatedNumber value={s.local_share} format={(n) => fmtPct(n, 0)} />}
                sub={`${s.total} tickets so far`}
              />
              <StatTile
                label="Cost so far"
                accent="teacher"
                value={<AnimatedNumber value={s.cost_usd_total} format={fmtUsd} />}
              />
              <StatTile
                label="Cost avoided"
                accent="save"
                value={<AnimatedNumber value={s.cost_avoided_usd} format={fmtUsd} />}
                sub="versus sending every ticket to the cloud"
              />
            </>
          ) : (
            <>
              <Skeleton className="h-40" />
              <Skeleton className="h-40" />
              <Skeleton className="h-40" />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
