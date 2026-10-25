"use client";

import { useId, useMemo, useState } from "react";
import { GameAnalysisLink } from "@/components/analyzer/GameAnalysisLink";
import { ChevronDown, ChevronRight, ExternalLink, StickyNote } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Card, EmptyState } from "@/components/ui/Card";
import { Toggle } from "@/components/ui/Toggle";
import { FilterPill } from "@/components/ui/FilterPill";
import { SortableTh, useSort } from "@/components/ui/SortableTh";
import { resultLabel } from "@/components/analyzer/game/types";
import { StrategyLabel } from "@/components/definitions/StrategyLabel";
import { BuildOrderTimeline } from "@/components/analyzer/charts/BuildOrderTimeline";
import { MapLabel } from "@/components/maps/MapArtwork";
import { useApi } from "@/lib/clientApi";
import { fmtDate, fmtMinutes } from "@/lib/format";
import type { BuildOrderEvent } from "@/lib/build-events";
import { PlannedBadge } from "@/components/build-checkin/PlannedBadge";
import type { BuildRecentGame } from "./types";
import { StarGhostReplayButton } from "./StarGhostReplayButton";
import { ReferenceComparison } from "./ReferenceComparison";

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
 * drilldown. Keyboard disclosures and links work on both layouts;
 * sorting and quick filters apply within the competitive/resume groups.
 *
 * Games on the build through a confirmed check-in carry a "Planned"
 * marker (naming the replay's own label) and show the player's check-in
 * notes when expanded.
 */
export function BuildGamesTable({
  games,
  resumedGames = [],
  resumedCount = 0,
  total,
  buildKey,
  ghostSide = "you",
}: {
  games: BuildRecentGame[];
  resumedGames?: BuildRecentGame[];
  resumedCount?: number;
  total?: number;
  buildKey?: string;
  ghostSide?: "you" | "opponent";
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showResumedGames, setShowResumedGames] = useState(false);
  const resumeNoteId = useId();
  const [filter, setFilter] = useState("all");
  const sort = useSort("date", "desc");
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
  const availableGames = [...groupedGames.competitive, ...(showResumedGames ? groupedGames.resumed : [])];
  const filters = [
    { key: "all", label: "All" }, { key: "win", label: "Wins" }, { key: "loss", label: "Losses" },
    ...["P", "T", "Z"].filter((race) => availableGames.some((game) => game.opp_race?.[0]?.toUpperCase() === race)).map((race) => ({ key: race, label: `vs ${race}` })),
  ];
  const activeFilter = filters.some((item) => item.key === filter) ? filter : "all";
  const filteredCompetitive = groupedGames.competitive.filter((game) => matchesFilter(game, activeFilter));
  const filteredResumed = groupedGames.resumed.filter((game) => matchesFilter(game, activeFilter));
  const displayedGames = [...sort.sortRows(filteredCompetitive, sortValue), ...(showResumedGames ? sort.sortRows(filteredResumed, sortValue) : [])];
  const totalResumed = Math.max(
    0,
    resumedCount,
    groupedGames.resumed.length,
  );
  const hasResumedGames = totalResumed > 0;

  return (
    <Card
      title={total != null && total > groupedGames.competitive.length ? `Latest ${groupedGames.competitive.length} of ${total} games` : `Recent games · ${groupedGames.competitive.length}`}
    >
      {total != null && total > groupedGames.competitive.length ? <p className="mb-3 text-caption text-text-muted">Older games still count in every stat above.</p> : null}
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
      <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label="Filter recent games">
        {filters.map((item) => <FilterPill key={item.key} active={activeFilter === item.key} onClick={() => setFilter(item.key)}>{item.label} <span className="tabular-nums">{availableGames.filter((game) => matchesFilter(game, item.key)).length}</span></FilterPill>)}
      </div>
      {displayedGames.length === 0 ? (
        <div><EmptyState title={activeFilter === "all" ? "No counted games using this build yet." : "No games match this filter"} />{activeFilter !== "all" ? <button type="button" className="min-h-11 px-3 text-accent underline" onClick={() => setFilter("all")}>Clear</button> : null}</div>
      ) : (
        <>
          <div className="hidden md:block">
            <table className="w-full text-caption">
              <thead className="bg-bg-elevated text-micro uppercase tracking-wider text-text-muted">
                <tr>
                  <SortableTh col="date" label="Date" {...sort} compact />
                  <SortableTh col="map" label="Map" {...sort} compact />
                  <th className="px-2 py-1 text-left">Opponent</th>
                  <th className="px-2 py-1 text-left">Strategy</th>
                  <SortableTh col="macro" label="Macro" {...sort} compact align="right" />
                  <SortableTh col="length" label="Length" {...sort} compact align="right" />
                  <SortableTh col="result" label="Result" {...sort} compact align="right" />
                  <th className="px-2 py-1">Open</th>
                </tr>
              </thead>
              <tbody>
                {displayedGames.map((g) => (
                  <GameRow
                    key={g.gameId}
                    game={g}
                    buildKey={buildKey}
                    ghostSide={ghostSide}
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
                buildKey={buildKey}
                ghostSide={ghostSide}
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

function matchesFilter(game: BuildRecentGame, filter: string): boolean {
  if (filter === "win" || filter === "loss") return !game.isResumedFromReplay && resultLabel(game.result) === (filter === "win" ? "Win" : "Loss");
  return filter === "all" || game.opp_race?.[0]?.toUpperCase() === filter;
}

function sortValue(game: BuildRecentGame, column: string): string | number | null {
  switch (column) {
    case "map": return game.map?.toLowerCase() ?? null;
    case "length": return game.duration ?? null;
    case "macro": return game.macroScore ?? null;
    case "result": return resultLabel(game.result);
    default: return Date.parse(game.date) || 0;
  }
}

function GameRow({
  game,
  buildKey,
  ghostSide,
  expanded,
  onToggle,
}: {
  game: BuildRecentGame;
  buildKey?: string;
  ghostSide: "you" | "opponent";
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
        onClick={(event) => { if (!(event.target as HTMLElement).closest("a,button,input")) onToggle(); }}
        data-game-row-id={game.gameId}
        data-replay-resume={game.isResumedFromReplay ? "true" : undefined}
      >
        <td className="px-2 py-1.5 font-mono text-text-muted">
          <button type="button" aria-expanded={expanded} aria-controls={`build-game-${game.gameId}-detail`} aria-label={`Build order from ${fmtDate(game.date)} vs ${game.opponent || "unknown opponent"}`} onClick={onToggle} className="inline-flex min-h-11 items-center gap-1 rounded px-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
            {expanded ? <ChevronDown className="h-4 w-4 shrink-0" aria-hidden /> : <ChevronRight className="h-4 w-4 shrink-0" aria-hidden />}{fmtDate(game.date)}
          </button>
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
        <td className="px-2 py-1.5 text-text-muted"><StrategyLabel label={game.opp_strategy || "—"} /></td>
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
        <td className="text-center"><OpenGameLink game={game} /><StarGhostReplayButton gameId={game.gameId} buildKey={buildKey} side={ghostSide} /></td>
      </tr>
      {expanded ? (
        <tr id={`build-game-${game.gameId}-detail`} className="bg-bg-elevated/20">
          <td colSpan={8} className="space-y-2 px-2 pb-3 pt-1">
            <CheckInNotes game={game} />
            <BuildOrderExpansion gameId={game.gameId} game={game} buildKey={buildKey} ghostSide={ghostSide} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function GameMobile({
  game,
  buildKey,
  ghostSide,
  expanded,
  onToggle,
}: {
  game: BuildRecentGame;
  buildKey?: string;
  ghostSide: "you" | "opponent";
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
        aria-controls={`build-game-${game.gameId}-mobile-detail`}
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
      <div className="px-3 pb-1 text-caption text-text-muted"><span>Strategy: <StrategyLabel label={game.opp_strategy || "—"} /></span><div><OpenGameLink game={game} mobile /><StarGhostReplayButton gameId={game.gameId} buildKey={buildKey} side={ghostSide} /></div></div>
      {expanded ? (
        <div id={`build-game-${game.gameId}-mobile-detail`} className="space-y-2 border-t border-border px-3 py-2">
          <CheckInNotes game={game} />
          <BuildOrderExpansion gameId={game.gameId} game={game} buildKey={buildKey} ghostSide={ghostSide} />
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

  const label = resultLabel(game.result);
  return (
    <Badge size="sm" variant={label === "Win" ? "success" : label === "Loss" ? "danger" : "neutral"}>
      {label}
    </Badge>
  );
}

function OpenGameLink({ game, mobile = false }: { game: BuildRecentGame; mobile?: boolean }) {
  return <GameAnalysisLink gameId={game.gameId} aria-label={`Open game vs ${game.opponent || "unknown opponent"} on ${game.map || "unknown map"}`} className="inline-flex min-h-11 min-w-11 items-center justify-center gap-1 rounded text-link hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">{mobile ? "Open game" : <ExternalLink className="h-4 w-4" aria-hidden />}</GameAnalysisLink>;
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
  buildKey,
  ghostSide,
}: {
  gameId: string;
  game: BuildRecentGame;
  buildKey?: string;
  ghostSide: "you" | "opponent";
}) {
  const { data, isLoading, error, mutate } = useApi<BuildOrderResp>(
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
    return <div className="rounded-md border border-danger/30 p-3 text-caption"><p>Couldn't load this game's build order.</p><button type="button" onClick={() => { void mutate(); }} className="min-h-11 text-link underline">Try again</button>{error.requestId ? <p className="break-all text-micro text-text-muted">Error ID: {error.requestId}</p> : null}</div>;
  }
  if (!data) return null;
  return (
    <><BuildOrderTimeline
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
    /><ReferenceComparison gameId={gameId} buildKey={buildKey} side={ghostSide} /></>
  );
}
