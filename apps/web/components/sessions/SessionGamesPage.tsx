"use client";

import { useLayoutEffect, useRef } from "react";
import { Card } from "@/components/ui/Card";
import { LinkButton } from "@/components/ui/Button";
import { AllGamesTable } from "@/components/analyzer/AllGamesTable";
import { GameSourceLabelProvider } from "@/components/analyzer/GameAnalysisLink";
import type { SessionHistoryDetail } from "@/lib/sessionHistory";
import { sessionProfileGame } from "@/lib/sessionHistoryTable";
import { sessionDetailHref } from "@/lib/sessionHistoryUrls";
import { sessionMinutes } from "./sessionCardFormat";

type GamesPageProps = {
  data: SessionHistoryDetail; query: URLSearchParams; id: string;
  onNextGames?: () => void; consumeFocusIntent?: () => boolean;
};

export function SessionGamesPage({ data, query, id, onNextGames, consumeFocusIntent }: GamesPageProps) {
  const region = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (region.current && consumeFocusIntent?.()) region.current.focus({ preventScroll: true });
  }, [consumeFocusIntent]);
  const delivered = data.games.slice(0, 100);
  const games = delivered.map(row => ({ ...sessionProfileGame(row), sessionPosition: row.position }));
  const next = new URLSearchParams(query);
  if (data.nextGamesBefore) next.set("gamesBefore", data.nextGamesBefore);
  const first = delivered[0]?.position ?? "—", last = delivered.at(-1)?.position ?? "—";
  return <div ref={region} role="region" aria-label="Games in this session" tabIndex={-1} className="rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"><Card title="Games in this session" headingLevel={3}>
    <p className="mb-3 text-caption text-text-muted">Showing recorded positions {first}–{last} of {data.gamePage.total} games. Sorting applies to the delivered page only. Open a game for its available replay actions.</p>
    <GameSourceLabelProvider label="Session report"><AllGamesTable key={`${first}:${last}`} games={games} pageLocalSort rowKey={(game, index) => "sessionPosition" in game ? `session:${String(game.sessionPosition)}` : `page:${index}`} /></GameSourceLabelProvider>
    <details className="mt-3"><summary className="min-h-11 cursor-pointer py-3 text-caption font-semibold">Recorded end-to-end gaps for this page</summary><ol className="space-y-1 text-caption text-text-muted">{delivered.map(row => <li key={row.position}>Game {row.position}: {row.recordedEndGapSec === null ? "First recorded game end" : `${sessionMinutes(row.recordedEndGapSec / 60)} since the previous recorded game end`}</li>)}</ol><p className="mt-2 text-caption text-text-dim">These gaps include game time and do not measure idle breaks.</p></details>
    {data.nextGamesBefore ? <LinkButton className="mt-3" href={sessionDetailHref(id, next, undefined, true)} scroll={false} variant="secondary" onClick={event => {
      if (!event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) onNextGames?.();
    }}>Next games in this session</LinkButton> : <p className="mt-3 text-caption text-text-dim">All game pages in this session have been reached.</p>}
  </Card></div>;
}
