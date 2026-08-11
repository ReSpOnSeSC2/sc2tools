"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { useApi } from "@/lib/clientApi";
import { fmtDate, fmtMinutes, raceColour } from "@/lib/format";
import { Badge } from "@/components/ui/Badge";
import { Card, EmptyState } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { MapLabel } from "@/components/maps/MapArtwork";
import { useSort, SortableTh } from "@/components/ui/SortableTh";
import type { ProfileGame } from "./Last5GamesTimeline";
import { MacroBreakdownPanel } from "./macro/MacroBreakdownPanel";
import type { PanelHeaderMeta } from "./macro/MacroBreakdownPanel.types";
import { BuildOrderDualTimeline } from "./charts/BuildOrderDualTimeline";
import {
  GameStreamLinks,
  type GameStreamLink,
} from "./GameStreamLinks";
import { useGameVodLinks } from "./useGameVodLinks";
import { ReplayDownloadButton } from "./ReplayDownloadButton";
import {
  gameAnalysisHref,
  type OpponentNavigationContext,
} from "@/lib/opponentNavigation";

type BuildOrderEvent = {
  time: number;
  time_display: string;
  name: string;
  display: string;
  race: string;
  category: string;
  tier: number;
};

type BuildOrderResp = {
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
  early_events: BuildOrderEvent[];
  opp_events: BuildOrderEvent[];
  opp_early_events: BuildOrderEvent[];
  my_status?: "ok" | "empty" | "not_extracted";
  opp_status?: "ok" | "empty" | "not_extracted";
};

type GameRowData = ProfileGame & {
  opp_race?: string;
  my_race?: string;
  macro_score?: number | null;
};

const SORT_COLS = {
  date: "date",
  map: "map",
  race: "opp_race",
  strategy: "opp_strategy",
  build: "my_build",
  macro: "macro_score",
  length: "game_length",
  result: "result",
  oppMmr: "opp_mmr",
} as const;

/**
 * All games table for the opponent profile. Rows are clickable: a
 * click expands the build-order timeline pulled from
 * `/v1/games/:id/build-order`. Both your-tech and opponent-tech
 * timelines are shown side-by-side when available.
 *
 * Mobile (<md): collapses to a stacked card list with the same data.
 */
export function AllGamesTable({
  games,
  targetGameId,
  targetGameSeq,
  myName,
  opponentContext,
}: {
  games: ProfileGame[];
  targetGameId?: string | null;
  targetGameSeq?: number;
  /** Logged-in user's display name, for the "you" side of the
   *  Players column. Falls back to a neutral "You" label when absent. */
  myName?: string | null;
  /** Present only when this table belongs to one opponent dossier. */
  opponentContext?: OpponentNavigationContext | null;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const mobileListRef = useRef<HTMLUListElement>(null);
  const sort = useSort(SORT_COLS.date, "desc");

  // Only surface the optional columns when the data is actually
  // present, so the contexts that don't carry per-game names / MMR
  // (older opponent-profile drilldowns) keep their tighter layout.
  const showPlayers = useMemo(
    () => !!myName || (games || []).some((g) => !!g.opponent),
    [games, myName],
  );
  const showOppMmr = useMemo(
    () => (games || []).some((g) => g.opp_mmr != null),
    [games],
  );
  const vodLinksData = useGameVodLinks(games || [], opponentContext);
  const linksByGameId = vodLinksData?.linksByGameId ?? {};
  const showStreams = (games || []).some(
    (game) => (gameStreamLinks(linksByGameId, game.id)?.length ?? 0) > 0,
  );
  // Replay downloads belong to the opponent dossier's All-games surface.
  // Other consumers reuse this table for strategy/MMR drilldowns and keep
  // their existing analysis-only action cell.
  const showReplayDownload = !!opponentContext;

  const sortedGames = useMemo(() => {
    return sort.sortRows(
      games as GameRowData[],
      (row, col) => (row as unknown as Record<string, unknown>)[col],
    );
  }, [games, sort]);

  useEffect(() => {
    if (!targetGameId) return;
    setExpandedId(targetGameId);
    setHighlightId(targetGameId);
    const sel =
      (tableRef.current?.querySelector(
        `[data-game-row-id="${cssEscape(targetGameId)}"]`,
      ) as HTMLElement | null) ||
      (mobileListRef.current?.querySelector(
        `[data-game-row-id="${cssEscape(targetGameId)}"]`,
      ) as HTMLElement | null);
    if (sel) {
      try {
        sel.scrollIntoView({ behavior: "smooth", block: "center" });
      } catch {
        sel.scrollIntoView();
      }
    }
    const t = window.setTimeout(() => setHighlightId(null), 2000);
    return () => window.clearTimeout(t);
  }, [targetGameId, targetGameSeq]);

  if (!games || games.length === 0) {
    return <EmptyState title="No games yet" />;
  }

  const toggle = (id: string | null | undefined) => {
    if (!id) return;
    setExpandedId((cur) => (cur === id ? null : id));
  };

  return (
    <div className="space-y-3">
      <div className="hidden overflow-x-auto md:block">
        <table ref={tableRef} className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-bg-elevated text-micro uppercase text-text-muted">
            <tr>
              <th className="w-6 px-2 py-1 text-left" aria-hidden></th>
              <SortableTh col={SORT_COLS.date} label="Date" {...sort} />
              {showPlayers ? (
                <th className="px-2 py-1 text-left font-medium">Players</th>
              ) : null}
              <SortableTh col={SORT_COLS.map} label="Map" {...sort} />
              <SortableTh col={SORT_COLS.race} label="Race" {...sort} />
              {showOppMmr ? (
                <SortableTh
                  col={SORT_COLS.oppMmr}
                  label="Opp MMR"
                  {...sort}
                  align="right"
                />
              ) : null}
              <SortableTh col={SORT_COLS.strategy} label="Strategy" {...sort} />
              <SortableTh col={SORT_COLS.build} label="My Build" {...sort} />
              <SortableTh col={SORT_COLS.macro} label="Macro" {...sort} align="right" />
              <SortableTh col={SORT_COLS.length} label="Length" {...sort} align="right" />
              <SortableTh col={SORT_COLS.result} label="Result" {...sort} align="right" />
              {showStreams ? (
                <th className="px-2 py-1 text-right font-medium">
                  POV streams
                </th>
              ) : null}
              <th className="px-2 py-1 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {sortedGames.map((g, i) => (
              <GameRow
                key={g.id || `_idx_${i}`}
                game={g}
                expanded={!!g.id && expandedId === g.id}
                highlighted={!!g.id && highlightId === g.id}
                onToggle={() => toggle(g.id)}
                showPlayers={showPlayers}
                showOppMmr={showOppMmr}
                showStreams={showStreams}
                streamLinks={gameStreamLinks(linksByGameId, g.id)}
                myName={myName}
                opponentContext={opponentContext}
                showReplayDownload={showReplayDownload}
              />
            ))}
          </tbody>
        </table>
      </div>

      <ul ref={mobileListRef} className="space-y-2 md:hidden">
        {sortedGames.map((g, i) => (
          <GameMobileCard
            key={g.id || `_idx_${i}`}
            game={g}
            expanded={!!g.id && expandedId === g.id}
            highlighted={!!g.id && highlightId === g.id}
            onToggle={() => toggle(g.id)}
            streamLinks={gameStreamLinks(linksByGameId, g.id)}
            myName={myName}
            opponentContext={opponentContext}
            showReplayDownload={showReplayDownload}
          />
        ))}
      </ul>
    </div>
  );
}

function gameStreamLinks(
  linksByGameId: Record<string, GameStreamLink[]>,
  gameId?: string | null,
): GameStreamLink[] | undefined {
  if (!gameId) return undefined;
  const links = linksByGameId[gameId];
  return Array.isArray(links) ? links : undefined;
}

function GameRow({
  game,
  expanded,
  highlighted,
  onToggle,
  showPlayers,
  showOppMmr,
  showStreams,
  streamLinks,
  myName,
  opponentContext,
  showReplayDownload,
}: {
  game: GameRowData;
  expanded: boolean;
  highlighted: boolean;
  onToggle: () => void;
  showPlayers: boolean;
  showOppMmr: boolean;
  showStreams: boolean;
  streamLinks?: GameStreamLink[];
  myName?: string | null;
  opponentContext?: OpponentNavigationContext | null;
  showReplayDownload: boolean;
}) {
  const expandable = !!game.id;
  const { macro, macroColour, resultBadge } = useGameMeta(game);
  const [macroOpen, setMacroOpen] = useState(false);
  // base cols: toggle + date + map + race + strategy + build + macro
  // + length + result + open-link = 10; plus the optional columns.
  const colSpan =
    10
    + (showPlayers ? 1 : 0)
    + (showOppMmr ? 1 : 0)
    + (showStreams ? 1 : 0);

  return (
    <Fragment>
      <tr
        data-game-row-id={game.id || ""}
        className={[
          "border-t border-border transition-colors",
          expandable ? "cursor-pointer hover:bg-bg-elevated/60" : "",
          expanded ? "bg-bg-elevated/40" : "",
          highlighted ? "ring-2 ring-accent ring-offset-1 ring-offset-bg" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        onClick={expandable ? onToggle : undefined}
      >
        <td className="select-none px-2 py-1 text-text-dim">
          {expandable ? (expanded ? "▾" : "▸") : ""}
        </td>
        <td className="px-2 py-1 font-mono text-xs text-text-muted">
          {fmtDate(game.date)}
        </td>
        {showPlayers ? (
          <td className="px-2 py-1">
            <PlayersCell myName={myName} opponent={game.opponent} />
          </td>
        ) : null}
        <td className="px-2 py-1 text-text">
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
        <td className="px-2 py-1">
          <RaceTag race={game.opp_race} strategy={game.opp_strategy} />
        </td>
        {showOppMmr ? (
          <td className="px-2 py-1 text-right tabular-nums text-text-muted">
            {game.opp_mmr != null ? game.opp_mmr : "—"}
          </td>
        ) : null}
        <td className="px-2 py-1 text-text-muted">
          {game.opp_strategy || "—"}
        </td>
        <td className="px-2 py-1">
          <BuildBadge name={game.my_build || null} />
        </td>
        <td className="px-2 py-1 text-right">
          <MacroCell
            game={game}
            macro={macro}
            macroColour={macroColour}
            open={macroOpen}
            onOpen={() => setMacroOpen(true)}
            onClose={() => setMacroOpen(false)}
          />
        </td>
        <td className="px-2 py-1 text-right tabular-nums text-text-muted">
          {game.game_length ? fmtMinutes(game.game_length) : "—"}
        </td>
        <td className="px-2 py-1 text-right">{resultBadge}</td>
        {showStreams ? (
          <td className="px-2 py-1 text-right">
            {streamLinks && streamLinks.length > 0 ? (
              <GameStreamLinks
                links={streamLinks}
                compact
                className="justify-end"
              />
            ) : (
              <span className="text-text-dim" aria-label="No stream available">
                &mdash;
              </span>
            )}
          </td>
        ) : null}
        <td className="px-2 py-1 text-right">
          <div className="inline-flex items-center justify-end gap-1.5">
            <GameDeepDiveLink
              gameId={game.id}
              opponentContext={opponentContext}
            />
            {showReplayDownload ? (
              <ReplayDownloadButton
                gameId={game.id}
                available={game.replayAvailable}
                filename={game.replayFilename}
                sizeBytes={game.replaySizeBytes}
              />
            ) : null}
          </div>
        </td>
      </tr>
      {expanded && game.id ? (
        <tr className="bg-bg-elevated/30">
          <td colSpan={colSpan} className="px-2 pb-3">
            <BuildOrderRow gameId={game.id} game={game} />
          </td>
        </tr>
      ) : null}
    </Fragment>
  );
}

/**
 * Players cell — shows who the game was between, "you vs opponent",
 * so a list pulled from an MMR band (where every row is a different
 * opponent) reads at a glance and the user can confirm the MMR tag
 * belongs to the player they remember. Both sides degrade to neutral
 * placeholders when a name is missing.
 */
function PlayersCell({
  myName,
  opponent,
}: {
  myName?: string | null;
  opponent?: string | null;
}) {
  const me = (myName || "").trim() || "You";
  const opp = (opponent || "").trim() || "Opponent";
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs">
      <span className="max-w-[10ch] truncate text-text-muted" title={me}>
        {me}
      </span>
      <span className="text-text-dim">vs</span>
      <span className="max-w-[14ch] truncate font-medium text-text" title={opp}>
        {opp}
      </span>
    </span>
  );
}


/**
 * Clearly labelled route to the game's analysis workspace. stopPropagation
 * keeps the existing row-click (build-order expand) behaviour intact.
 */
function GameDeepDiveLink({
  gameId,
  mobile,
  opponentContext,
}: {
  gameId?: string | null;
  mobile?: boolean;
  opponentContext?: OpponentNavigationContext | null;
}) {
  if (!gameId) return null;
  return (
    <Link
      href={gameAnalysisHref(gameId, opponentContext)}
      onClick={(e) => e.stopPropagation()}
      aria-label="Open game analysis: timeline, mechanics, build orders, and Ghost Build"
      title="Open game analysis"
      className={[
        "inline-flex items-center gap-2 rounded-md border border-border-strong bg-bg-elevated/60 px-3 py-1.5 text-left text-caption font-semibold text-text transition-colors hover:border-accent hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
        mobile ? "min-h-[44px] w-full justify-between py-2" : "whitespace-nowrap",
      ].join(" ")}
    >
      <span className="min-w-0">
        <span className="block">Open game analysis</span>
        {mobile ? (
          <span className="mt-0.5 block text-micro font-normal text-text-muted">
            Timeline · mechanics · build orders · Ghost Build
          </span>
        ) : null}
      </span>
      <ArrowUpRight className="h-4 w-4 flex-none" aria-hidden />
    </Link>
  );
}

function MacroCell({
  game,
  macro,
  macroColour,
  open,
  onOpen,
  onClose,
}: {
  game: GameRowData;
  macro: number | null | undefined;
  macroColour: string;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const hasScore = typeof macro === "number";
  const hasGameId = !!game.id;
  if (!hasGameId) {
    return (
      <span className={`font-semibold tabular-nums ${macroColour}`}>
        {hasScore ? macro : "—"}
      </span>
    );
  }
  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onOpen();
        }}
        aria-label={
          hasScore
            ? `Open macro breakdown (score ${macro})`
            : "Open macro breakdown"
        }
        title="Open macro breakdown"
        className={`inline-flex h-7 min-w-[28px] items-center justify-center rounded px-1.5 font-semibold tabular-nums underline decoration-dotted underline-offset-4 hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${macroColour}`}
      >
        {hasScore ? macro : "—"}
      </button>
      {open && game.id ? (
        <MacroBreakdownPanel
          open={open}
          gameId={game.id}
          initialScore={typeof macro === "number" ? macro : null}
          headerMeta={panelHeaderMetaFromGame(game)}
          onClose={onClose}
        />
      ) : null}
    </>
  );
}

function panelHeaderMetaFromGame(game: GameRowData): PanelHeaderMeta {
  return {
    myRace: game.my_race ?? null,
    opponentRace: game.opp_race ?? null,
    map: game.map ?? null,
    result: game.result ?? null,
    dateIso: game.date ?? null,
  };
}
function GameMobileCard({
  game,
  expanded,
  highlighted,
  onToggle,
  streamLinks,
  myName,
  opponentContext,
  showReplayDownload,
}: {
  game: GameRowData;
  expanded: boolean;
  highlighted: boolean;
  onToggle: () => void;
  streamLinks?: GameStreamLink[];
  myName?: string | null;
  opponentContext?: OpponentNavigationContext | null;
  showReplayDownload: boolean;
}) {
  const expandable = !!game.id;
  const { macro, macroColour, resultBadge } = useGameMeta(game);
  const [macroOpen, setMacroOpen] = useState(false);
  const showPlayers = !!myName || !!game.opponent;

  return (
    <li
      data-game-row-id={game.id || ""}
      className={[
        "rounded-lg border border-border bg-bg-surface transition-colors",
        expanded ? "border-border-strong" : "",
        highlighted ? "ring-2 ring-accent ring-offset-1 ring-offset-bg" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="flex items-stretch gap-1 px-3 py-2">
        <button
          type="button"
          onClick={expandable ? onToggle : undefined}
          disabled={!expandable}
          aria-expanded={expanded}
          aria-label={expandable ? "Toggle build order" : undefined}
          className="flex min-h-[44px] flex-1 items-start justify-between gap-3 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:cursor-default"
        >
          <div className="flex flex-1 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <RaceTag race={game.opp_race} strategy={game.opp_strategy} />
              {resultBadge}
              <span className="font-mono text-micro text-text-dim">
                {fmtDate(game.date)}
              </span>
            </div>
            {showPlayers ? (
              <div className="text-micro">
                <PlayersCell myName={myName} opponent={game.opponent} />
              </div>
            ) : null}
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
              <span>
                opp: <span className="text-text">{game.opp_strategy || "—"}</span>
              </span>
              <span>
                me: <span className="text-text">{game.my_build || "—"}</span>
              </span>
              <span>
                len:{" "}
                <span className="tabular-nums text-text">
                  {game.game_length ? fmtMinutes(game.game_length) : "—"}
                </span>
              </span>
              {game.opp_mmr != null ? (
                <span>
                  opp mmr:{" "}
                  <span className="tabular-nums text-text">{game.opp_mmr}</span>
                </span>
              ) : null}
            </div>
          </div>
          {expandable ? (
            <span className="select-none pt-0.5 text-text-dim" aria-hidden>
              {expanded ? "▾" : "▸"}
            </span>
          ) : null}
        </button>
        <div className="flex flex-shrink-0 flex-col items-end gap-1 pl-1">
          <span className="text-micro uppercase tracking-wider text-text-dim">
            macro
          </span>
          <MacroCell
            game={game}
            macro={macro}
            macroColour={macroColour}
            open={macroOpen}
            onOpen={() => setMacroOpen(true)}
            onClose={() => setMacroOpen(false)}
          />
        </div>
      </div>
      {game.id ? (
        <div className="space-y-2 border-t border-border px-3 py-2">
          {streamLinks && streamLinks.length > 0 ? (
            <GameStreamLinks
              links={streamLinks}
              className="[&_a]:h-11 [&_a]:w-11"
            />
          ) : null}
          <div className="space-y-2">
            <GameDeepDiveLink
              gameId={game.id}
              mobile
              opponentContext={opponentContext}
            />
            {showReplayDownload ? (
              <ReplayDownloadButton
                gameId={game.id}
                available={game.replayAvailable}
                filename={game.replayFilename}
                sizeBytes={game.replaySizeBytes}
                mobile
              />
            ) : null}
          </div>
        </div>
      ) : null}
      {expanded && game.id ? (
        <div className="border-t border-border px-3 py-3">
          <BuildOrderRow gameId={game.id} game={game} />
        </div>
      ) : null}
    </li>
  );
}

function useGameMeta(game: GameRowData): {
  macro: number | null | undefined;
  macroColour: string;
  resultBadge: React.ReactNode;
} {
  const macro = game.macro_score;
  const macroColour =
    macro == null
      ? "text-text-dim"
      : macro >= 75
        ? "text-success"
        : macro >= 50
          ? "text-warning"
          : "text-danger";
  const result = game.result || "";
  const isWin = result === "Win" || result === "Victory";
  const isLoss = result === "Loss" || result === "Defeat";
  const resultBadge = result ? (
    <Badge
      size="sm"
      variant={isWin ? "success" : isLoss ? "danger" : "neutral"}
    >
      {result}
    </Badge>
  ) : (
    <span className="text-text-dim">—</span>
  );
  return { macro, macroColour, resultBadge };
}

/**
 * Map any race code/name we might receive ("T", "t", "Terran",
 * "Protoss") to the canonical full name the icon set is keyed on
 * ("terran", "protoss", "zerg", "random"). The Icon component's
 * race set only contains full names, so passing a single letter
 * silently dropped the icon — we now resolve to the full name once
 * here.
 */
function canonicalRace(input?: string | null): {
  full: "Terran" | "Protoss" | "Zerg" | "Random" | null;
  letter: "T" | "P" | "Z" | "R" | null;
} {
  if (!input) return { full: null, letter: null };
  const head = String(input).trim().charAt(0).toUpperCase();
  switch (head) {
    case "T":
      return { full: "Terran", letter: "T" };
    case "P":
      return { full: "Protoss", letter: "P" };
    case "Z":
      return { full: "Zerg", letter: "Z" };
    case "R":
      return { full: "Random", letter: "R" };
    default:
      return { full: null, letter: null };
  }
}

/**
 * Best-effort race derivation from a strategy/build name like
 * "Terran - Proxy Rax" or "Zerg - Roach Allin". The classifier
 * upstream emits these "<Race> - <Detail>" strings, so when the
 * raw opp_race didn't make it through (e.g. older drilldowns) we
 * can still light up the Race column instead of showing a "?".
 */
function raceFromStrategyName(name?: string | null): string | null {
  if (!name) return null;
  const head = name.trim().split(/\s*[-–—:|]/)[0];
  if (!head) return null;
  const lower = head.toLowerCase();
  if (lower.startsWith("terran")) return "Terran";
  if (lower.startsWith("protoss")) return "Protoss";
  if (lower.startsWith("zerg")) return "Zerg";
  if (lower.startsWith("random")) return "Random";
  return null;
}

function RaceTag({
  race,
  strategy,
}: {
  race?: string | null;
  strategy?: string | null;
}) {
  // 1) trust opp_race if it resolves to a real race
  // 2) otherwise infer from strategy name ("Terran - Proxy Rax")
  let resolved = canonicalRace(race);
  if (!resolved.letter) {
    resolved = canonicalRace(raceFromStrategyName(strategy));
  }
  const colour = raceColour(resolved.full || race);
  const letter = resolved.letter || "?";
  const hasRace = !!resolved.full;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-micro font-medium"
      style={{
        color: colour,
        borderColor: `${colour}55`,
        background: `${colour}14`,
      }}
      title={
        hasRace
          ? `Opponent race: ${resolved.full}${
              !race && strategy ? " (inferred from strategy name)" : ""
            }`
          : "Opponent race not recorded for this game"
      }
    >
      {hasRace && resolved.full ? (
        <Icon
          name={resolved.full}
          kind="race"
          size={14}
          fallback=""
          decorative
        />
      ) : null}
      <span className="font-mono">{letter}</span>
    </span>
  );
}

function BuildBadge({ name }: { name: string | null }) {
  if (!name) return <span className="text-text-dim">—</span>;
  return (
    <Badge size="sm" variant="neutral" title={`The build I played: ${name}`}>
      {name}
    </Badge>
  );
}

/**
 * BuildOrderRow — expanded-row content. Loads /v1/games/:id/build-order
 * and hands the raw events to the icon-rich BuildOrderTimeline widget,
 * which wires the You/Opponent perspective toggle and the rich
 * BuildEditorModal flow (PUTs to /v1/custom-builds/:slug with v3 rules
 * + strategy notes + share-with-community + reclassify). The widget
 * falls back to a friendly empty state when an opponent build log
 * hasn't been extracted yet.
 */
function BuildOrderRow({
  gameId,
  game,
}: {
  gameId: string;
  game: GameRowData;
}) {
  const { data, isLoading, error } = useApi<BuildOrderResp>(
    `/v1/games/${encodeURIComponent(gameId)}/build-order`,
  );
  if (isLoading) {
    return (
      <Card title="Loading build order…">
        <div className="h-4 animate-pulse rounded bg-bg-elevated" />
      </Card>
    );
  }
  if (error) {
    return (
      <Card title="Build order">
        <p className="text-xs text-danger">{error.message}</p>
      </Card>
    );
  }
  if (!data) return null;
  return (
    <BuildOrderDualTimeline
      events={data.events || []}
      oppEvents={data.opp_events || []}
      gameId={gameId}
      race={data.my_race || game.my_race}
      oppRace={data.opp_race || game.opp_race}
      myBuildName={data.my_build}
      oppBuildName={data.opp_strategy}
      myStatus={data.my_status}
      oppStatus={data.opp_status}
    />
  );
}

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(value);
  return value.replace(
    /[^a-zA-Z0-9_-]/g,
    (c) => `\\${c.charCodeAt(0).toString(16)} `,
  );
}
