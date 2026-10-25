"use client";

import { useMemo } from "react";
import { useApi } from "@/lib/clientApi";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { useMyDisplayName } from "@/lib/useMyDisplayName";
import { Modal } from "@/components/ui/Modal";
import { EmptyState, Skeleton } from "@/components/ui/Card";
import { QueryState, hasQueryData } from "@/components/ui/QueryState";
import { AllGamesTable } from "../../AllGamesTable";
import type { ProfileGame } from "../../Last5GamesTimeline";
import type { ReportDrill } from "./types";
import { GameSourceProvider } from "@/lib/useGameSource";

const GAMES_LIMIT = 100;

type GamesListResp = {
  ok?: boolean;
  total?: number;
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
    my_race?: string;
    matchFormat?: ProfileGame["matchFormat"];
    playerCount?: number | null;
  }>;
};

/**
 * Drilldown behind every clickable Macro Report row (score bucket,
 * leak category, matchup / build segment). Fetches the exact cohort
 * via /v1/games-list with the drill's extra filters layered on top of
 * the global FilterBar, and lists it through the shared AllGamesTable —
 * the same macro-breakdown popover and expandable build orders the
 * rest of the app uses, so "aggregate row → specific replay → full
 * breakdown" is two clicks.
 */
export function ReportGamesModal({
  drill,
  onClose,
}: {
  drill: ReportDrill | null;
  onClose: () => void;
}) {
  const { filters, dbRev } = useFilters();
  const myName = useMyDisplayName();
  const open = drill != null;

  const query = useMemo(() => {
    if (!drill) return null;
    return filtersToQuery({
      ...filters,
      ...drill.params,
      sort: "date_desc",
      limit: GAMES_LIMIT,
    });
  }, [filters, drill]);

  const gamesApi = useApi<GamesListResp>(
    open && query ? `/v1/games-list${query}#${dbRev}` : null,
  );
  const { data } = gamesApi;

  const games = useMemo<ProfileGame[]>(
    () =>
      (data?.games || []).map((g) => ({
        id: g.id ?? null,
        date: g.date ?? null,
        gameVersion: g.gameVersion ?? null,
        gameBuild: g.gameBuild ?? null,
        result: g.result ?? null,
        map: g.map ?? null,
        opp_strategy: g.opp_strategy ?? null,
        opp_race: g.opp_race ?? null,
        my_race: g.my_race ?? null,
        matchFormat: g.matchFormat ?? null,
        playerCount: g.playerCount ?? null,
        opponent: g.opponent ?? null,
        my_build: g.build ?? null,
        game_length: g.game_length ?? null,
        macro_score: g.macro_score ?? null,
      })),
    [data],
  );

  if (!drill) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="2xl"
      title={drill.title}
      description={drill.description}
    >
      {!hasQueryData(gamesApi) ? (
        <QueryState q={gamesApi} skeleton={<Skeleton rows={5} />} filtered />
      ) : games.length === 0 ? (
        <EmptyState
          title="No matching games"
          sub="These games may have dropped out under the current filters."
        />
      ) : (
        <>
          <GameSourceProvider filters={query ?? ""} replace><AllGamesTable games={games} myName={myName} /></GameSourceProvider>
          {data && (data.total || 0) > games.length ? (
            <p className="mt-3 text-micro text-text-dim">
              Showing the {games.length.toLocaleString()} most recent of{" "}
              {(data.total || 0).toLocaleString()} matching games.
            </p>
          ) : null}
        </>
      )}
    </Modal>
  );
}
