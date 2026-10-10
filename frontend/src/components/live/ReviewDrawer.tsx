"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";
import { fmtTime } from "@/lib/format";
import { EmptyState } from "@/components/ui";
import type { ReviewItem } from "@/lib/types";

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function ReviewDrawer({
  open,
  onClose,
  items,
}: {
  open: boolean;
  onClose: () => void;
  items: ReviewItem[];
}) {
  const reduce = useReducedMotion();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const nodes = panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open ? (
        <div className="fixed inset-0 z-50">
          <motion.div
            className="absolute inset-0 bg-black/60"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            aria-hidden
          />
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="review-drawer-title"
            className="absolute inset-y-0 right-0 flex w-full max-w-xl flex-col border-l border-line-strong bg-surface shadow-2xl shadow-black/60"
            initial={reduce ? { opacity: 0 } : { x: "100%" }}
            animate={reduce ? { opacity: 1 } : { x: 0 }}
            exit={reduce ? { opacity: 0 } : { x: "100%" }}
            transition={{ duration: 0.28, ease: "easeOut" }}
          >
            <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
              <div>
                <h2 id="review-drawer-title" className="text-2xl font-semibold text-ink">
                  Review queue
                </h2>
                <p className="mt-1 text-base text-ink-3">
                  Tickets the local model was unsure about and the teacher could not answer. A person picks these up.
                </p>
              </div>
              <button
                ref={closeRef}
                type="button"
                onClick={onClose}
                className="min-h-12 shrink-0 rounded-lg border border-line-strong px-4 text-lg font-medium text-ink hover:bg-surface-3"
              >
                Close
              </button>
            </header>
            <div className="flex-1 overflow-y-auto px-5 py-4">
              {items.length === 0 ? (
                <EmptyState
                  title="Nothing waiting for review"
                  hint="No ticket has been sent to review yet. Unsure tickets land here when the teacher is unreachable."
                />
              ) : (
                <ul className="space-y-3">
                  {items.map((it) => (
                    <li key={it.id} className="rounded-lg border border-review/40 bg-review/5 px-4 py-3">
                      <p className="text-lg leading-snug text-ink">{it.text}</p>
                      <p className="num mt-1 text-base text-ink-3">
                        Ticket #{it.id} · queued {fmtTime(it.created_at)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>
  );
}
