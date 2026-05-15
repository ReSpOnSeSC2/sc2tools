"use client";

import { Card } from "@/components/ui/Card";
import type { TechPathBlock } from "./shared/snapshotTypes";

// Ranked alternatives list: shows the other paths cohort players
// took at this tick with their win rate + CI width-based "low
// confidence" badging. Sorted by frequency descending. Renders as a
// compact card so it fits comfortably in the right rail next to
// the inflection callout.

export interface TechPathAlternativesProps {
  techPath: TechPathBlock | null;
}

export function TechPathAlternatives({ techPath }: TechPathAlternativesProps) {
  if (!techPath) {
    return (
      <Card title="Alternative paths">
        <p className="py-3 text-center text-caption text-text-dim">
          No tech-path data at this tick.
        </p>
      </Card>
    );
  }
  const alternatives = techPath.alternatives || [];
  return (
    <Card title="Alternative tech paths">
      <p className="-mt-1 mb-2 text-[11px] text-text-muted">
        Your path: <span className="font-semibold text-text">{techPath.pathLabel}</span>{" "}
        — {Math.round(techPath.pathWinRate * 100)}% win rate ({techPath.sampleSize} games)
      </p>
      {alternatives.length === 0 ? (
        <p className="text-caption text-text-dim">
          Your path is the only one with enough samples in this cohort.
        </p>
      ) : (
        <ul className="divide-y divide-border" role="list">
          {alternatives.map((alt) => {
            const ciWidth = Math.abs(alt.winRateCI[1] - alt.winRateCI[0]);
            const lowConfidence = (alt.sampleSize ?? alt.total ?? 0) < 10 || ciWidth > 0.3;
            const delta = alt.winRate - techPath.pathWinRate;
            const deltaText = delta > 0 ? `+${Math.round(delta * 100)}%` : `${Math.round(delta * 100)}%`;
            const deltaColor = delta > 0.05 ? "#22c55e" : delta < -0.05 ? "#ef4444" : "#9aa3b2";
            return (
              <li key={alt.pathId} className="py-2">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-caption font-semibold text-text">{alt.label}</span>
                  <span className="text-caption font-semibold" style={{ color: deltaColor }}>
                    {Math.round(alt.winRate * 100)}% <span className="text-text-dim font-normal">({deltaText})</span>
                  </span>
                </div>
                <div className="mt-0.5 flex items-center justify-between text-[11px] text-text-muted">
                  <span>
                    {alt.sampleSize ?? alt.total ?? 0} games · {Math.round(alt.frequency * 100)}% of cohort
                  </span>
                  {lowConfidence ? (
                    <span className="rounded-full border border-text-dim/30 px-1.5 py-0.5 text-[10px] text-text-dim">
                      Low confidence
                    </span>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {techPath.transitions && techPath.transitions.length > 0 ? (
        <div className="mt-3 border-t border-border pt-2">
          <h4 className="mb-1 text-[11px] uppercase tracking-wider text-text-dim">
            Winners on your path added next
          </h4>
          <ul className="space-y-0.5 text-caption text-text-muted">
            {techPath.transitions.slice(0, 3).map((tr) => (
              <li key={`${tr.addedBuilding}-${tr.afterSec}`}>
                <span className="font-medium text-text">{tr.addedBuilding}</span>{" "}
                <span className="text-text-dim">
                  ~{Math.round(tr.afterSec)}s later ({Math.round(tr.frequencyAmongWinners * 100)}% of winners)
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}
