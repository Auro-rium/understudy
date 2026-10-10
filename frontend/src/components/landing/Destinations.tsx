import Link from "next/link";

const PAGES = [
  {
    href: "/live",
    title: "Live",
    body: "With the backend running, start a stream of tickets and watch each one get routed, then turn the network off and work the review queue.",
  },
  {
    href: "/training",
    title: "Training",
    body: "Every training round so far: loss curve, test-set scores, and whether it was promoted or rejected. With the backend running you can start a new one.",
  },
  {
    href: "/results",
    title: "Results",
    body: "See the base model, the trained model and the teacher compared on accuracy, speed and cost.",
  },
] as const;

/** Three destinations as a list of large links, not cards. */
export function Destinations() {
  return (
    <section className="border-b border-line">
      <div className="mx-auto max-w-[120rem] px-4 py-14 sm:px-8 sm:py-20">
        <h2 className="display text-[clamp(1.9rem,1.2rem+2.2vw,3.25rem)] font-semibold leading-[1.1] text-ink">
          Where to look
        </h2>
        <ul className="mt-8 divide-y divide-line border-y border-line">
          {PAGES.map((p) => (
            <li key={p.href}>
              <Link
                href={p.href}
                className="group grid items-baseline gap-x-10 gap-y-1 px-1 py-6 sm:grid-cols-[14rem_1fr_auto]"
              >
                <span className="display text-3xl font-semibold text-ink">{p.title}</span>
                <span className="max-w-[60ch] text-lg text-ink-2">{p.body}</span>
                <span
                  aria-hidden
                  className="hidden text-2xl text-ink-3 transition-transform duration-200 group-hover:translate-x-1 group-hover:text-spot sm:block"
                >
                  →
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
