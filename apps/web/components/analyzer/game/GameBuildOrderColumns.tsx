"use client";

import type { BuildExecution } from "@/lib/buildExecution";
import { BuildOrderColumns, type BuildOrderColumnsProps } from "./BuildOrderColumns";
import { BuildExecutionCard } from "./BuildExecutionCard";

/** The parent owns one execution request for the card, timeline and rail.
 * No second dossier GET or timing hydration is issued by this lazy section. */
export function GameBuildOrderColumns({ gameId, execution, executionLoading, executionError, onExecutionRetry, ...props }: BuildOrderColumnsProps & {
  gameId?: string; execution?: BuildExecution; executionLoading?: boolean; executionError?: unknown; onExecutionRetry?: () => unknown;
}) {
  const canCompare = !props.loading && !props.error && props.myStatus !== "not_extracted" && props.myStatus !== "empty" && Array.isArray(props.myEvents) && props.myEvents.length > 0;
  const usable = canCompare && !executionError && !executionLoading ? execution : undefined;
  return <div className="space-y-4">{gameId ? <BuildExecutionCard data={usable} gameId={gameId} events={props.myEvents} loading={props.loading || executionLoading} error={executionError} unavailable={!canCompare && !props.loading} onRetry={onExecutionRetry} onSeek={props.onSeek} /> : null}
    <BuildOrderColumns {...props} myExecutionTimings={usable?.matchup && !usable.unavailable ? { rows: usable.timings, matchup: usable.matchup } : undefined} />
  </div>;
}
