"use client";

import { motion, useReducedMotion } from "motion/react";
import { useMemo } from "react";
import { useStore } from "@/lib/store";
import { cx } from "@/components/ui";
import type { Source } from "@/lib/types";

const SEATS = 60;

const FILL: Record<Source, string> = {
  local: "bg-local",
  teacher: "bg-teacher",
  review: "bg-review",
};

const LABEL: Record<Source, string> = {
  local: "answered locally",
  teacher: "asked the teacher",
  review: "sent to human review",
};

/**
 * One seat per recent ticket, oldest on the left. A seat is blue when the
 * local model handled it, orange when the teacher had to, violet when it
 * waited for a person. As the model improves the row turns blue.
 */
export function Lineup() {
  const { state } = useStore();
  const reduce = useReducedMotion();

  const recent = useMemo(() => state.tickets.slice(0, SEATS).reverse(), [state.tickets]);

  const counts = useMemo(() => {
    const c: Record<Source, number> = { local: 0, teacher: 0, review: 0 };
    for (const t of recent) c[t.source] += 1;
    return c;
  }, [recent]);

  const empty = SEATS - recent.length;
  const summary =
    recent.length === 0
      ? "No recent tickets yet"
      : `Last ${recent.length} tickets: ${counts.local} answered locally, ${counts.teacher} asked the teacher, ${counts.review} sent to human review`;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <p className="text-lg text-ink-2">
          {recent.length === 0 ? "The most recent tickets will line up here." : `The last ${recent.length} tickets, oldest to newest`}
        </p>
        <ul className="flex flex-wrap items-center gap-x-5 gap-y-1 text-base text-ink-2" aria-hidden>
          {(Object.keys(LABEL) as Source[]).map((k) => (
            <li key={k} className="flex items-center gap-2">
              <span className={cx("inline-block h-3 w-1.5 rounded-sm", FILL[k])} />
              <span>
                {LABEL[k]}
                {recent.length > 0 ? <span className="num text-ink-3"> {counts[k]}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div role="img" aria-label={summary} className="flex h-14 items-end gap-[3px] sm:h-16 sm:gap-1">
        {recent.map((t) => (
          <motion.span
            key={t.id}
            title={`${t.category_name}, ${LABEL[t.source]}`}
            initial={reduce ? false : { opacity: 0, scaleY: 0.2 }}
            animate={{ opacity: 1, scaleY: 1 }}
            transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
            style={{ originY: 1 }}
            className={cx("h-full flex-1 rounded-[3px]", FILL[t.source])}
          />
        ))}
        {Array.from({ length: empty }, (_, i) => (
          <span key={`e${i}`} className="h-full flex-1 rounded-[3px] border border-line/80" />
        ))}
      </div>
    </div>
  );
}
