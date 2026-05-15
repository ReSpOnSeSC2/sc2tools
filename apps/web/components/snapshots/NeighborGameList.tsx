"use client";

import { Card } from "@/components/ui/Card";
import { useNeighbors } from "@/lib/snapshots/fetchNeighbors";
import { fmtTick, type NeighborRow } from "./shared/snapshotTypes";

// Counterfactual neighbor list. When the user pins a tick, we
// anchor the neighbor search there and look for games that share
// composition at the anchor but diverged by anchor + 2 min.

export interface NeighborGameListProps {
  gameId: string;
  anchorTick: number | null;
}

export function NeighborGameList({ gameId, anchorTick }: NeighborGameListProps) {
  const { data, error, isLoading } = useNeighbors(
    anchorTick !== null ? { gameId, anchorTick, k: 3 } : null,
  );

  if (anchorTick === null) {
    return (
      <Card title="Similar replays">
        <p className="py-3 text-center text-caption text-text-dim">
          Pin a tick to find games that diverged from yours after this point.
        </p>
      </Card>
    );
  }

  if (isLoading) {
    return (
      <Card title="Similar replays">
        <div className="space-y-2 py-2">
          <div className="h-4 w-2/3 animate-pulse rounded bg-bg-elevated" />
          <div className="h-4 w-1/2 animate-pulse rounded bg-bg-elevated" />
          <div className="h-4 w-3/4 animate-pulse rounded bg-bg-elevated" />
        </div>
      </Card>
    );
  }

  if (error) {
    return (
      <Card title="Similar replays">
        <p className="py-3 text-center text-caption text-danger">
          Couldn't load neighbors right now.
        </p>
      </Card>
    );
  }

  if (!data || data.neighbors.length === 0) {
    return (
      <Card title={`Similar replays @ ${fmtTick(anchorTick)}`}>
        <p className="py-3 text-center text-caption text-text-dim">
          No counterfactual neighbors in the cohort at this tick.
        </p>
      </Card>
    );
  }

  return (
    <Card title={`Similar replays @ ${fmtTick(anchorTick)}`}>
      <ul className="space-y-3" role="list">
        {data.neighbors.map((n) => (
          <NeighborCard key={`${n.userId}-${n.gameId}`} neighbor={n} />
        ))}
      </ul>
    </Card>
  );
}

function NeighborCard({ neighbor }: { neighbor: NeighborRow }) {
  const sim = Math.round(neighbor.similarityAtAnchor * 100);
  const resultLabel = neighbor.result === "win" ? "won" : "lost";
  const resultColor =
    neighbor.result === "win" ? "text-success" : "text-danger";
  return (
    <li className="rounded-lg border border-border bg-bg-elevated/60 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-text-dim">
          {sim}% similar
        </span>
        <span className={`text-[11px] font-semibold uppercase ${resultColor}`}>
          {resultLabel}
        </span>
      </div>
      <p className="mt-1 text-caption text-text">{neighbor.summary}</p>
    </li>
  );
}
