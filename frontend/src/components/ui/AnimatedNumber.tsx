"use client";

import { animate, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";

interface AnimatedNumberProps {
  value: number;
  format: (n: number) => string;
  durationMs?: number;
  className?: string;
}

/**
 * Counts from the previously shown value to the new one. The DOM text is
 * written imperatively during the tween so React never re-renders per frame.
 * Reduced motion: jumps straight to the target.
 */
export function AnimatedNumber({
  value,
  format,
  durationMs = 900,
  className,
}: AnimatedNumberProps) {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef(value);
  const fmt = useRef(format);
  // First paint (also SSR) shows the real value; later text is driven by the tween.
  const [initial] = useState(() => format(value));

  useEffect(() => {
    fmt.current = format;
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const from = shown.current;
    if (reduce || from === value || !Number.isFinite(from) || !Number.isFinite(value)) {
      shown.current = value;
      el.textContent = fmt.current(value);
      return;
    }
    const controls = animate(from, value, {
      duration: durationMs / 1000,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (v) => {
        shown.current = v;
        el.textContent = fmt.current(v);
      },
      onComplete: () => {
        shown.current = value;
        el.textContent = fmt.current(value);
      },
    });
    return () => controls.stop();
  }, [value, durationMs, reduce]);

  return (
    <span ref={ref} className={`num ${className ?? ""}`}>
      {initial}
    </span>
  );
}
