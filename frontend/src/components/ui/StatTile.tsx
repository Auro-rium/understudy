import type { ReactNode } from "react";
import { accentBg, accentText, cx, type Accent } from "./cx";

interface StatTileProps {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  accent?: Accent;
  className?: string;
  valueClassName?: string;
  /**
   * Size the number from the tile's own width (container query units) instead of the viewport,
   * so it never spills into the neighbouring column. Used where tiles sit in a tight row.
   */
  fit?: boolean;
}

/** Same ceiling as the viewport-based size on the largest screens, but it shrinks with the column. */
export const FIT_VALUE_SIZE = "text-[clamp(2.25rem,26cqw,5rem)] whitespace-nowrap";

/**
 * Projector-scale stat. Left rule carries the accent; the number is the
 * loudest thing in the tile. Not a card: no fill, just structure.
 */
export function StatTile({ label, value, sub, accent, className, valueClassName, fit }: StatTileProps) {
  return (
    <div className={cx("relative pl-5", fit && "@container", className)}>
      <span
        aria-hidden
        className={cx(
          "absolute bottom-1 left-0 top-1 w-1 rounded-full",
          accent ? accentBg[accent] : "bg-line-strong",
        )}
      />
      <p className="text-lg text-ink-2">{label}</p>
      <p
        className={cx(
          "num display font-semibold leading-[1.02]",
          fit ? FIT_VALUE_SIZE : "text-[clamp(3rem,2rem+4.5vw,6rem)]",
          accent ? accentText[accent] : "text-ink",
          valueClassName,
        )}
      >
        {value}
      </p>
      {sub ? <p className="mt-1 text-lg text-ink-3">{sub}</p> : null}
    </div>
  );
}
