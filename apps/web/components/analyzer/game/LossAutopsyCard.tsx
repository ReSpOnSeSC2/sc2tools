"use client";

import { useMemo } from "react";
import { Card } from "@/components/ui/Card";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import {
  lossAutopsy,
  type AutopsyGame,
  type PersonalMedians,
} from "@/lib/lossAutopsy";
import { parseClockToSeconds } from "@/lib/gameTimeline";

export interface LossAutopsyCardProps {
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
  game,
  personalMedians,
  onSeek,
}: LossAutopsyCardProps) {
  const causes = useMemo(
    () => lossAutopsy({ game, personalMedians }),
    [game, personalMedians],
  );

  const isLoss = game.result === "Loss" || game.result === "Defeat";
  if (!isLoss) return null;

  return (
    <Card title="Why you lost" data-testid="loss-autopsy-card">
      {causes.length === 0 ? (
        <EmptyStatePanel
          size="sm"
          title="Not enough data to explain this one"
          description="The macro engine found no standout leak — sometimes the other player just played better. A recompute from the agent can add missing samples."
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
                  className="ml-auto text-micro tabular-nums text-text-dim"
                  title="Severity, 0–100"
                >
                  {cause.severityScore}
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
                        aria-label={`Jump timeline to ${clock}`}
                        className="inline-flex min-h-[32px] items-center rounded-full border border-border bg-bg-elevated px-2.5 font-mono text-micro tabular-nums text-text-muted transition-colors enabled:hover:border-border-strong enabled:hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default"
                      >
                        {clock}
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
