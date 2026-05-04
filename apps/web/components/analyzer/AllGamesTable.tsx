"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useApi } from "@/lib/clientApi";
import { fmtDate, fmtMinutes, raceColour } from "@/lib/format";
import { Card, EmptyState } from "@/components/ui/Card";
import type { ProfileGame } from "./Last5GamesTimeline";

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

/**
 * All games table for the opponent profile. Rows are clickable: a
 * click expands the build-order timeline pulled from
 * `/v1/games/:id/build-order`. Both your-tech and opponent-tech
 * timelines are shown side-by-side when available.
 *
 * Mirrors the legacy `GamesTableWithBuildOrder` for `perspective="opponent"`.
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

  return (
    <div className="overflow-x-auto">
      <table ref={tableRef} className="w-full text-sm">
        <thead className="sticky top-0 z-10 bg-bg-elevated text-[11px] uppercase text-text-muted">
          <tr>
            <th className="w-6 px-2 py-1 text-left"></th>
            <th className="px-2 py-1 text-left">Date</th>
            <th className="px-2 py-1 text-left">Map</th>
            <th className="px-2 py-1 text-left">Race</th>
            <th className="px-2 py-1 text-left">Strategy</th>
            <th className="px-2 py-1 text-left">My Build</th>
            <th className="px-2 py-1 text-right">Macro</th>
            <th className="px-2 py-1 text-right">Length</th>
            <th className="px-2 py-1 text-right">Result</th>
          </tr>
        </thead>
        <tbody>
          {games.map((g, i) => (
            <GameRow
              key={g.id || `_idx_${i}`}
              game={g}
              expanded={!!g.id && expandedId === g.id}
              onToggle={() => {
                if (!g.id) return;
                setExpandedId((cur) => (cur === g.id ? null : g.id || null));
              }}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GameRow({
  game,
  expanded,
  onToggle,
}: {
  game: ProfileGame & { opp_race?: string; macro_score?: number | null };
  expanded: boolean;
  onToggle: () => void;
}) {
  const expandable = !!game.id;
  const opp_race = (game as any).opp_race as string | undefined;
  const macro = (game as any).macro_score as number | null | undefined;
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
  const resultColour = isWin
    ? "text-success"
    : isLoss
      ? "text-danger"
      : "text-text-dim";
  return (
    <Fragment>
      <tr
        data-game-row-id={game.id || ""}
        className={
          "border-t border-border " +
          (expandable ? "cursor-pointer hover:bg-bg-elevated/60 " : "") +
          (expanded ? "bg-bg-elevated/40" : "")
        }
        onClick={expandable ? onToggle : undefined}
      >
        <td className="select-none px-2 py-1 text-text-dim">
          {expandable ? (expanded ? "▾" : "▸") : ""}
        </td>
        <td className="px-2 py-1 font-mono text-xs text-text-muted">
          {fmtDate(game.date)}
        </td>
        <td className="px-2 py-1 text-text">{game.map || "—"}</td>
        <td
          className="px-2 py-1 font-mono text-xs"
          style={{ color: raceColour(opp_race) }}
        >
          {(opp_race || "?")[0]?.toUpperCase()}
        </td>
        <td className="px-2 py-1 text-text-muted">
          {game.opp_strategy || "—"}
        </td>
        <td className="px-2 py-1 text-text" title="The build I played">
          {game.my_build || "—"}
        </td>
        <td className={`px-2 py-1 text-right font-semibold tabular-nums ${macroColour}`}>
          {typeof macro === "number" ? macro : "—"}
        </td>
        <td className="px-2 py-1 text-right tabular-nums text-text-muted">
          {game.game_length ? fmtMinutes(game.game_length) : "—"}
        </td>
        <td className={`px-2 py-1 text-right font-semibold ${resultColour}`}>
          {result || "—"}
        </td>
      </tr>
      {expanded && game.id ? (
        <tr className="bg-bg-elevated/30">
          <td colSpan={9} className="px-2 pb-3">
            <BuildOrderRow gameId={game.id} />
          </td>
        </tr>
      ) : null}
    </Fragment>
  );
}

function BuildOrderRow({ gameId }: { gameId: string }) {
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
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      <BuildOrderColumn
        title={`Your build${data.my_build ? ` — ${data.my_build}` : ""}`}
        events={data.events}
      />
      <BuildOrderColumn
        title={`Opponent's build${data.opp_strategy ? ` — ${data.opp_strategy}` : ""}`}
        events={data.opp_events}
        emptySub="Opponent build log not extracted yet"
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
  events: BuildOrderEvent[];
  emptySub?: string;
}) {
  const visible = useMemo(
    () => (events || []).filter((e) => e && e.name && e.time != null),
    [events],
  );
  return (
    <Card title={title}>
      {visible.length === 0 ? (
        <EmptyState sub={emptySub || "No build events parsed"} />
      ) : (
        <ul className="max-h-[300px] space-y-1 overflow-y-auto pr-1 text-xs">
          {visible.map((e, i) => (
            <li
              key={`${e.time}-${e.name}-${i}`}
              className="flex items-center gap-3"
            >
              <span className="w-12 font-mono tabular-nums text-text-dim">
                {e.time_display}
              </span>
              <span
                className="rounded px-1.5 py-0.5 text-[10px] uppercase"
                style={{ background: categoryColour(e.category) + "22", color: categoryColour(e.category) }}
              >
                {e.category || "—"}
              </span>
              <span className="truncate text-text">{e.display || e.name}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function categoryColour(c: string | undefined): string {
  switch (c) {
    case "tech":
      return "#3ec07a";
    case "production":
      return "#7c8cff";
    case "expansion":
      return "#e6b450";
    case "defense":
      return "#ff9d6c";
    default:
      return "#9aa3b2";
  }
}

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, (c) =>
    `\\${c.charCodeAt(0).toString(16)} `,
  );
}
