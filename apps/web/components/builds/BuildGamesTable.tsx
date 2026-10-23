"use client";

import { useId, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, StickyNote } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Card, EmptyState } from "@/components/ui/Card";
import { Toggle } from "@/components/ui/Toggle";
import { BuildOrderTimeline } from "@/components/analyzer/charts/BuildOrderTimeline";
import { MapLabel } from "@/components/maps/MapArtwork";
import { useApi } from "@/lib/clientApi";
import { fmtDate, fmtMinutes } from "@/lib/format";
import type { BuildOrderEvent } from "@/lib/build-events";
import { PlannedBadge } from "@/components/build-checkin/PlannedBadge";
import type { BuildRecentGame } from "./types";

interface BuildOrderResp {
  ok: boolean;
  game_id: string;
  my_build: string | null;
  my_race: string | null;
  opp_strategy: string | null;
  opponent: string | null;
  opp_race: string | null;
  map: string | null;
  result: string | null;
  events: BuildOrderEvent[];
  opp_events: BuildOrderEvent[];
}

/**
 * BuildGamesTable — recent games for a custom build with build-order
 * drilldown. Desktop renders a sortable-style table; mobile collapses
 * to stacked cards with the same data and the same expand action.
 *
 * Games on the build through a confirmed check-in carry a "Planned"
 * marker (naming the replay's own label) and show the player's check-in
 * notes when expanded.
 */
export function BuildGamesTable({
  games,
  resumedGames = [],
  resumedCount = 0,
}: {
  games: BuildRecentGame[];
  resumedGames?: BuildRecentGame[];
  resumedCount?: number;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showResumedGames, setShowResumedGames] = useState(false);
  const resumeNoteId = useId();
  const groupedGames = useMemo(() => {
    const resumedById = new Map<string, BuildRecentGame>();

    for (const game of games) {
      if (game.isResumedFromReplay) {
        resumedById.set(game.gameId, {
          ...game,
          isResumedFromReplay: true,
        });
      }
    }
    for (const game of resumedGames) {
      resumedById.set(game.gameId, {
        ...game,
        isResumedFromReplay: true,
      });
    }

    return {
      competitive: games.filter(
        (game) =>
          !game.isResumedFromReplay && !resumedById.has(game.gameId),
      ),
      resumed: Array.from(resumedById.values()),
    };
  }, [games, resumedGames]);
  const filteredCompetitive = groupedGames.competitive;
  const filteredResumed = groupedGames.resumed;
  const displayedGames = useMemo(
    () =>
      [
        ...filteredCompetitive,
        ...(showResumedGames ? filteredResumed : []),
      ].sort(compareNewestFirst),
    [filteredCompetitive, filteredResumed, showResumedGames],
  );
  const totalResumed = Math.max(
    0,
    resumedCount,
    groupedGames.resumed.length,
  );
  const hasResumedGames = totalResumed > 0;

  if (groupedGames.competitive.length === 0 && !hasResumedGames) {
    return (
      <Card title="Recent games">
        <EmptyState sub="No games using this build yet. Once you play some, they list here newest-first." />
      </Card>
    );
  }
  return (
    <Card
      title={`Recent games · ${filteredCompetitive.length}${hasResumedGames ? " counted" : ""}`}
    >
      {hasResumedGames ? (
        <div className="mb-3 flex flex-col gap-2 rounded-lg border border-border bg-bg-elevated/40 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
          <p id={resumeNoteId} className="text-micro text-text-muted">
            {totalResumed} replay-resume test
            {totalResumed === 1 ? " is" : "s are"} excluded from all
            statistics.
          </p>
          <div className="flex items-center gap-2">
            <span className="text-caption text-text">
              Show replay-resume tests
            </span>
            <Toggle
              checked={showResumedGames}
              onChange={setShowResumedGames}
              label="Show replay-resume tests"
              aria-describedby={resumeNoteId}
            />
          </div>
        </div>
      ) : null}
      {displayedGames.length === 0 ? (
        <EmptyState
          sub="No counted games using this build yet."
        />
      ) : (
        <>
          <div className="hidden md:block">
            <table className="w-full text-caption">
              <thead className="bg-bg-elevated text-micro uppercase tracking-wider text-text-muted">
                <tr>
                  <th className="w-6 px-2 py-1 text-left" aria-hidden />
                  <th className="px-2 py-1 text-left">Date</th>
                  <th className="px-2 py-1 text-left">Map</th>
                  <th className="px-2 py-1 text-left">Opponent</th>
                  <th className="px-2 py-1 text-left">Strategy</th>
                  <th className="px-2 py-1 text-right">Macro</th>
                  <th className="px-2 py-1 text-right">Length</th>
                  <th className="px-2 py-1 text-right">Result</th>
                </tr>
              </thead>
              <tbody>
                {displayedGames.map((g) => (
                  <GameRow
                    key={g.gameId}
                    game={g}
                    expanded={expanded === g.gameId}
                    onToggle={() =>
                      setExpanded((cur) =>
                        cur === g.gameId ? null : g.gameId,
                      )
                    }
                  />
                ))}
              </tbody>
            </table>
          </div>
          <ul className="space-y-2 md:hidden">
            {displayedGames.map((g) => (
              <GameMobile
                key={g.gameId}
                game={g}
                expanded={expanded === g.gameId}
                onToggle={() =>
                  setExpanded((cur) =>
                    cur === g.gameId ? null : g.gameId,
                  )
                }
              />
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

function compareNewestFirst(a: BuildRecentGame, b: BuildRecentGame): number {
  const aTime = Date.parse(a.date);
  const bTime = Date.parse(b.date);
  if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) {
    return bTime - aTime;
  }
  return b.date.localeCompare(a.date) || a.gameId.localeCompare(b.gameId);
}

function GameRow({
  game,
  expanded,
  onToggle,
}: {
  game: BuildRecentGame;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        className={[
          "cursor-pointer border-t border-border transition-colors",
          expanded ? "bg-bg-elevated/40" : "hover:bg-bg-elevated/40",
        ].join(" ")}
        onClick={onToggle}
        data-game-row-id={game.gameId}
        data-replay-resume={game.isResumedFromReplay ? "true" : undefined}
      >
        <td className="px-2 py-1.5 text-text-dim" aria-hidden>
          {expanded ? (
            <ChevronDown className="h-4 w-4" aria-hidden />
          ) : (
            <ChevronRight className="h-4 w-4" aria-hidden />
          )}
        </td>
        <td className="px-2 py-1.5 font-mono text-text-muted">
          {fmtDate(game.date)}
        </td>
        <td className="px-2 py-1.5 text-text">
          {game.map ? (
            <MapLabel
              name={game.map}
              size="xs"
              preview
              className="max-w-[13rem]"
              textClassName="text-text"
            />
          ) : (
            "—"
          )}
        </td>
        <td className="px-2 py-1.5 text-text-muted">
          {game.opponent || "—"}
          {game.opp_race ? (
            <span className="ml-1 text-text-dim">({game.opp_race[0]})</span>
          ) : null}
        </td>
        <td className="px-2 py-1.5 text-text-muted">{game.opp_strategy || "—"}</td>
        <td className="px-2 py-1.5 text-right tabular-nums">
          <MacroCell value={game.macroScore ?? null} />
        </td>
        <td className="px-2 py-1.5 text-right tabular-nums text-text-muted">
          {game.duration ? fmtMinutes(game.duration) : "—"}
        </td>
        <td className="px-2 py-1.5 text-right">
          <span className="inline-flex flex-wrap items-center justify-end gap-1">
            <PlannedMarker game={game} />
            <GameResultBadge game={game} />
          </span>
        </td>
      </tr>
      {expanded ? (
        <tr className="bg-bg-elevated/20">
          <td colSpan={8} className="space-y-2 px-2 pb-3 pt-1">
            <CheckInNotes game={game} />
            <BuildOrderExpansion gameId={game.gameId} game={game} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function GameMobile({
  game,
  expanded,
  onToggle,
}: {
  game: BuildRecentGame;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <li
      className={[
        "rounded-lg border border-border bg-bg-surface",
        expanded ? "border-border-strong" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-game-card-id={game.gameId}
      data-replay-resume={game.isResumedFromReplay ? "true" : undefined}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex min-h-[44px] w-full items-start justify-between gap-3 px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
      >
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2 text-caption">
            <GameResultBadge game={game} />
            <PlannedMarker game={game} />
            <span className="font-mono text-text-dim">{fmtDate(game.date)}</span>
            <MacroCell value={game.macroScore ?? null} />
          </div>
          {game.map ? (
            <MapLabel
              name={game.map}
              size="sm"
              className="max-w-full"
              textClassName="text-caption text-text"
            />
          ) : (
            <div className="text-caption text-text">—</div>
          )}
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-micro text-text-muted">
            <span className="truncate">opp: {game.opponent || "—"}</span>
            <span className="truncate">strat: {game.opp_strategy || "—"}</span>
            <span>
              len: {game.duration ? fmtMinutes(game.duration) : "—"}
            </span>
          </div>
        </div>
        <span className="pt-0.5 text-text-dim" aria-hidden>
          {expanded ? (
            <ChevronDown className="h-4 w-4" aria-hidden />
          ) : (
            <ChevronRight className="h-4 w-4" aria-hidden />
          )}
        </span>
      </button>
      {expanded ? (
        <div className="space-y-2 border-t border-border px-3 py-2">
          <CheckInNotes game={game} />
          <BuildOrderExpansion gameId={game.gameId} game={game} />
        </div>
      ) : null}
    </li>
  );
}

function GameResultBadge({ game }: { game: BuildRecentGame }) {
  if (game.isResumedFromReplay) {
    return (
      <Badge
        size="sm"
        variant="neutral"
        aria-label="Replay resume test; excluded from all statistics"
      >
        Replay resume
      </Badge>
    );
  }

  const result = (game.result || "").toString();
  const isWin = ["win", "victory"].includes(result.toLowerCase());
  return (
    <Badge size="sm" variant={isWin ? "success" : "danger"}>
      {isWin ? "Win" : "Loss"}
    </Badge>
  );
}

/** "Planned" badge, plus a note icon when the check-in has notes. */
function PlannedMarker({ game }: { game: BuildRecentGame }) {
  if (!game.planned || game.isResumedFromReplay) return null;
  return (
    <>
      <PlannedBadge detected={game.planned.detected} />
      {game.planned.notes?.trim() ? (
        <span className="inline-flex text-text-dim" title="Has a check-in note">
          <StickyNote className="h-3.5 w-3.5" aria-hidden />
          <span className="sr-only">Has a check-in note</span>
        </span>
      ) : null}
    </>
  );
}

/** The player's own words on what happened to the plan. */
function CheckInNotes({ game }: { game: BuildRecentGame }) {
  const notes = game.planned?.notes?.trim();
  if (!notes) return null;
  return (
    <div className="flex items-start gap-2 rounded-lg border border-border bg-bg-surface px-3 py-2 text-caption">
      <StickyNote className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
      <div className="min-w-0">
        <p className="text-micro font-bold uppercase tracking-wider text-text-dim">
          Check-in note
        </p>
        <p className="whitespace-pre-wrap break-words text-text">{notes}</p>
      </div>
    </div>
  );
}

function MacroCell({ value }: { value: number | null }) {
  if (value == null) return <span className="text-text-dim">—</span>;
  const cls =
    value >= 75
      ? "text-success"
      : value >= 50
        ? "text-warning"
        : "text-danger";
  return <span className={cls}>{value.toFixed(1)}</span>;
}

function BuildOrderExpansion({
  gameId,
  game,
}: {
  gameId: string;
  game: BuildRecentGame;
}) {
  const { data, isLoading, error } = useApi<BuildOrderResp>(
    `/v1/games/${encodeURIComponent(gameId)}/build-order`,
  );
  if (isLoading) {
    return (
      <div className="rounded-md bg-bg-elevated p-3">
        <div className="h-4 animate-pulse rounded bg-bg-subtle" />
      </div>
    );
  }
  if (error) {
    return <p className="text-caption text-danger">{error.message}</p>;
  }
  if (!data) return null;
  return (
    <BuildOrderTimeline
      events={data.events || []}
      oppEvents={data.opp_events || []}
      defaultPerspective="you"
      gameId={gameId}
      race={data.my_race}
      oppRace={data.opp_race || game.opp_race}
      title={data.my_build ? `Your build — ${data.my_build}` : "Your build"}
      onSaveAsBuild={async () => {
        // SaveAsBuildButton handles the API call internally via the
        // BuildEditorModal -> PUT /v1/custom-builds/:slug flow.
      }}
    />
  );
}
