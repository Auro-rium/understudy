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
    <div className="stage-glow">
      <div className="mx-auto max-w-[120rem] space-y-6 px-4 py-6 sm:space-y-8 sm:px-8 sm:py-8">
        <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <h1 className="display text-4xl font-semibold leading-none sm:text-5xl">Live</h1>
          <MockBadge />
          <p className="basis-full text-xl text-ink-2 sm:basis-auto">
            Gemma answers locally and asks the cloud teacher only when unsure.
          </p>
        </header>

        <RoundBanner round={round} onDismiss={dismiss} />

        <LiveCounters pulse={!!round && round.round.promoted} />

        <ControlsBar />

        <div className="grid gap-6 2xl:grid-cols-12">
          <div className="grid content-start gap-6 min-w-0 xl:grid-cols-[repeat(2,minmax(0,1fr))] 2xl:col-span-4 2xl:col-start-9 2xl:row-start-1 2xl:grid-cols-[minmax(0,1fr)]">
            <ShareChart />
            <CostChart />
          </div>
          <div className="min-w-0 2xl:col-span-8 2xl:col-start-1 2xl:row-start-1">
            <TicketFeed />
          </div>
        </div>
        {state.loaded ? null : <p className="sr-only">Loading live data</p>}
      </div>
    </div>
  );
}
