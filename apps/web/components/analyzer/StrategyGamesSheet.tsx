"use client";
import { useMemo } from "react";
import { useApi } from "@/lib/clientApi";
import { useFilters, describeActiveFilters } from "@/lib/filterContext";
import { strategyDrillFilters, strategyGamesPath, type StrategyDrillFilter } from "@/lib/strategyDrill";
import { useMyDisplayName } from "@/lib/useMyDisplayName";
import { pct1 } from "@/lib/format";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Card, Skeleton } from "@/components/ui/Card";
import { QueryState, hasQueryData } from "@/components/ui/QueryState";
import { AllGamesTable } from "./AllGamesTable";
import { NoFilterMatches } from "./EmptyStates";
import { BuildVsStrategyComparison } from "./StrategiesTabBuildVs";
import type { ProfileGame } from "./Last5GamesTimeline";

type GamesListResp = {
  ok: boolean;
  total: number;
  games: Array<{
    id?: string;
    date?: string;
    gameVersion?: string | null;
    gameBuild?: number | null;
    map?: string;
    opponent?: string;
    opp_race?: string;
    opp_strategy?: string | null;
    result?: string;
    build?: string;
    game_length?: number;
    macro_score?: number | null;
    my_race?: string | null;
    matchFormat?: ProfileGame["matchFormat"];
    playerCount?: number | null;
  }>;
};


export function StrategyGamesSheet({
  drill,
  onBack,
}: {
  drill: StrategyDrillFilter;
  onBack: () => void;
}) {
  const { filters, dbRev, seasons } = useFilters();
  const myName = useMyDisplayName();
  const apiPath = useMemo(
    () => strategyGamesPath(filters, drill, dbRev),
    [filters, drill, dbRev],
  );

  const gamesApi = useApi<GamesListResp>(apiPath);
  const { data } = gamesApi;
  const loaded = hasQueryData(gamesApi);

  const games = useMemo<ProfileGame[]>(() => {
    const raw = data?.games || [];
    // Defensive client-side filter so a server that ignored an unknown
    // query param can't leak unrelated games into the drill-down.
    const filteredRaw = raw.filter((g) => {
      if ((g.opp_strategy || "Unknown") !== drill.opp_strategy) return false;
      if (drill.build && g.build !== drill.build) return false;
      const race = filters.opp_race || drill.opp_race;
      if (race && g.opp_race?.[0]?.toUpperCase() !== race[0].toUpperCase()) return false;
      return true;
    });
    // Forward opp_race / macro_score through. AllGamesTable widens
    // ProfileGame to GameRowData expecting these — without them, the
    // Race column falls back to "?" for every row even when the
    // strategy name explicitly says "Terran - …" or "Zerg - …".
    return filteredRaw.map((g) => ({
      id: g.id || null,
      date: g.date || null,
      gameVersion: g.gameVersion ?? null,
      gameBuild: g.gameBuild ?? null,
      result: g.result || null,
      map: g.map || null,
      opp_strategy: g.opp_strategy || null,
      opp_race: g.opp_race || null,
      my_race: g.my_race ?? null,
      matchFormat: g.matchFormat ?? null,
      playerCount: g.playerCount ?? null,
      opponent: g.opponent || null,
      my_build: g.build || null,
      game_length: g.game_length ?? null,
      macro_score: g.macro_score ?? null,
    }));
  }, [data, drill, filters.opp_race]);

  const titleText = useMemo(() => {
    if (drill.build) return `${drill.build}  vs  ${drill.opp_strategy}`;
    return `vs ${drill.opp_strategy}`;
  }, [drill]);

  const summary = useMemo(() => {
    const total = games.length;
    let wins = 0;
    let losses = 0;
    for (const g of games) {
      const r = String(g.result || "").toLowerCase();
      if (r === "win" || r === "victory") wins++;
      else if (r === "loss" || r === "defeat") losses++;
    }
    const wr = wins + losses ? wins / (wins + losses) : null;
    return { total, wins, losses, wr };
  }, [games]);

  const active = describeActiveFilters(strategyDrillFilters(filters, drill), { seasons });
  return (
    <Modal open onClose={onBack} size="xl" mobileLayout="sheet" title={`${titleText} · ${loaded ? `${summary.total} games` : "Loading games…"}`} footer={<Button variant="secondary" onClick={onBack}>Back to strategies</Button>}>
    <div className="space-y-4">
      <p className="break-words text-caption text-text-muted" aria-label="Active drill filters">{active.length ? active.map(item => `${item.label}: ${item.value}`).join(" · ") : "Default filters"}</p>
      {loaded && summary.total > 0 && <p className="text-caption text-text-muted">{summary.wins}W · {summary.losses}L · {summary.wr === null ? "No decided games" : `${pct1(summary.wr)} win rate`}{data && data.total > games.length ? ` · showing ${games.length} of ${data.total} matching games (5,000 limit)` : ""}</p>}
      {/* When the drill carries both a build AND a strategy, the
          2-column comparison renders above the games list — left side
          is the user's perspective on their build, right side is the
          opponent's perspective on the strategy. */}
      {drill.build ? (
        <BuildVsStrategyComparison
          build={drill.build}
          strategy={drill.opp_strategy}
          oppRace={filters.opp_race || drill.opp_race}
        />
      ) : null}
      {!loaded ? (
        <QueryState q={gamesApi} skeleton={<Skeleton rows={6} />} errorTitle="Games" filtered />
      ) : games.length === 0 ? (
        <Card>
          <NoFilterMatches title="No games match this strategy and the active filters" />
        </Card>
      ) : (
        <Card title={`All games (${games.length}) · newest first`}>
          <div className="-mx-2 overflow-x-auto md:max-h-[640px]">
            <AllGamesTable games={games} myName={myName} />
          </div>
        </Card>
      )}
    </div>
    </Modal>
  );
}

