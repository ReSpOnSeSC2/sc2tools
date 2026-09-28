"use client";

/**
 * Game by game — pick one of the analysed games (newest first; the most
 * recent is shown by default) and see it in detail: pre-game MMRs, both
 * build orders and the macro timeline (`GameDetail`). With a single
 * game there is nothing to pick, so only the detail shows. A polite
 * live region announces the newly selected game once its detail is on
 * screen. Renders nothing when the report has no games.
 *
 * Example:
 *   <GamesSection games={report.games} />
 */
import { memo, useDeferredValue, useId, useState } from "react";
import type { ReportGame } from "@/lib/instant/report";
import { GameDetail, gameTitle } from "./GameDetail";
import { GameList } from "./GameList";
import { formatReportDate } from "./ReportBits";

export interface GamesSectionProps {
  /** Newest first (`report.games`). */
  games: ReportGame[];
}

function selectionAnnouncement(game: ReportGame): string {
  return ["Showing", gameTitle(game), game.map, formatReportDate(game.date)].filter(Boolean).join(" ");
}

function findGame(games: ReportGame[], gameId: string | null): ReportGame | undefined {
  return games.find((game) => game.gameId === gameId) ?? games[0];
}

/** Skips list-only re-renders: the detail changes only with its game. */
const MemoGameDetail = memo(GameDetail);

/**
 * Game picker + the selected game's detail.
 *
 * Example:
 *   <GamesSection games={buildReportGames(payloads)} />
 */
export function GamesSection({ games }: GamesSectionProps) {
  const headingId = useId();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The pressed button answers a click at once; the new game's detail
  // (build orders, chart) follows in a deferred, interruptible render,
  // so switching games is never one long main-thread task.
  const shownId = useDeferredValue(selectedId);
  const selected = findGame(games, selectedId);
  const shown = findGame(games, shownId);
  if (!selected || !shown) return null;
  const pending = shown.gameId !== selected.gameId;
  return (
    <section aria-labelledby={headingId} className="min-w-0 space-y-3" data-testid="report-games">
      <header className="space-y-0.5">
        <h3 id={headingId} className="font-display text-h3 text-text">
          Game by game
        </h3>
        <p className="text-caption text-text-muted">
          {games.length > 1 ? "Pick a game to compare both build orders and see its macro timeline." : "Both build orders and the macro timeline of your game."}
        </p>
      </header>
      {games.length > 1 ? <GameList games={games} selectedId={selected.gameId} onSelect={setSelectedId} /> : null}
      <p className="sr-only" aria-live="polite">
        {shownId === null || pending ? "" : selectionAnnouncement(shown)}
      </p>
      <div aria-busy={pending}>
        <MemoGameDetail key={shown.gameId} game={shown} />
      </div>
    </section>
  );
}
