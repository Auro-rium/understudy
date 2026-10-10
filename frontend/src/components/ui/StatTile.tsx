import type { ReactNode } from "react";
import { accentBg, accentText, cx, type Accent } from "./cx";

interface StatTileProps {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  accent?: Accent;
  className?: string;
}

/**
 * Projector-scale stat. Left rule carries the accent; the number is the
 * loudest thing in the tile. Not a card: no fill, just structure.
 */
export function StatTile({ label, value, sub, accent, className }: StatTileProps) {
  return (
    <div className={cx("relative pl-5", className)}>
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
          "num display text-[clamp(3rem,2rem+4.5vw,6rem)] font-semibold leading-[1.02]",
          accent ? accentText[accent] : "text-ink",
        )}
      >
        {value}
      </p>
      {sub ? <p className="mt-1 text-base text-ink-3">{sub}</p> : null}
    </div>
  );
}
