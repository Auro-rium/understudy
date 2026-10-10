"use client";

import { Card } from "@/components/ui";
import { useStore } from "@/lib/store";
import { fmtMinutes } from "./roundData";

export function Explainers() {
  const { state } = useStore();
  const times = state.rounds.map((r) => r.wall_time_s).filter((s) => s > 0);
  const range =
    times.length > 0
      ? ` In this export, a round took between ${fmtMinutes(Math.min(...times))} and ${fmtMinutes(Math.max(...times))}.`
      : "";
  const provisional = state.evalCompare?.provisional === true;

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card as="article" title="What LoRA fine-tuning does" className="sm:p-6">
        <div className="max-w-prose space-y-3 text-lg leading-relaxed text-ink-2">
          <p>
            Retraining a whole model means updating all of its weights. LoRA leaves the original weights alone and
            trains a small add-on, called an adapter, that nudges the model&rsquo;s answers.
          </p>
          <p>
            Because the adapter is small, a round trains on this Mac through MLX instead of renting cloud GPUs, and the
            training cost in this export is $0.00.{range}
          </p>
          <p>
            A new adapter is not trusted automatically. After training it is scored, and it is promoted only if its
            macro-F1 beats the model already in use.
            {provisional
              ? " Those scores are provisional: the evaluation labels come from the teacher model and have not been checked by people."
              : ""}
          </p>
        </div>
      </Card>
      <Card as="article" title="How confidence routing decides" className="sm:p-6">
        <div className="max-w-prose space-y-3 text-lg leading-relaxed text-ink-2">
          <p>
            For every ticket, the local model picks one of the eight categories and reports how confident it is in
            that pick.
          </p>
          <p>
            Above the confidence threshold, the local answer is used straight away: it is free and fast. Below it, the
            ticket goes to the cloud teacher, which costs money and is slower, and the teacher&rsquo;s answer becomes a
            new training example.
          </p>
          <p>
            When the system is offline, unsure tickets are not guessed at. They wait in a human review queue instead.
          </p>
        </div>
      </Card>
    </div>
  );
}
