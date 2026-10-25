"use client";

import { useState } from "react";
import { Card, Skeleton } from "@/components/ui/Card";
import { useApi } from "@/lib/clientApi";
import type { OpponentNavigationContext } from "@/lib/opponentNavigation";
import { AllGamesTable } from "./AllGamesTable";
import type { ProfileGame } from "./Last5GamesTimeline";
import { GameSourceLabelProvider } from "./GameAnalysisLink";

export const OPPONENT_REPLAY_PAGE_SIZE = 200;

type ReplayHistoryPage = {
  items: ProfileGame[];
  nextCursor: string | null;
  membership?: { scope: "analysis_sample"; requestedGameCount: number };
};

/**
 * Bounded, cursor-paged replay table for an opponent dossier. Pages replace
 * one another instead of accumulating: AllGamesTable renders desktop and
 * mobile row trees, so even a 10,000-replay history keeps a constant DOM size.
 */
export function OpponentReplayHistory({
  path,
  initialGames,
  profileTruncated,
  targetGameId,
  targetGameSeq,
  myName,
  opponentContext, maps = [], selectedMap, onSelectMap,
}: {
  /** Base endpoint with analyzer/merge filters, but without a cursor. */
  path: string;
  maps?: string[]; selectedMap?: string | null; onSelectMap?: (map: string | null) => void;
  /** Capped profile rows shown while the first compact page arrives. */
  initialGames: ProfileGame[];
  profileTruncated?: boolean;
  targetGameId?: string | null;
  targetGameSeq?: number;
  myName?: string | null;
  opponentContext: OpponentNavigationContext;
}) {
  const [result, setResult] = useState("");
  const [sortBy, setSortBy] = useState("date");
  const [cursor, setCursor] = useState<string | null>(null);
  const [newerCursors, setNewerCursors] = useState<Array<string | null>>([]);
  const pagePath = `${appendReplayPageQuery(path, cursor)}${result ? `&result=${result}` : ""}`;
  const { data, error, isValidating, mutate } =
    useApi<ReplayHistoryPage>(pagePath, { revalidateOnFocus: false, keepPreviousData: false });

  const sourceQuery = new URLSearchParams(pagePath.split("?")[1] ?? "");
  const sampled = sourceQuery.has("analysisGameIds");
  sourceQuery.delete("analysisGameIds");
  const libraryLabel = sampled ? "Analyzed sample replays" : "All replays";
  const firstPageFallback = cursor === null
    ? initialGames.filter((game) => !result || (result === "win" ? /^(win|victory)$/i : /^(loss|defeat)$/i).test(game.result || "")).slice(0, OPPONENT_REPLAY_PAGE_SIZE)
    : [];
  const games = data?.items ?? firstPageFallback;
  const pageIndex = newerCursors.length;
  const start = games.length > 0
    ? pageIndex * OPPONENT_REPLAY_PAGE_SIZE + 1
    : 0;
  const end = start > 0 ? start + games.length - 1 : 0;
  const waitingWithoutRows = !data && !error && games.length === 0;
  const showingFallback = !data && games.length > 0;

  let title: string;
  if (showingFallback && profileTruncated && !sampled) {
    title = `Latest ${games.length} replays · loading full history…`;
  } else if (pageIndex === 0 && data && !data.nextCursor) {
    title = `${libraryLabel} (${games.length}) · newest first`;
  } else if (games.length > 0) {
    title = `${libraryLabel} · showing ${start}–${end} · ${sortBy === "date" ? "newest first" : `sorted by ${sortBy === "map" ? "Map" : sortBy} (this page)`}`;
  } else {
    title = libraryLabel;
  }

  const goOlder = () => {
    if (!data?.nextCursor || isValidating) return;
    setNewerCursors((history) => [...history, cursor]);
    setCursor(data.nextCursor);
  };
  const goNewer = () => {
    if (newerCursors.length === 0 || isValidating) return;
    const prior = newerCursors[newerCursors.length - 1] ?? null;
    setNewerCursors((history) => history.slice(0, -1));
    setCursor(prior);
  };

  return (
    <GameSourceLabelProvider label={sampled ? "Analyzed sample history" : "Opponent history"} filters={sourceQuery.toString()} sampled={sampled} replace><Card title={title}>
      {sampled ? <p className="mb-3 text-caption text-text-muted">Selected analyzed sample{data?.membership ? ` · ${data.membership.requestedGameCount} linked games` : ""}.</p> : null}
      <div className="mb-3 flex flex-wrap gap-3 text-caption">
        <label>Show: <select aria-label="Filter replay results" className="min-h-11 rounded border border-border bg-bg-surface px-2" value={result}
          onChange={(event) => { setResult(event.target.value); setCursor(null); setNewerCursors([]); }}>
          <option value="">All results</option><option value="win">Wins</option><option value="loss">Losses</option>
        </select></label>
        {onSelectMap ? <label>Map: <select aria-label="Filter dossier map" className="min-h-11 rounded border border-border bg-bg-surface px-2" value={selectedMap || ""}
          onChange={(event) => onSelectMap(event.target.value || null)}><option value="">All maps</option>{maps.map((map) => <option key={map}>{map}</option>)}</select></label> : null}
      </div>
      {waitingWithoutRows ? (
        <Skeleton rows={3} />
      ) : !error && games.length === 0 && result === "loss" ? <p>No losses in this view</p> : (
        <AllGamesTable
          pageLocalSort={newerCursors.length > 0 || !!data?.nextCursor}
          onSortChange={setSortBy}
          games={games.map((game) => ({
            ...game,
            opponent: game.opponent || opponentContext.displayName || null,
          }))}
          targetGameId={targetGameId}
          targetGameSeq={targetGameSeq}
          myName={myName}
          opponentContext={opponentContext}
        />
      )}

      {error ? (
        <div
          className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2"
          role="alert"
        >
          <p className="text-caption text-text-muted">
            Couldn&apos;t load this replay page.
            {games.length > 0
              ? " Your currently visible rows are still available."
              : " Try again or return to newer replays."}
          </p>
          <button
            type="button"
            onClick={() => void mutate()}
            className="inline-flex min-h-[44px] items-center rounded-md border border-border px-3 text-caption font-semibold text-text hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            Try again
          </button>
        </div>
      ) : null}

      {showingFallback && !error ? (
        <p className="mt-3 text-caption text-text-dim" aria-live="polite">
          Loading the compact replay-history page…
        </p>
      ) : null}

      {(data && (newerCursors.length > 0 || data.nextCursor))
        || (error && newerCursors.length > 0) ? (
        <nav
          className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4"
          aria-label="Replay history pages"
        >
          <span className="text-caption tabular-nums text-text-dim">
            {games.length > 0 ? `Showing ${start}–${end}` : "Page unavailable"}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={goNewer}
              disabled={newerCursors.length === 0 || isValidating}
              className="inline-flex min-h-[44px] items-center rounded-md border border-border px-3 text-caption font-semibold text-text hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40"
            >
              Newer replays
            </button>
            <button
              type="button"
              onClick={goOlder}
              disabled={!data?.nextCursor || isValidating}
              className="inline-flex min-h-[44px] items-center rounded-md border border-border px-3 text-caption font-semibold text-text hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40"
            >
              Older replays
            </button>
          </div>
        </nav>
      ) : null}
    </Card></GameSourceLabelProvider>
  );
}

export function appendReplayPageQuery(
  path: string,
  cursor: string | null,
): string {
  const separator = path.includes("?") ? "&" : "?";
  const params = [`limit=${OPPONENT_REPLAY_PAGE_SIZE}`];
  if (cursor) params.push(`cursor=${encodeURIComponent(cursor)}`);
  return `${path}${separator}${params.join("&")}`;
}
