"use client";

import { motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import { categoryLabel } from "@/lib/categories";
import { useStore } from "@/lib/store";
import { fmtInt, fmtMs, fmtTime, fmtUsd } from "@/lib/format";
import { Card, ConfidenceBar, EmptyState, PriorityChip, SourceChip, cx } from "@/components/ui";
import type { Ticket } from "@/lib/types";

const VISIBLE = 12;
const COLS =
  "md:grid-cols-[minmax(0,1fr)_11rem_6.5rem_7.5rem_9rem_5.5rem_5rem]";

function FeedRow({ ticket, animateIn }: { ticket: Ticket; animateIn: boolean }) {
  const reduce = useReducedMotion();
  const animate = animateIn && !reduce;
  return (
    <motion.li
      layout={reduce ? false : "position"}
      initial={animate ? { opacity: 0, y: -18, backgroundColor: "rgba(242,193,78,0.22)" } : false}
      animate={{ opacity: 1, y: 0, backgroundColor: "rgba(242,193,78,0)" }}
      transition={{
        layout: { duration: 0.3, ease: "easeOut" },
        opacity: { duration: 0.35 },
        y: { duration: 0.35, ease: "easeOut" },
        backgroundColor: { duration: 1.8, ease: "easeOut" },
      }}
      className={cx("grid gap-x-4 gap-y-2 border-b border-line px-4 py-3 last:border-b-0 md:items-center", COLS)}
    >
      <div className="min-w-0">
        <p className="line-clamp-2 text-lg leading-snug text-ink">{ticket.text}</p>
        <p className="num mt-0.5 text-base text-ink-3">{fmtTime(ticket.created_at)}</p>
      </div>
      <div className="min-w-0">
        <p className="truncate text-lg font-medium text-ink">{categoryLabel(ticket.category)}</p>
        <p className="truncate text-base text-ink-3">{ticket.team}</p>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 md:contents">
        <div>
          <PriorityChip priority={ticket.priority} />
        </div>
        <div>
          <SourceChip source={ticket.source} />
        </div>
        <ConfidenceBar value={ticket.confidence} source={ticket.source} />
        <span className="num text-base text-ink-2 md:text-right">{fmtMs(ticket.latency_ms)}</span>
        {ticket.cost_usd > 0 ? (
          <span className="num text-base font-medium text-ink md:text-right">{fmtUsd(ticket.cost_usd)}</span>
        ) : (
          <span aria-hidden className="hidden md:block" />
        )}
      </div>
    </motion.li>
  );
}

function FeedList({ tickets, canControl }: { tickets: Ticket[]; canControl: boolean }) {
  // Rows present on first paint never animate in; anything arriving later does.
  const [initialIds] = useState(() => new Set(tickets.map((t) => t.id)));
  return (
    <div>
      <div
        aria-hidden
        className={cx("hidden gap-x-4 border-b border-line-strong px-4 pb-2 text-base text-ink-3 md:grid", COLS)}
      >
        <span>Ticket</span>
        <span>Category / team</span>
        <span>Priority</span>
        <span>Handled by</span>
        <span>Confidence</span>
        <span className="text-right">Latency</span>
        <span className="text-right">Cost</span>
      </div>
      {tickets.length === 0 ? (
        <div className="px-4 pb-4 pt-2">
          {canControl ? (
            <EmptyState
              title="No live traffic yet. Press Start stream."
              hint="Each ticket appears here the moment it is routed."
            />
          ) : (
            <EmptyState
              title="No live traffic has been recorded yet"
              hint="This is a saved snapshot, so nothing is streaming. Connect the backend, then press Start stream to watch tickets get routed here."
            />
          )}
        </div>
      ) : (
        <ul aria-label="Most recent tickets, newest first">
          {tickets.map((t) => (
            <FeedRow key={String(t.id)} ticket={t} animateIn={!initialIds.has(t.id)} />
          ))}
        </ul>
      )}
    </div>
  );
}

export function TicketFeed() {
  const { state } = useStore();
  const tickets = state.tickets.slice(0, VISIBLE);

  return (
    <Card className="p-0 sm:p-0 2xl:flex 2xl:h-full 2xl:min-h-0 2xl:flex-col">
      <header className="flex items-baseline justify-between gap-3 px-4 pb-3 pt-4 sm:px-5 sm:pt-5">
        <h2 className="text-xl font-semibold text-ink">Live ticket feed</h2>
        <span className="flex items-center gap-4">
          <span className="inline-flex items-center gap-2 text-base text-ink-2" aria-live="polite">
            <span aria-hidden className={cx("size-2.5 rounded-full", state.streaming ? "bg-spot" : "bg-ink-3")} />
            {state.streaming ? "Streaming" : state.canControl ? "Paused" : "Not connected"}
          </span>
          {state.summary ? (
            <span className="num hidden text-base text-ink-3 sm:inline">{fmtInt(state.summary.total)} total</span>
          ) : null}
        </span>
      </header>
      <div className="pb-2 2xl:min-h-0 2xl:flex-1 2xl:overflow-hidden 2xl:[mask-image:linear-gradient(to_bottom,black_calc(100%-3.5rem),transparent)]">
        {state.loaded ? (
          <FeedList tickets={tickets} canControl={state.canControl} />
        ) : (
          <div className="space-y-3 px-4 pb-4">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="h-14 animate-pulse rounded-md bg-surface-3/70" />
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
