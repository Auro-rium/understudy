/** The problem, stated plainly and without numbers we cannot back up. */
export function Problem() {
  return (
    <section className="border-b border-line">
      <div className="mx-auto grid max-w-[110rem] gap-10 px-4 py-14 sm:px-8 sm:py-20 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:gap-20">
        <h2 className="display text-[clamp(1.9rem,1.2rem+2.2vw,3.25rem)] font-semibold leading-[1.1] text-ink">
          Gig workers write in when something is wrong with their pay, their account, or their safety.
        </h2>

        <div className="divide-y divide-line text-lg text-ink-2">
          <p className="pb-6">
            <strong className="font-semibold text-ink">Tickets come in waves.</strong> A payout cycle, an app
            update or a bad week in one city can multiply the queue in an afternoon, and the people writing
            are usually waiting on money.
          </p>
          <p className="py-6">
            <strong className="font-semibold text-ink">Sending every ticket to a large cloud model is costly
            and needs a connection.</strong> The bill grows with every ticket, including the routine ones
            a small model could read just as well, and the whole desk stalls when the network drops.
          </p>
          <p className="pt-6">
            <strong className="font-semibold text-ink">Routing has to be right, and fast.</strong> A late
            payment, a deduction, a KYC problem, an app fault, a rating dispute and a safety report each
            belong to a different team. A safety report that lands in the wrong queue is worse than a slow
            reply.
          </p>
        </div>
      </div>
    </section>
  );
}
