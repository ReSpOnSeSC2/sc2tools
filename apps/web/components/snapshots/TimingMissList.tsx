"use client";

import { Card } from "@/components/ui/Card";
import { SEVERITY_COLORS } from "./shared/colorScales";
import { fmtTick, type TimingMiss } from "./shared/snapshotTypes";

// Missed unit / tech timings vs the cohort winners' median.
// Severity color + dot scales with predictive power: high = the
// winner share that built this is ≥85%.

export interface TimingMissListProps {
  misses: TimingMiss[];
}

export function TimingMissList({ misses }: TimingMissListProps) {
  if (!misses || misses.length === 0) {
    return (
      <Card title="Timing misses">
        <p className="py-3 text-center text-caption text-text-dim">
          No timing misses against the cohort winners' median.
        </p>
      </Card>
    );
  }

  return (
    <Card title="Timing misses">
      <ul className="divide-y divide-border" role="list">
        {misses.map((m) => (
          <li key={`${m.unit}-${m.cohortWinnerMedianAt}`} className="flex items-start gap-3 py-2.5">
            <span
              aria-hidden
              className="mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full"
              style={{ background: SEVERITY_COLORS[m.severity] }}
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                <span className="text-caption font-semibold text-text">
                  {m.unit}
                </span>
                <span
                  className="text-[11px] font-medium capitalize"
                  style={{ color: SEVERITY_COLORS[m.severity] }}
                >
                  {m.severity}
                </span>
              </div>
              <p className="mt-0.5 text-[11px] text-text-muted">
                {describe(m)}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function describe(m: TimingMiss): string {
  const share = Math.round((m.winnerShare || 0) * 100);
  const medianAt = m.cohortWinnerMedianAt;
  if (m.gameBuiltAt === null) {
    return `${share}% of winners had this by ${medianAt !== null ? fmtTick(medianAt) : "—"}; you didn't build it.`;
  }
  const delay = m.gameBuiltAt - (medianAt ?? 0);
  return `Winners built by ${medianAt !== null ? fmtTick(medianAt) : "—"}; you built at ${fmtTick(m.gameBuiltAt)} (${Math.round(delay)} s late).`;
}
