"use client";

import { useMemo } from "react";
import { useApi } from "@/lib/clientApi";
import type {
  ArcadeBuild,
  ArcadeCommunityBuild,
  ArcadeCustomBuild,
  ArcadeDataset,
  ArcadeGame,
  ArcadeOpponent,
  ArcadeSummary,
} from "../types";

interface ApiOpp {
  pulseId: string;
  name?: string;
  displayNameSample?: string;
  wins: number;
  losses: number;
  games?: number;
  gameCount?: number;
  winRate: number;
  lastPlayed?: string | null;
  lastSeen?: string | null;
}

/** /v1/opponents response — wrapped page with items[]. */
interface ApiOppPage {
  items: ApiOpp[];
  nextBefore?: string | null;
}

interface ApiGamesPage {
  items: ArcadeGame[];
  nextBefore?: string | null;
}

interface ApiSummary {
  totals?: {
    wins?: number;
    losses?: number;
    total?: number;
    winRate?: number;
  };
}

interface ApiCustomBuilds {
  items: Array<{ slug: string; name: string; race: string; vsRace?: string }>;
}

interface ApiCommunityBuilds {
  items: Array<{
    slug: string;
    title: string;
    matchup?: string;
    votes: number;
    build?: { race?: string };
  }>;
}

interface ApiSeasons {
  mapPool?: string[];
}

/**
 * useArcadeData — fans out the bundle of GETs every Arcade surface
 * needs and folds them into a single ArcadeDataset. SWR keeps each
 * request memoised so QuickPlay → Today → Collection navigation
 * doesn't refetch.
 *
 * Every consumer of an array-shaped field is guarded by
 * `Array.isArray()`: the analyzer SPA spans many API versions and a
 * future shape change should NOT crash the whole Arcade tab. Empty
 * dataset surfaces empty-state cards in each mode; that's the
 * intended graceful-degradation path.
 */
export function useArcadeData(): {
  data: ArcadeDataset | null;
  loading: boolean;
  error: string | null;
} {
  // /v1/opponents returns { items, nextBefore }, not a bare array.
  const opp = useApi<ApiOppPage>("/v1/opponents?limit=500");
  // /v1/games returns { items, nextBefore }.
  const gamesA = useApi<ApiGamesPage>("/v1/games?limit=200");
  // /v1/builds, /v1/matchups, /v1/maps return bare arrays.
  const builds = useApi<ArcadeBuild[]>("/v1/builds");
  const matchups = useApi<
    Array<{ matchup: string; wins: number; losses: number; total: number; winRate: number }>
  >("/v1/matchups");
  const maps = useApi<
    Array<{ map: string; wins: number; losses: number; total: number; winRate: number }>
  >("/v1/maps");
  // /v1/summary returns { totals: { wins, losses, total, winRate }, ... }.
  const summary = useApi<ApiSummary>("/v1/summary");
  const custom = useApi<ApiCustomBuilds>("/v1/custom-builds");
  const community = useApi<ApiCommunityBuilds>(
    "/v1/community/builds?limit=100&sort=top",
  );
  const seasons = useApi<ApiSeasons>("/v1/seasons");

  const loading =
    opp.isLoading ||
    gamesA.isLoading ||
    builds.isLoading ||
    matchups.isLoading ||
    maps.isLoading ||
    summary.isLoading ||
    custom.isLoading ||
    community.isLoading ||
    seasons.isLoading;

  const error =
    opp.error?.message ||
    gamesA.error?.message ||
    builds.error?.message ||
    matchups.error?.message ||
    maps.error?.message ||
    summary.error?.message ||
    custom.error?.message ||
    community.error?.message ||
    seasons.error?.message ||
    null;

  const data = useMemo<ArcadeDataset | null>(() => {
    if (loading || error) return null;
    const oppRaw = Array.isArray(opp.data?.items) ? opp.data!.items : [];
    const opps: ArcadeOpponent[] = oppRaw.map((o) => ({
      pulseId: o.pulseId,
      name: o.name || o.displayNameSample || "(unknown)",
      wins: o.wins,
      losses: o.losses,
      games: o.games ?? o.gameCount ?? o.wins + o.losses,
      winRate:
        o.winRate ??
        (o.wins + o.losses > 0 ? o.wins / (o.wins + o.losses) : 0),
      lastPlayed: o.lastPlayed || o.lastSeen || null,
    }));
    const buildsList: ArcadeBuild[] = Array.isArray(builds.data)
      ? builds.data
      : [];
    const summaryOut: ArcadeSummary | null = summary.data?.totals
      ? {
          totalGames: summary.data.totals.total ?? 0,
          wins: summary.data.totals.wins ?? 0,
          losses: summary.data.totals.losses ?? 0,
          winRate: summary.data.totals.winRate ?? 0,
        }
      : null;
    const customList: ArcadeCustomBuild[] = Array.isArray(custom.data?.items)
      ? custom.data!.items.map((c) => ({
          slug: c.slug,
          name: c.name,
          race: c.race,
          vsRace: c.vsRace,
        }))
      : [];
    const communityList: ArcadeCommunityBuild[] = Array.isArray(
      community.data?.items,
    )
      ? community.data!.items.map((c) => ({
          slug: c.slug,
          title: c.title,
          matchup: c.matchup,
          votes: c.votes,
          race: c.build?.race,
        }))
      : [];
    return {
      games: Array.isArray(gamesA.data?.items) ? gamesA.data!.items : [],
      opponents: opps,
      builds: buildsList,
      customBuilds: customList,
      communityBuilds: communityList,
      matchups: Array.isArray(matchups.data) ? matchups.data : [],
      maps: Array.isArray(maps.data) ? maps.data : [],
      summary: summaryOut,
      mapPool: Array.isArray(seasons.data?.mapPool) ? seasons.data!.mapPool : [],
    };
  }, [
    loading,
    error,
    opp.data,
    gamesA.data,
    builds.data,
    matchups.data,
    maps.data,
    summary.data,
    custom.data,
    community.data,
    seasons.data,
  ]);

  return { data, loading, error };
}
