"use client";

/**
 * Stacked outcome bar showing what phase games against an opponent
 * ended in. Fed by the server-computed phase distribution + per-phase
 * sample sizes; renders nothing when no game ever reached / ended in
 * any phase.
 */

type Phase = "early" | "earlyMid" | "mid" | "midLate" | "late";

const PHASE_ORDER: Phase[] = ["early", "earlyMid", "mid", "midLate", "late"];
const PHASE_LABEL: Record<Phase, string> = {
  early: "Early",
  earlyMid: "Early/Mid",
  mid: "Mid",
  midLate: "Mid/Late",
  late: "Late",
};
const PHASE_DIST_COLOR: Record<Phase, string> = {
  early: "rgb(var(--danger))",
  earlyMid: "rgb(var(--warning))",
  mid: "rgb(var(--accent))",
  midLate: "rgb(var(--accent-cyan))",
  late: "rgb(var(--success))",
};

export interface WhereGamesEndBarProps {
  finalPhaseDistribution?: Partial<Record<Phase, number>>;
  sampleSize?: Partial<Record<Phase, number>>;
}

export function WhereGamesEndBar({
  finalPhaseDistribution,
  sampleSize,
}: WhereGamesEndBarProps) {
  const dist = finalPhaseDistribution || {};
  const total = PHASE_ORDER.reduce((acc, p) => acc + (dist[p] || 0), 0);
  if (total === 0) return null;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-end text-caption text-text-dim">
        <span>{total} games</span>
      </div>
      <div
        className="flex h-2.5 w-full overflow-hidden rounded-full border border-border bg-bg-surface"
        aria-label="Phase the game ended in, across all matches"
      >
        {PHASE_ORDER.map((p) => {
          const v = dist[p] || 0;
          const pct = total > 0 ? (v / total) * 100 : 0;
          if (pct <= 0) return null;
          return (
            <div
              key={p}
              title={`${PHASE_LABEL[p]} · ${v} · ${Math.round(pct)}%`}
              style={{
                width: `${pct}%`,
                backgroundColor: PHASE_DIST_COLOR[p],
              }}
            />
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-caption text-text-dim">
        {PHASE_ORDER.map((p) => {
          const v = dist[p] || 0;
          if (v <= 0) return null;
          const sample = sampleSize?.[p];
          return (
            <span
              key={p}
              className="inline-flex items-center gap-1.5 tabular-nums"
            >
              <span
                aria-hidden
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: PHASE_DIST_COLOR[p] }}
              />
              <span>{PHASE_LABEL[p]}</span>
              <span className="text-text">{v}</span>
              {typeof sample === "number" && sample > v ? (
                <span>· reached by {sample}</span>
              ) : null}
            </span>
          );
        })}
      </div>
    </div>
  );
}
