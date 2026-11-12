"use client";

import { Button } from "@/components/ui/Button";
import { Card, Skeleton } from "@/components/ui/Card";
import { StatCard } from "@/components/ui/Stat";
import type { StreamViewerPage } from "@/lib/streamViewer";
import { useStreamViewer } from "./useStreamViewer";

export function StreamViewer({ handle, initial }: { handle: string; initial: StreamViewerPage }) {
  const { state, refresh } = useStreamViewer(handle, initial);
  return <div className="min-h-64 space-y-5">
    {state.kind === "ready" ? <CompletedGames page={state.page} /> : state.kind === "loading"
      ? <div role="status" aria-label="Checking the viewer page"><Skeleton rows={4} /></div>
      : <Card title="Viewer page unavailable" headingLevel={2}>
        <p role="status" className="mb-4 text-body text-text-muted">{state.kind === "missing"
          ? "This page is no longer shared." : "The latest results couldn't load."}</p>
        <Button onClick={refresh} variant="secondary" className="min-h-11">Try again</Button>
      </Card>}
  </div>;
}

function CompletedGames({ page }: { page: StreamViewerPage }) {
  return <>
    <p className="text-body text-text-muted">Results appear at least {page.delayMinutes} minutes after each game ends.</p>
    <div className="grid grid-cols-2 gap-3">
      <StatCard label="Wins shown" value={String(page.wins)} size="sm" />
      <StatCard label="Losses shown" value={String(page.losses)} size="sm" />
    </div>
    <Card title="Completed games" headingLevel={2}>
      {!page.games.length ? <p className="text-body text-text-muted">No delayed results are available for this session yet.</p>
        : <ol className="divide-y divide-border" aria-label="Newest completed games first">
          {page.games.map((game, index) => <li key={index} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-3">
            <span className={`font-semibold ${game.result === "win" ? "text-success" : "text-danger"}`}>{game.result === "win" ? "Win" : "Loss"}</span>
            <span className="text-body text-text">{game.opponentRace ? `vs. ${game.opponentRace}` : "Opponent race unavailable"}</span>
            {game.map ? <span className="min-w-0 break-words text-caption text-text-muted">{game.map}</span> : null}
          </li>)}
        </ol>}
    </Card>
  </>;
}
