"use client";

import Link from "next/link";

/**
 * Specialised empty-state cards. Each one explains what's missing and
 * gives the user the next obvious step rather than a generic "no data".
 */

export function NoGamesYet() {
  return (
    <div className="card space-y-2 p-6 text-center">
      <h3 className="text-base font-semibold">No games synced yet</h3>
      <p className="text-sm text-text-muted">
        Install the agent on your gaming PC, pair it from{" "}
        <Link href="/devices">Devices</Link>, and play a ranked match. This
        page will tick the moment the replay lands.
      </p>
      <div className="flex justify-center gap-2 pt-2">
        <Link href="/download" className="btn">
          Download agent
        </Link>
        <Link href="/devices" className="btn btn-secondary">
          Devices
        </Link>
      </div>
    </div>
  );
}

export function NoOpponentsMatch() {
  return (
    <div className="card space-y-1 p-6 text-center">
      <h3 className="text-base font-semibold">No opponents match these filters</h3>
      <p className="text-sm text-text-muted">
        Try lowering Min games, clearing the season filter, or searching
        by partial name.
      </p>
    </div>
  );
}

export function NoBuildOrder({
  gameId,
  onRecompute,
}: {
  gameId: string;
  onRecompute: () => void;
}) {
  return (
    <div className="card space-y-2 p-4">
      <p className="text-sm">
        No build order parsed for game{" "}
        <span className="font-mono text-xs">{gameId}</span>.
      </p>
      <button type="button" className="btn btn-secondary text-xs" onClick={onRecompute}>
        Ask the agent to recompute
      </button>
    </div>
  );
}

export function NoMlModel() {
  return (
    <div className="card space-y-2 p-6 text-center">
      <h3 className="text-base font-semibold">No ML model trained</h3>
      <p className="text-sm text-text-muted">
        Train your first model in the ML Core tab. Needs at least ~50
        recent ranked games.
      </p>
    </div>
  );
}

export function NeedReplays({ count = 0 }: { count?: number }) {
  return (
    <div className="card space-y-2 p-6 text-center">
      <h3 className="text-base font-semibold">Need more replays</h3>
      <p className="text-sm text-text-muted">
        You have <strong>{count}</strong> games on file. Most charts work
        best with 30+ games. The agent will keep the cloud copy current
        as you play.
      </p>
    </div>
  );
}
