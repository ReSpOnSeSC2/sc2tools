"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { AlertCircle, CalendarDays, MapPin, RefreshCcw, Search } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { Input } from "@/components/ui/Input";
import { apiCall, useApi } from "@/lib/clientApi";
import type { ClientApiError } from "@/lib/clientApi";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { fmtDate, fmtMinutes } from "@/lib/format";
import { computeEffectiveRace } from "@/lib/macro";
import {
  coerceRace,
  raceIconName,
  raceTint,
  type Race,
} from "@/lib/race";
import { ActiveArmyChart } from "@/components/analyzer/macro/ActiveArmyChart";
import type {
  LeakItem,
  MacroBreakdownData,
} from "@/components/analyzer/macro/MacroBreakdownPanel.types";
import { ApmSpmChart, type ApmCurveData } from "./ApmSpmChart";
import { ChronoAllocationChart } from "./ChronoAllocationChart";
import { ResourcesOverTimeChart } from "./ResourcesOverTimeChart";

/**
 * PerGameInspector — the Activity tab's main surface.
 *
 * Two-pane layout (stacks on mobile):
 *   - Left: searchable list of recent games (driven by /v1/games-list)
 *   - Right: per-game charts for the selected game — Active Army &
 *     Workers, Resources over time, APM/SPM, and Chrono allocation
 *     (Protoss only).
 *
 * Charts hit /v1/games/:id/macro-breakdown and /v1/games/:id/apm-curve.
 * No data is synthesised — older replays without PlayerStatsEvent rows
 * surface inline empty states explaining how to refresh the sample
 * stream.
 */

type GamesListResp = {
  ok?: boolean;
  total?: number;
  games: Array<{
    id?: string;
    date?: string;
    map?: string;
    opponent?: string;
    opp_race?: string;
    opp_strategy?: string | null;
    result?: string;
    build?: string;
    game_length?: number;
    macro_score?: number | null;
    my_race?: string;
  }>;
};

interface SelectedGame {
  id: string;
  date?: string;
  map?: string;
  opponent?: string;
  opp_race?: string;
  result?: string;
  build?: string;
  game_length?: number;
  macro_score?: number | null;
  my_race?: string;
}

const GAMES_LIMIT = 100;

export function PerGameInspector() {
  const { filters, dbRev } = useFilters();
  const queryStr = useMemo(() => {
    return filtersToQuery({
      ...filters,
      sort: "date_desc",
      limit: GAMES_LIMIT,
    });
  }, [filters]);

  const { data, error, isLoading } = useApi<GamesListResp>(
    `/v1/games-list${queryStr}#${dbRev}`,
  );

  const games = useMemo<SelectedGame[]>(() => {
    const raw = data?.games || [];
    return raw
      .filter((g): g is SelectedGame & { id: string } => Boolean(g.id))
      .map((g) => ({
        id: g.id,
        date: g.date,
        map: g.map,
        opponent: g.opponent,
        opp_race: g.opp_race,
        result: g.result,
        build: g.build,
        game_length: g.game_length,
        macro_score: g.macro_score ?? null,
        my_race: g.my_race,
      }));
  }, [data]);

  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (games.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !games.some((g) => g.id === selectedId)) {
      setSelectedId(games[0].id);
    }
  }, [games, selectedId]);

  const filteredGames = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return games;
    return games.filter((g) => {
      const fields = [
        g.opponent,
        g.map,
        g.build,
        g.opp_race,
        g.my_race,
        g.result,
      ]
        .filter(Boolean)
        .map((v) => String(v).toLowerCase());
      return fields.some((f) => f.includes(q));
    });
  }, [games, search]);

  const selected = useMemo(
    () => games.find((g) => g.id === selectedId) || null,
    [games, selectedId],
  );

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_minmax(0,1fr)] xl:grid-cols-[360px_minmax(0,1fr)]">
      <GamePicker
        games={filteredGames}
        totalGames={games.length}
        isLoading={isLoading && games.length === 0}
        error={error?.message}
        search={search}
        onSearch={setSearch}
        selectedId={selectedId}
        onSelect={setSelectedId}
      />
      <div className="min-w-0 space-y-4">
        {selected ? (
          <SelectedGameCharts game={selected} />
        ) : (
          <Card title="Select a replay">
            <EmptyState
              title="No replay selected"
              sub={
                isLoading
                  ? "Loading your recent games…"
                  : "Pick a game from the list to see resources, army, APM, and chrono allocation."
              }
            />
          </Card>
        )}
      </div>
    </div>
  );
}

function GamePicker({
  games,
  totalGames,
  isLoading,
  error,
  search,
  onSearch,
  selectedId,
  onSelect,
}: {
  games: SelectedGame[];
  totalGames: number;
  isLoading: boolean;
  error?: string;
  search: string;
  onSearch: (next: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <Card padded={false} className="flex h-full flex-col">
      <div className="border-b border-border p-3">
        <div className="flex items-center justify-between">
          <h3 className="text-caption font-semibold uppercase tracking-wider text-text">
            Recent replays
          </h3>
          <span className="text-[11px] tabular-nums text-text-dim">
            {totalGames}
          </span>
        </div>
        <div className="relative mt-2">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-dim"
            aria-hidden
          />
          <Input
            type="search"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Filter by opponent, map, build…"
            aria-label="Filter recent replays"
            className="pl-8"
          />
        </div>
      </div>
      <div className="max-h-[640px] flex-1 overflow-y-auto lg:max-h-[80vh]">
        {error ? (
          <p className="p-3 text-caption text-danger">{error}</p>
        ) : isLoading ? (
          <div className="p-3">
            <Skeleton rows={6} />
          </div>
        ) : games.length === 0 ? (
          <EmptyState
            title="No replays match"
            sub={
              search
                ? "Try a different search or clear the filter."
                : "Sync some replays from the desktop agent and they'll appear here."
            }
          />
        ) : (
          <ul role="listbox" aria-label="Recent replays">
            {games.map((g) => (
              <li key={g.id}>
                <GamePickerRow
                  game={g}
                  selected={g.id === selectedId}
                  onSelect={() => onSelect(g.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function GamePickerRow({
  game,
  selected,
  onSelect,
}: {
  game: SelectedGame;
  selected: boolean;
  onSelect: () => void;
}) {
  const result = (game.result || "").toLowerCase();
  const isWin = ["win", "victory"].includes(result);
  const oppRace = coerceRace(game.opp_race);
  const tint = raceTint(oppRace);
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      className={[
        "block w-full border-b border-border px-3 py-2 text-left transition-colors min-h-[60px]",
        "focus-visible:outline-none focus-visible:bg-bg-elevated focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset",
        selected
          ? "bg-bg-elevated/80 border-l-2 border-l-accent"
          : "hover:bg-bg-elevated/50",
      ].join(" ")}
    >
      <div className="flex items-center justify-between gap-2 text-caption">
        <Badge size="sm" variant={isWin ? "success" : "danger"}>
          {isWin ? "Win" : "Loss"}
        </Badge>
        <span className="font-mono text-[11px] text-text-dim">
          {fmtDate(game.date)}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-1.5 text-body text-text">
        <Icon name={raceIconName(oppRace)} kind="race" size={14} decorative />
        <span className={["truncate", tint.text].join(" ")}>
          {game.opponent || "Unknown"}
        </span>
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-text-muted">
        <span className="inline-flex items-center gap-1 truncate">
          <MapPin className="h-3 w-3" aria-hidden />
          {game.map || "—"}
        </span>
        {game.game_length ? (
          <span className="inline-flex items-center gap-1 tabular-nums text-text-dim">
            <CalendarDays className="h-3 w-3" aria-hidden />
            {fmtMinutes(game.game_length)}
          </span>
        ) : null}
        <MacroPill score={game.macro_score} />
      </div>
    </button>
  );
}

function MacroPill({ score }: { score: number | null | undefined }) {
  if (score == null) {
    return <span className="text-text-dim">macro —</span>;
  }
  const tone =
    score >= 75 ? "text-success" : score >= 50 ? "text-warning" : "text-danger";
  return (
    <span className={["tabular-nums", tone].join(" ")}>
      macro {score.toFixed(0)}
    </span>
  );
}

function SelectedGameCharts({ game }: { game: SelectedGame }) {
  const { getToken } = useAuth();
  const { data, error, isLoading, mutate } = useApi<MacroBreakdownData>(
    `/v1/games/${encodeURIComponent(game.id)}/macro-breakdown`,
    { revalidateOnFocus: false },
  );
  const { data: apm, isLoading: apmLoading } = useApi<ApmCurveData>(
    `/v1/games/${encodeURIComponent(game.id)}/apm-curve`,
    { revalidateOnFocus: false },
  );

  const [recomputing, setRecomputing] = useState(false);
  const [recomputeMsg, setRecomputeMsg] = useState<string | null>(null);

  useEffect(() => {
    setRecomputing(false);
    setRecomputeMsg(null);
  }, [game.id]);

  const recompute = useCallback(async () => {
    if (recomputing) return;
    setRecomputeMsg(null);
    setRecomputing(true);
    try {
      await apiCall<{ ok: boolean }>(
        getToken,
        `/v1/games/${encodeURIComponent(game.id)}/macro-breakdown`,
        { method: "POST", body: JSON.stringify({}) },
      );
      setRecomputeMsg(
        "Recompute requested — your SC2 agent will re-parse this replay shortly.",
      );
      mutate();
    } catch (err) {
      const e = err as { message?: string };
      setRecomputeMsg(e.message || "Recompute failed.");
    } finally {
      setRecomputing(false);
    }
  }, [getToken, game.id, mutate, recomputing]);

  const myRace = coerceRace(game.my_race ?? data?.race ?? null);
  const oppRace = coerceRace(game.opp_race);
  const effectiveMacroScore =
    typeof data?.macro_score === "number"
      ? data.macro_score
      : (game.macro_score ?? null);

  const errorIs404 = isNotComputedError(error);

  return (
    <div className="space-y-4">
      <GameSummaryCard
        game={game}
        myRace={myRace}
        oppRace={oppRace}
        macroScore={effectiveMacroScore}
        onRecompute={recompute}
        recomputing={recomputing}
      />

      {recomputeMsg ? (
        <p className="text-caption text-text-muted" role="status">
          {recomputeMsg}
        </p>
      ) : null}

      {errorIs404 ? (
        <NotComputedPanel
          onRecompute={recompute}
          recomputing={recomputing}
        />
      ) : error ? (
        <Card title="Couldn't load this game">
          <EmptyState title="Error" sub={error.message} />
        </Card>
      ) : isLoading ? (
        <Card title="Loading charts">
          <Skeleton rows={6} />
        </Card>
      ) : !data ? null : data.ok === false ? (
        <NotComputedPanel
          onRecompute={recompute}
          recomputing={recomputing}
        />
      ) : (
        <ChartGrid
          data={data}
          apm={apm ?? null}
          apmLoading={apmLoading}
          game={game}
          myRace={myRace}
        />
      )}
    </div>
  );
}

function isNotComputedError(err: ClientApiError | undefined): boolean {
  if (!err) return false;
  if (err.status === 404) return true;
  if (err.code === "macro_not_computed" || err.code === "game_not_found") return true;
  return false;
}

function NotComputedPanel({
  onRecompute,
  recomputing,
}: {
  onRecompute: () => void;
  recomputing: boolean;
}) {
  return (
    <Card padded>
      <div className="rounded-lg border border-border bg-bg-elevated/40 p-5">
        <div className="inline-flex items-center gap-2 text-caption font-semibold text-accent-cyan">
          <AlertCircle className="h-4 w-4" aria-hidden />
          Macro breakdown not available for this game yet
        </div>
        <p className="mt-2 text-caption text-text-muted">
          Newer replays upload the breakdown automatically. Older ones were
          synced before that field existed — Recompute asks your SC2 agent to
          re-parse the .SC2Replay file. Make sure the agent is running, then
          click <span className="font-semibold text-text">Recompute</span> or
          open the agent and trigger a Resync to refresh every replay at once.
        </p>
        <div className="mt-3">
          <Button
            variant="secondary"
            size="sm"
            loading={recomputing}
            onClick={onRecompute}
            iconLeft={<RefreshCcw className="h-3.5 w-3.5" aria-hidden />}
          >
            {recomputing ? "Recomputing…" : "Recompute now"}
          </Button>
        </div>
      </div>
    </Card>
  );
}

function GameSummaryCard({
  game,
  myRace,
  oppRace,
  macroScore,
  onRecompute,
  recomputing,
}: {
  game: SelectedGame;
  myRace: Race;
  oppRace: Race;
  macroScore: number | null;
  onRecompute: () => void;
  recomputing: boolean;
}) {
  const result = (game.result || "").toLowerCase();
  const isWin = ["win", "victory"].includes(result);
  return (
    <Card padded>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-caption text-text-muted">
            <Badge size="sm" variant={isWin ? "success" : "danger"}>
              {isWin ? "Win" : "Loss"}
            </Badge>
            <span className="font-mono text-[11px] text-text-dim">
              {fmtDate(game.date)}
            </span>
            {game.game_length ? (
              <span className="text-[11px] tabular-nums text-text-dim">
                · {fmtMinutes(game.game_length)}
              </span>
            ) : null}
          </div>
          <h3 className="mt-1 truncate text-h4 font-semibold text-text">
            {game.opponent || "Unknown opponent"}
          </h3>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-text-muted">
            <span className="inline-flex items-center gap-1.5">
              <Icon name={raceIconName(myRace)} kind="race" size={14} decorative />
              <span>You · {myRace}</span>
            </span>
            <span className="text-text-dim">vs</span>
            <span className="inline-flex items-center gap-1.5">
              <Icon
                name={raceIconName(oppRace)}
                kind="race"
                size={14}
                decorative
              />
              <span>{oppRace}</span>
            </span>
            {game.map ? (
              <span className="inline-flex items-center gap-1">
                <MapPin className="h-3.5 w-3.5" aria-hidden />
                {game.map}
              </span>
            ) : null}
            {game.build ? (
              <Badge size="sm" variant="neutral">
                {game.build}
              </Badge>
            ) : null}
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          <SummaryStat
            label="Macro"
            value={macroScore == null ? "—" : macroScore.toFixed(1)}
            tone={
              macroScore == null
                ? "neutral"
                : macroScore >= 75
                  ? "success"
                  : macroScore >= 50
                    ? "warning"
                    : "danger"
            }
          />
          <Button
            variant="secondary"
            size="sm"
            loading={recomputing}
            onClick={onRecompute}
            iconLeft={<RefreshCcw className="h-3.5 w-3.5" aria-hidden />}
          >
            {recomputing ? "Recomputing…" : "Recompute"}
          </Button>
        </div>
      </div>
    </Card>
  );
}

function SummaryStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "neutral" | "success" | "warning" | "danger";
}) {
  const toneClass =
    tone === "success"
      ? "text-success"
      : tone === "warning"
        ? "text-warning"
        : tone === "danger"
          ? "text-danger"
          : "text-text";
  return (
    <div className="rounded-lg border border-border bg-bg-elevated px-3 py-2 text-right">
      <div className="text-[10px] uppercase tracking-wider text-text-dim">
        {label}
      </div>
      <div
        className={["text-xl font-semibold tabular-nums", toneClass].join(" ")}
      >
        {value}
      </div>
    </div>
  );
}

function ChartGrid({
  data,
  apm,
  apmLoading,
  game,
  myRace,
}: {
  data: MacroBreakdownData;
  apm: ApmCurveData | null;
  apmLoading: boolean;
  game: SelectedGame;
  myRace: Race;
}) {
  const samples = data.stats_events ?? [];
  const oppSamples = data.opp_stats_events ?? [];
  const leaks: LeakItem[] = data.all_leaks ?? data.top_3_leaks ?? [];
  const effRace = computeEffectiveRace(myRace, data.raw);
  const chronoTargets = data.raw?.chrono_targets ?? [];
  const showChrono = effRace === "Protoss";

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <Card padded>
        <ActiveArmyChart
          samples={samples}
          oppSamples={oppSamples}
          gameLengthSec={data.game_length_sec}
          leaks={leaks}
          highlightedKey={null}
        />
      </Card>
      <Card padded>
        <ResourcesOverTimeChart
          samples={samples}
          oppSamples={oppSamples}
          gameLengthSec={data.game_length_sec}
        />
      </Card>
      <Card padded className={showChrono ? "" : "xl:col-span-2"}>
        {apmLoading && !apm ? (
          <Skeleton rows={5} />
        ) : (
          <ApmSpmChart data={apm} myPlayerName={null} myRace={myRace} />
        )}
      </Card>
      {showChrono ? (
        <Card padded>
          <ChronoAllocationChart targets={chronoTargets} />
        </Card>
      ) : null}
    </div>
  );
}
