"use client";

import { useStore } from "@/lib/store";
import { MockBadge } from "@/components/ui";
import { ControlsBar } from "@/components/live/ControlsBar";
import { CostChart } from "@/components/live/CostChart";
import { LiveCounters } from "@/components/live/LiveCounters";
import { RoundBanner } from "@/components/live/RoundBanner";
import { ShareChart } from "@/components/live/ShareChart";
import { TicketFeed } from "@/components/live/TicketFeed";
import { useRoundHighlight } from "@/components/live/useRoundHighlight";

export default function LivePage() {
  const { state } = useStore();
  const { round, dismiss } = useRoundHighlight();

  return (
    <div className="stage-glow 2xl:flex 2xl:h-[calc(100dvh-4.1rem)] 2xl:[body:has([data-banner])_&]:h-[calc(100dvh-6.5rem)] 2xl:min-h-[46rem] 2xl:flex-col">
      <div className="mx-auto flex w-full max-w-[120rem] flex-col gap-6 px-4 py-6 sm:gap-8 sm:px-8 sm:py-8 2xl:min-h-0 2xl:flex-1 2xl:gap-4 2xl:py-4">
        <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <h1 className="display text-4xl font-semibold leading-none sm:text-5xl 2xl:text-4xl">Live</h1>
          <MockBadge />
          <p className="basis-full text-xl text-ink-2 sm:basis-auto">
            Gemma answers locally and asks the cloud teacher only when unsure.
          </p>
        </header>

        <RoundBanner round={round} onDismiss={dismiss} />

        <LiveCounters pulse={!!round && round.round.promoted} />

        <ControlsBar />

        <div className="grid gap-6 2xl:min-h-0 2xl:flex-1 2xl:grid-cols-12 2xl:grid-rows-1">
          <div className="grid min-w-0 content-start gap-6 xl:grid-cols-[repeat(2,minmax(0,1fr))] 2xl:col-span-4 2xl:col-start-9 2xl:row-start-1 2xl:min-h-0 2xl:grid-cols-[minmax(0,1fr)] 2xl:grid-rows-[repeat(2,minmax(0,1fr))] 2xl:gap-4">
            <ShareChart />
            <CostChart />
          </div>
          <div className="min-w-0 2xl:col-span-8 2xl:col-start-1 2xl:row-start-1 2xl:min-h-0">
            <TicketFeed />
          </div>
        </div>
        {state.loaded ? null : <p className="sr-only">Loading live data</p>}
      </div>
    </div>
  );
}
