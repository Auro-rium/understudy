const STEPS = [
  {
    name: "Ticket",
    body: "A worker's message arrives in English.",
    dot: "border-ink-2",
    text: "text-ink",
  },
  {
    name: "Local model",
    body: "Gemma on this machine picks a category and priority, which decides the team. If it is sure, we are done.",
    dot: "border-local",
    text: "text-local",
  },
  {
    name: "Teacher, only when unsure",
    body: "The cloud model answers the hard ones. Offline, those wait in a human review queue instead.",
    dot: "border-teacher",
    text: "text-teacher",
  },
  {
    name: "Training data",
    body: "Each teacher answer becomes a labelled example. A LoRA round turns them into the next local version.",
    dot: "border-good",
    text: "text-good",
  },
] as const;

/** The loop as a plain sequence: a vertical rail on small screens, a horizontal one on wide screens. */
export function Loop() {
  return (
    <section className="border-b border-line">
      <div className="mx-auto max-w-[110rem] px-4 py-14 sm:px-8 sm:py-20">
        <h2 className="display max-w-[30ch] text-[clamp(1.9rem,1.2rem+2.2vw,3.25rem)] font-semibold leading-[1.1] text-ink">
          Every question the teacher answers is one the local model gets to keep.
        </h2>

        <ol className="mt-10 grid">
          {STEPS.map((s) => (
            <li
              key={s.name}
              className="relative border-l-2 border-line-strong pb-8 pl-5 last:pb-0 lg:hidden"
            >
              <span aria-hidden className={`absolute -left-[7px] top-1.5 size-3 rounded-full border-2 bg-bg ${s.dot}`} />
              <h3 className={`text-xl font-semibold ${s.text}`}>{s.name}</h3>
              <p className="mt-1 max-w-[40ch] text-lg text-ink-2">{s.body}</p>
            </li>
          ))}
        </ol>

        <ol className="mt-10 hidden grid-cols-4 lg:grid">
          {STEPS.map((s) => (
            <li key={s.name} className="relative border-t-2 border-line-strong pr-8 pt-5">
              <span aria-hidden className={`absolute -top-[7px] left-0 size-3 rounded-full border-2 bg-bg ${s.dot}`} />
              <h3 className={`text-xl font-semibold ${s.text}`}>{s.name}</h3>
              <p className="mt-1 max-w-[34ch] text-lg text-ink-2">{s.body}</p>
            </li>
          ))}
        </ol>

        <p className="mt-8 max-w-3xl text-lg text-ink-3">
          Then the loop closes: the new version serves the next tickets, handles more of them itself, and
          asks the teacher less. That falling cloud bill is what the numbers above are measuring.
        </p>
      </div>
    </section>
  );
}
