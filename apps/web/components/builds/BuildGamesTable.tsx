"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Card, EmptyState } from "@/components/ui/Card";
import { useApi } from "@/lib/clientApi";
import { fmtDate, fmtMinutes } from "@/lib/format";
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
  events: { time: number; time_display: string; name: string; display: string; race: string; category: string }[];
  opp_events: { time: number; time_display: string; name: string; display: string; race: string; category: string }[];
}

/**
 * BuildGamesTable — recent games for a custom build with build-order
 * drilldown. Desktop renders a sortable-style table; mobile collapses
 * to stacked cards with the same data and the same expand action.
 */
export function BuildGamesTable({ games }: { games: BuildRecentGame[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  if (games.length === 0) {
    return (
      <Card title="Recent games">
        <EmptyState sub="No games using this build yet. Once you play some, they list here newest-first." />
      </Card>
    );
  }
  return (
    <Card title={`Recent games · ${games.length}`}>
      <div className="hidden md:block">
        <table className="w-full text-caption">
          <thead className="bg-bg-elevated text-[11px] uppercase tracking-wider text-text-muted">
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
            {games.map((g) => (
              <GameRow
                key={g.gameId}
                game={g}
                expanded={expanded === g.gameId}
                onToggle={() =>
                  setExpanded((cur) => (cur === g.gameId ? null : g.gameId))
                }
              />
            ))}
          </tbody>
        </table>
      </div>
      <ul className="space-y-2 md:hidden">
        {games.map((g) => (
          <GameMobile
            key={g.gameId}
            game={g}
            expanded={expanded === g.gameId}
            onToggle={() =>
              setExpanded((cur) => (cur === g.gameId ? null : g.gameId))
            }
          />
        ))}
      </ul>
    </Card>
  );
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
  const result = (game.result || "").toString();
  const isWin = ["win", "victory"].includes(result.toLowerCase());
  return (
    <>
      <tr
        className={[
          "cursor-pointer border-t border-border transition-colors",
          expanded ? "bg-bg-elevated/40" : "hover:bg-bg-elevated/40",
        ].join(" ")}
        onClick={onToggle}
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
        <td className="px-2 py-1.5 text-text">{game.map || "—"}</td>
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
          <Badge size="sm" variant={isWin ? "success" : "danger"}>
            {isWin ? "Win" : "Loss"}
          </Badge>
        </td>
      </tr>
      {expanded ? (
        <tr className="bg-bg-elevated/20">
          <td colSpan={8} className="px-2 pb-3 pt-1">
            <BuildOrderExpansion gameId={game.gameId} />
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
  const result = (game.result || "").toString();
  const isWin = ["win", "victory"].includes(result.toLowerCase());
  return (
    <li
      className={[
        "rounded-lg border border-border bg-bg-surface",
        expanded ? "border-border-strong" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex min-h-[44px] w-full items-start justify-between gap-3 px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
      >
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2 text-caption">
            <Badge size="sm" variant={isWin ? "success" : "danger"}>
              {isWin ? "Win" : "Loss"}
            </Badge>
            <span className="font-mono text-text-dim">{fmtDate(game.date)}</span>
            <MacroCell value={game.macroScore ?? null} />
          </div>
          <div className="text-caption text-text">{game.map || "—"}</div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-text-muted">
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
        <div className="border-t border-border px-3 py-2">
          <BuildOrderExpansion gameId={game.gameId} />
        </div>
      ) : null}
    </li>
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

function BuildOrderExpansion({ gameId }: { gameId: string }) {
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
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      <BuildOrderColumn
        title={`Your build${data.my_build ? ` — ${data.my_build}` : ""}`}
        events={data.events}
      />
      <BuildOrderColumn
        title={`Opponent's build${data.opp_strategy ? ` — ${data.opp_strategy}` : ""}`}
        events={data.opp_events}
        emptySub="Opponent build log not extracted yet."
      />
    </div>
  );
}

function BuildOrderColumn({
  title,
  events,
  emptySub,
}: {
  title: string;
  events: BuildOrderResp["events"];
  emptySub?: string;
}) {
  const visible = useMemo(
    () => (events || []).filter((e) => e && e.name && e.time != null),
    [events],
  );
  return (
    <Card title={title}>
      {visible.length === 0 ? (
        <EmptyState sub={emptySub || "No build events parsed."} />
      ) : (
        <ul className="max-h-[280px] space-y-1 overflow-y-auto pr-1 text-caption">
          {visible.map((e, i) => (
            <li
              key={`${e.time}-${e.name}-${i}`}
              className="flex items-center gap-3"
            >
              <span className="w-12 font-mono tabular-nums text-text-dim">
                {e.time_display}
              </span>
              <span className="truncate text-text">{e.display || e.name}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
