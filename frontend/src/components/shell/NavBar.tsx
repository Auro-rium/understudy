"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useStore } from "@/lib/store";
import { MockBadge, ModeBadge, VersionChip, cx } from "@/components/ui";

const ITEMS = [
  { href: "/", label: "Home" },
  { href: "/live", label: "Live" },
  { href: "/training", label: "Training" },
  { href: "/results", label: "Results" },
] as const;

export function NavBar() {
  const pathname = usePathname();
  const { state } = useStore();

  return (
    <header className="border-b border-line bg-bg/90 backdrop-blur">
      <div className="mx-auto flex max-w-[110rem] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:px-8">
        <Link href="/" className="flex items-baseline gap-2" aria-label="Understudy home">
          <span className="display text-2xl font-semibold tracking-tight text-ink">Understudy</span>
          <span className="text-sm text-ink-3">e/acc</span>
        </Link>

        <nav aria-label="Primary" className="-mx-1 order-3 w-full overflow-x-auto sm:order-none sm:w-auto">
          <ul className="flex items-center gap-1">
            {ITEMS.map((it) => {
              const active = it.href === "/" ? pathname === "/" : pathname.startsWith(it.href);
              return (
                <li key={it.href}>
                  <Link
                    href={it.href}
                    aria-current={active ? "page" : undefined}
                    className={cx(
                      "relative block whitespace-nowrap rounded-md px-3 py-1.5 text-lg transition-colors",
                      active ? "text-ink" : "text-ink-3 hover:text-ink",
                    )}
                  >
                    {it.label}
                    {active ? (
                      <span aria-hidden className="absolute inset-x-3 -bottom-[13px] h-0.5 rounded-full bg-spot" />
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <MockBadge />
          {state.loaded || state.modelVersion ? <VersionChip version={state.modelVersion || "–"} /> : null}
          <ModeBadge mode={state.mode} />
        </div>
      </div>
    </header>
  );
}
