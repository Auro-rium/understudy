import { Card } from "@/components/ui";

export function Explainers() {
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card as="article" title="What LoRA fine-tuning does" className="sm:p-6">
        <div className="max-w-prose space-y-3 text-lg leading-relaxed text-ink-2">
          <p>
            Fine-tuning a whole model means updating all of its weights. LoRA freezes the base model&rsquo;s weights
            and trains small low-rank adapter matrices that sit on top of them.
          </p>
          <p>
            Because only the adapters change, training fits on a laptop and takes minutes, and adapters can be
            swapped in and out without touching the base model.
          </p>
          <p>
            The training data is the cloud teacher&rsquo;s labelled answers. Before a new adapter replaces the old
            one, an evaluation gate scores it on held-out tickets that humans labelled, and only a candidate that
            holds up is promoted.
          </p>
        </div>
      </Card>
      <Card as="article" title="How confidence routing decides" className="sm:p-6">
        <div className="max-w-prose space-y-3 text-lg leading-relaxed text-ink-2">
          <p>For every ticket, the local model scores its own confidence in the answer it gives.</p>
          <p>
            Above a confidence threshold, the local answer is used straight away: it is free and fast. Below it, the
            ticket goes to the cloud teacher, which costs money and is slower, and the teacher&rsquo;s answer is
            saved as a new training example.
          </p>
          <p>
            When the system is offline, unsure tickets are not guessed at. They wait in a human review queue instead.
          </p>
        </div>
      </Card>
    </div>
  );
}
