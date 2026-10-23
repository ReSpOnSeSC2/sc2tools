"use client";

import { useMemo, type ReactNode } from "react";
import { Card } from "@/components/ui/Card";
import { RequestError } from "@/components/ui/RequestError";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import {
  lossAutopsy,
  type AutopsyGame,
  type PersonalMedians,
} from "@/lib/lossAutopsy";
import { parseClockToSeconds } from "@/lib/gameTimeline";
import { RECOMPUTE_ANALYSIS_HINT } from "@/lib/analysisRecompute";

export interface LossAutopsyCardProps {
  recomputeAction?: ReactNode;
  seekTarget?: "replay" | "timeline";
  error?: unknown;
  onRetry?: () => unknown;
  loading?: boolean;
  /** The lost game with its client-side payloads attached. */
  game: AutopsyGame;
  personalMedians?: PersonalMedians;
  /** Clicking a cause timestamp scrubs the timeline to that second. */
  onSeek?: (timeSec: number) => void;
}

/**
 * LossAutopsyCard — "why you lost", rendered from lib/lossAutopsy.ts
 * (a pure, already-tested rules engine — this card only consumes its
 * output). Each cause carries a severity bar and game-clock
 * timestamps; clicking a timestamp scrubs the interactive timeline.
 *
 * Renders nothing for non-losses (the engine returns [] for them);
 * for a loss with too little data to explain, shows a gentle note
 * instead of a blank card.
 */
export function LossAutopsyCard({
  error, onRetry, loading,
  game,
  personalMedians,
  onSeek,
  recomputeAction,
  seekTarget = "timeline",
}: LossAutopsyCardProps) {
  const causes = useMemo(
    () => lossAutopsy({ game, personalMedians }),
    [game, personalMedians],
  );

  const isLoss = game.result === "Loss" || game.result === "Defeat";
  if (!isLoss) return null;

  if (error) return <RequestError title="Couldn't load the loss analysis" error={error} onRetry={onRetry} />;
  if (loading) return <div role="status" aria-label="Loading loss analysis" className="space-y-3">{[0,1,2].map((row) => <div key={row} className="h-8 animate-pulse rounded bg-bg-elevated" />)}</div>;
  return (
    <Card title="Why you lost" data-testid="loss-autopsy-card">
      {causes.length === 0 ? (
        <EmptyStatePanel
          size="sm"
          title="Not enough data to explain this one"
          description={game.macroBreakdown ? "The fixed rules found no standout leak in this replay's available data." : RECOMPUTE_ANALYSIS_HINT}
          action={recomputeAction}
        />
      ) : (
        <ol className="space-y-4">
          {causes.map((cause, idx) => (
            <li key={cause.id} className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span
                  className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-bg-elevated text-micro font-bold text-text-muted"
                  aria-hidden
                >
                  {idx + 1}
                </span>
                <h4 className="text-caption font-semibold text-text">
                  {cause.title}
                </h4>
                <span
                  className={`ml-auto rounded-full border px-2 py-1 text-micro tabular-nums ${cause.severityScore >= 67 ? "border-danger/40 text-danger" : cause.severityScore >= 34 ? "border-warning/40 text-warning" : "border-success/40 text-success"}`}
                  aria-label={`Severity ${cause.severityScore} out of 100, ${cause.severityScore >= 67 ? "high" : cause.severityScore >= 34 ? "medium" : "low"}`}
                >
                  {cause.severityScore >= 67 ? "High" : cause.severityScore >= 34 ? "Medium" : "Low"} · {cause.severityScore}
                </span>
              </div>
              <div
                className="h-1.5 w-full overflow-hidden rounded bg-bg-elevated"
                role="img"
                aria-label={`Severity ${cause.severityScore} out of 100`}
              >
                <div
                  className={`h-full rounded ${
                    cause.severityScore >= 67
                      ? "bg-danger"
                      : cause.severityScore >= 34
                        ? "bg-warning"
                        : "bg-success"
                  }`}
                  style={{ width: `${cause.severityScore}%` }}
                />
              </div>
              <p className="text-caption text-text-muted">{cause.detail}</p>
              {cause.timestamps.length > 0 ? (
                <div className="flex flex-wrap gap-1.5 pt-0.5">
                  {cause.timestamps.map((clock, tIdx) => {
                    const sec = parseClockToSeconds(clock);
                    return (
                      <button
                        key={`${cause.id}-${clock}-${tIdx}`}
                        type="button"
                        disabled={!onSeek || sec === null}
                        onClick={
                          onSeek && sec !== null
                            ? () => onSeek(sec)
                            : undefined
                        }
                        aria-label={seekTarget === "replay" ? `Watch the replay at ${clock}` : `Jump timeline to ${clock}`}
                        className="inline-flex min-h-[44px] items-center rounded-full border border-border bg-bg-elevated px-2.5 font-mono text-micro tabular-nums text-text-muted transition-colors enabled:hover:border-border-strong enabled:hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default"
                      >
                        {seekTarget === "replay" ? `Watch at ${clock}` : clock}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
