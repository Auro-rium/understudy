"use client";

import { Card, EmptyState, Skeleton } from "@/components/ui";
import { useStore } from "@/lib/store";
import { CategoryF1Chart } from "./CategoryF1Chart";
import { ComparisonTable } from "./ComparisonTable";
import { ConfusionHeatmap } from "./ConfusionHeatmap";
import { MetricBarChart } from "./MetricBarChart";
import { ResultsHeader } from "./ResultsHeader";

function Frame({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-[120rem] px-4 py-8 sm:px-8 sm:py-12">{children}</div>;
}

export function ResultsView() {
  const { state } = useStore();
  const ec = state.evalCompare;

  if (!state.loaded) {
    return (
      <Frame>
        <Skeleton className="h-12 w-60" />
        <Skeleton className="mt-4 h-6 w-80" />
        <div className="mt-10 grid gap-6">
          <Card tone="plain">
            <Skeleton className="h-72 w-full" />
          </Card>
          <Card tone="plain">
            <Skeleton className="h-80 w-full" />
          </Card>
        </div>
      </Frame>
    );
  }

  if (!ec || ec.models.length === 0) {
    return (
      <Frame>
        <h1 className="display mb-6 text-[clamp(2.25rem,1.5rem+3vw,3.75rem)] font-semibold leading-none">
          Results
        </h1>
        <EmptyState
          title="No evaluation results yet"
          hint="Results appear here once a model has been scored on the human-labelled test set."
        />
      </Frame>
    );
  }

  return (
    <Frame>
      <ResultsHeader evalCompare={ec} />
      <div className="grid gap-6 sm:gap-8">
        <ComparisonTable evalCompare={ec} />
        <MetricBarChart evalCompare={ec} />
        <div className="grid gap-6 sm:gap-8 2xl:grid-cols-2">
          <CategoryF1Chart evalCompare={ec} />
          <ConfusionHeatmap evalCompare={ec} />
        </div>
      </div>
    </Frame>
  );
}
