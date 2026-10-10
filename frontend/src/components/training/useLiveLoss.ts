"use client";

import { useState } from "react";
import type { LossPoint, TrainProgress } from "@/lib/types";

interface Acc {
  jobId: string | null;
  points: LossPoint[];
}

/**
 * Accumulates (step, loss) points from incoming train_progress events, keyed by
 * job_id. Uses the "adjust state while rendering" pattern so no effect/extra
 * paint is needed; each branch only fires when the incoming data is new.
 */
export function useLiveLoss(tp: TrainProgress | null): LossPoint[] {
  const [acc, setAcc] = useState<Acc>({ jobId: null, points: [] });

  if (tp !== null) {
    if (acc.jobId !== tp.job_id) {
      const first =
        tp.step !== undefined && tp.loss !== undefined ? [{ step: tp.step, loss: tp.loss }] : [];
      setAcc({ jobId: tp.job_id, points: first });
    } else if (tp.step !== undefined && tp.loss !== undefined) {
      const last = acc.points[acc.points.length - 1];
      if (!last || tp.step > last.step) {
        setAcc({ jobId: acc.jobId, points: [...acc.points, { step: tp.step, loss: tp.loss }] });
      }
    }
  }

  return tp !== null && acc.jobId === tp.job_id ? acc.points : [];
}
