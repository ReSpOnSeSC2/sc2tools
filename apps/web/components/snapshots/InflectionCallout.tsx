"use client";

import { Card } from "@/components/ui/Card";
import {
  fmtTick,
  METRIC_LABELS,
  type GameSnapshotResponse,
  type MetricKey,
} from "./shared/snapshotTypes";

// "You fell behind at 6:00 because workers + supply" — one-glance
// narrative of where the game shifted. Collapses to a friendly
// success state when no inflection happened (i.e. the user never
// crossed into the losing half).

export interface InflectionCalloutProps {
  insights: GameSnapshotResponse["insights"];
  onJump?: (t: number) => void;
}

export function InflectionCallout({ insights, onJump }: InflectionCalloutProps) {
  const tick = insights.inflectionTick;

  if (tick === null) {
    return (
      <Card variant="feature">
        <div className="flex items-start gap-3 p-3">
          <span aria-hidden className="text-xl text-accent-cyan">
            ✓
          </span>
          <div>
            <div className="text-caption font-semibold text-text">
              You held position
            </div>
            <p className="mt-1 text-[12px] text-text-muted">
              No inflection point detected — your macro stayed at or above the
              cohort baseline for the whole game.
            </p>
          </div>
        </div>
      </Card>
    );
  }

  const primary = insights.primaryMetric as MetricKey | null;
  const secondary = insights.secondaryMetric as MetricKey | null;

  return (
    <Card variant="feature">
      <div className="flex items-start gap-3 p-3">
        <span aria-hidden className="text-xl text-warning">
          ⚠
        </span>
        <div>
          <div className="text-caption font-semibold text-text">
            You fell behind at{" "}
            <button
              type="button"
              onClick={() => onJump?.(tick)}
              className="rounded text-accent underline decoration-dotted underline-offset-2 hover:text-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {fmtTick(tick)}
            </button>
          </div>
          <p className="mt-1 text-[12px] text-text-muted">
            {primary ? (
              <>
                Primary cause: <strong className="text-text">{METRIC_LABELS[primary]}</strong>
                {secondary ? (
                  <>
                    {" "}with <strong className="text-text">{METRIC_LABELS[secondary]}</strong>
                    {" "}as a contributing factor.
                  </>
                ) : (
                  "."
                )}
              </>
            ) : (
              "Your verdict crossed from neutral to losing here."
            )}
          </p>
        </div>
      </div>
    </Card>
  );
}
