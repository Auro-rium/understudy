"use client";

import { useStore } from "@/lib/store";
import type { LossPoint, TrainProgress } from "@/lib/types";

/**
 * (step, loss) points of the running job. They accumulate in the store (not in this
 * component) so navigating to /training mid-round still shows the whole curve.
 */
export function useLiveLoss(tp: TrainProgress | null): LossPoint[] {
  const { state } = useStore();
  const trace = state.lossTrace;
  return tp !== null && trace.jobId === tp.job_id ? trace.points : [];
}
