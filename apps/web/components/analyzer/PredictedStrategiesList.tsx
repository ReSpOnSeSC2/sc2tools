"use client";

import { EmptyState } from "@/components/ui/Card";
import { pct } from "@/lib/format";

export type Prediction = {
  strategy: string;
  probability: number;
};

/**
 * Recency-weighted "likely strategies next" list. Mirrors the legacy
 * `PredictedStrategiesList` — last 10 games count 2x, every other
 * game 1x, sorted by probability descending.
 */
export function PredictedStrategiesList({
  predictions,
}: {
  predictions?: Prediction[];
}) {
  if (!predictions || predictions.length === 0) {
    return <EmptyState sub="Not enough games to predict" />;
  }
  return (
    <div className="space-y-1.5">
      {predictions.slice(0, 8).map((p) => (
        <div
          key={p.strategy}
          className="flex items-center gap-3"
          data-testid="predicted-strategy-row"
        >
          <div className="w-12 text-right text-sm font-semibold tabular-nums text-accent">
            {pct(p.probability)}
          </div>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-bg-elevated">
            <div
              className="h-full bg-accent"
              style={{ width: `${(p.probability * 100).toFixed(1)}%` }}
            />
          </div>
          <div className="min-w-[40%] flex-1 truncate text-sm text-text-muted">
            {p.strategy}
          </div>
        </div>
      ))}
      <div className="pt-2 text-[10px] text-text-dim">
        recency-weighted: last 10 games count 2× · all others 1×
      </div>
    </div>
  );
}
