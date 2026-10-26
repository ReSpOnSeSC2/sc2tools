"use client";

import { EmptyState } from "@/components/ui/Card";
import { pct } from "@/lib/format";
import { StrategyLabel } from "@/components/definitions/StrategyLabel";
import { ForecastStats } from "@/components/scouting/ForecastStats";
import { ForecastExplanation } from "@/components/scouting/ForecastExplanation";

export type Prediction = {
  strategy: string;
  probability: number;
};

/**
 * Shared posterior when present. Older APIs retain their explicitly labelled
 * legacy weighting; an incomplete new forecast never substitutes that list.
 */
export function PredictedStrategiesList({
  predictions,
  forecast,
}: {
  predictions?: Prediction[];
  forecast?: unknown;
}) {
  if (forecast !== undefined) return <div className="space-y-2"><ForecastStats value={forecast} /><ForecastExplanation /></div>;
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
            <StrategyLabel label={p.strategy} />
          </div>
        </div>
      ))}
      <div className="pt-2 text-micro text-text-dim">
        recency-weighted: last 10 games count 2× · all others 1×
      </div>
    </div>
  );
}
