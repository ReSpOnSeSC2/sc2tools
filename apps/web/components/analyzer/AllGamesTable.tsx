"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useApi } from "@/lib/clientApi";
import { fmtDate, fmtMinutes, raceColour } from "@/lib/format";
import { Badge } from "@/components/ui/Badge";
import { Card, EmptyState } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { useSort, SortableTh } from "@/components/ui/SortableTh";
import type { ProfileGame } from "./Last5GamesTimeline";
import { MacroBreakdownModal } from "./MacroBreakdownModal";
import { BuildOrderTimeline } from "./charts/BuildOrderTimeline";

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
}: {
  games: ProfileGame[];
  targetGameId?: string | null;
  targetGameSeq?: number;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const sort = useSort(SORT_COLS.date, "desc");

  const sortedGames = useMemo(() => {
    return sort.sortRows(
      games as GameRowData[],
      (row, col) => (row as unknown as Record<string, unknown>)[col],
    );
  }, [games, sort]);

  useEffect(() => {
    if (!targetGameId || !tableRef.current) return;
    setExpandedId(targetGameId);
    const root = tableRef.current;
    const sel = root.querySelector(
      `[data-game-row-id="${cssEscape(targetGameId)}"]`,
    ) as HTMLElement | null;
    if (sel) {
      try {
        sel.scrollIntoView({ behavior: "smooth", block: "center" });
      } catch {
        sel.scrollIntoView();
      }
    }
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
          <thead className="sticky top-0 z-10 bg-bg-elevated text-[11px] uppercase text-text-muted">
            <tr>
              <th className="w-6 px-2 py-1 text-left" aria-hidden></th>
              <SortableTh col={SORT_COLS.date} label="Date" {...sort} />
              <SortableTh col={SORT_COLS.map} label="Map" {...sort} />
              <SortableTh col={SORT_COLS.race} label="Race" {...sort} />
              <SortableTh col={SORT_COLS.strategy} label="Strategy" {...sort} />
              <SortableTh col={SORT_COLS.build} label="My Build" {...sort} />
              <SortableTh col={SORT_COLS.macro} label="Macro" {...sort} align="right" />
              <SortableTh col={SORT_COLS.length} label="Length" {...sort} align="right" />
              <SortableTh col={SORT_COLS.result} label="Result" {...sort} align="right" />
            </tr>
          </thead>
          <tbody>
            {sortedGames.map((g, i) => (
              <GameRow
                key={g.id || `_idx_${i}`}
                game={g}
                expanded={!!g.id && expandedId === g.id}
                onToggle={() => toggle(g.id)}
              />
            ))}
          </tbody>
        </table>
      </div>

      <ul className="space-y-2 md:hidden">
        {sortedGames.map((g, i) => (
          <GameMobileCard
            key={g.id || `_idx_${i}`}
            game={g}
            expanded={!!g.id && expandedId === g.id}
            onToggle={() => toggle(g.id)}
          />
        ))}
      </ul>
    </div>
  );
}

function GameRow({
  game,
  expanded,
  onToggle,
}: {
  game: GameRowData;
  expanded: boolean;
  onToggle: () => void;
}) {
  const expandable = !!game.id;
  const { macro, macroColour, resultBadge } = useGameMeta(game);
  const [macroOpen, setMacroOpen] = useState(false);

  return (
    <Fragment>
      <tr
        data-game-row-id={game.id || ""}
        className={[
          "border-t border-border transition-colors",
          expandable ? "cursor-pointer hover:bg-bg-elevated/60" : "",
          expanded ? "bg-bg-elevated/40" : "",
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
        <td className="px-2 py-1 text-text">{game.map || "—"}</td>
        <td className="px-2 py-1">
          <RaceTag race={game.opp_race} />
        </td>
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
      </tr>
      {expanded && game.id ? (
        <tr className="bg-bg-elevated/30">
          <td colSpan={9} className="px-2 pb-3">
            <BuildOrderRow gameId={game.id} game={game} />
          </td>
        </tr>
      ) : null}
    </Fragment>
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
        <MacroBreakdownModal
          open={open}
          gameId={game.id}
          initialScore={typeof macro === "number" ? macro : null}
          onClose={onClose}
        />
      ) : null}
    </>
  );
}
function GameMobileCard({
  game,
  expanded,
  onToggle,
}: {
  game: GameRowData;
  expanded: boolean;
  onToggle: () => void;
}) {
  const expandable = !!game.id;
  const { macro, macroColour, resultBadge } = useGameMeta(game);

  return (
    <li
      className={[
        "rounded-lg border border-border bg-bg-surface transition-colors",
        expanded ? "border-border-strong" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <button
        type="button"
        onClick={expandable ? onToggle : undefined}
        disabled={!expandable}
        aria-expanded={expanded}
        className="flex min-h-[44px] w-full items-start justify-between gap-3 px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:cursor-default"
      >
        <div className="flex flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <RaceTag race={game.opp_race} />
            {resultBadge}
            <span className="font-mono text-[11px] text-text-dim">
              {fmtDate(game.date)}
            </span>
          </div>
          <div className="text-caption text-text">{game.map || "—"}</div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-text-muted">
            <span>
              opp: <span className="text-text">{game.opp_strategy || "—"}</span>
            </span>
            <span>
              me: <span className="text-text">{game.my_build || "—"}</span>
            </span>
            <span>
              macro:{" "}
              <span className={`tabular-nums ${macroColour}`}>
                {typeof macro === "number" ? macro : "—"}
              </span>
            </span>
            <span>
              len:{" "}
              <span className="tabular-nums text-text">
                {game.game_length ? fmtMinutes(game.game_length) : "—"}
              </span>
            </span>
          </div>
        </div>
        {expandable ? (
          <span className="select-none pt-0.5 text-text-dim" aria-hidden>
            {expanded ? "▾" : "▸"}
          </span>
        ) : null}
      </button>
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

function RaceTag({ race }: { race?: string | null }) {
  const r = (race || "").toUpperCase();
  const letter = r[0] || "?";
  const colour = raceColour(race);
  const hasRace = letter !== "?";
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium"
      style={{
        color: colour,
        borderColor: `${colour}55`,
        background: `${colour}14`,
      }}
    >
      {hasRace ? (
        <Icon name={r} kind="race" size={14} fallback="" decorative />
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
    <BuildOrderTimeline
      events={data.events || []}
      oppEvents={data.opp_events || []}
      defaultPerspective="you"
      gameId={gameId}
      race={data.my_race || game.my_race}
      oppRace={data.opp_race || game.opp_race}
      title={
        data.my_build ? `Your build — ${data.my_build}` : "Your build"
      }
      onSaveAsBuild={async () => {
        // SaveAsBuildButton handles the API call internally via the
        // BuildEditorModal -> PUT /v1/custom-builds/:slug flow.
      }}
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
