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

interface ApiGamesPage {
  items: ArcadeGame[];
  nextBefore?: string | null;
}

interface ApiBuilds {
  items?: ArcadeBuild[];
  builds?: ArcadeBuild[];
}

interface ApiMatchups {
  matchups?: Array<{ matchup: string; wins: number; losses: number; total: number; winRate: number }>;
}

interface ApiMaps {
  maps?: Array<{ map: string; wins: number; losses: number; total: number; winRate: number }>;
}

interface ApiSummary {
  totalGames?: number;
  wins?: number;
  losses?: number;
  winRate?: number;
}

interface ApiCustomBuilds {
  items: Array<{ slug: string; name: string; race: string; vsRace?: string }>;
}

interface ApiCommunityBuilds {
  items: Array<{ slug: string; title: string; matchup?: string; votes: number; build?: { race?: string } }>;
}

interface ApiSeasons {
  mapPool?: string[];
}

/**
 * useArcadeData — fans out the small bundle of GETs every Arcade
 * surface needs and folds them into a single ArcadeDataset. SWR keeps
 * each request memoised so QuickPlay → Today → Collection navigation
 * doesn't refetch.
 *
 * Modes never call useApi themselves; they consume this dataset via
 * generate(). Keeps the data dependencies explicit and the picker
 * cheap.
 */
export function useArcadeData(): {
  data: ArcadeDataset | null;
  loading: boolean;
  error: string | null;
} {
  const opp = useApi<ApiOpp[]>("/v1/opponents?limit=500");
  // /v1/games (paginated). One page is enough for active-streak / session
  // analysis; the picker can request more pages on a cold profile.
  const gamesA = useApi<ApiGamesPage>("/v1/games?limit=200");
  const builds = useApi<ApiBuilds>("/v1/builds");
  const matchups = useApi<ApiMatchups>("/v1/matchups");
  const maps = useApi<ApiMaps>("/v1/maps");
  const summary = useApi<ApiSummary>("/v1/summary");
  const custom = useApi<ApiCustomBuilds>("/v1/custom-builds");
  const community = useApi<ApiCommunityBuilds>("/v1/community/builds?limit=100&sort=top");
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
    const opps: ArcadeOpponent[] = (opp.data ?? []).map((o) => ({
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
    const buildsList: ArcadeBuild[] =
      (builds.data?.items as ArcadeBuild[]) ||
      (builds.data?.builds as ArcadeBuild[]) ||
      [];
    const summaryOut: ArcadeSummary | null = summary.data
      ? {
          totalGames: summary.data.totalGames ?? 0,
          wins: summary.data.wins ?? 0,
          losses: summary.data.losses ?? 0,
          winRate: summary.data.winRate ?? 0,
        }
      : null;
    const customList: ArcadeCustomBuild[] = (custom.data?.items ?? []).map(
      (c) => ({ slug: c.slug, name: c.name, race: c.race, vsRace: c.vsRace }),
    );
    const communityList: ArcadeCommunityBuild[] =
      (community.data?.items ?? []).map((c) => ({
        slug: c.slug,
        title: c.title,
        matchup: c.matchup,
        votes: c.votes,
        race: c.build?.race,
      }));
    return {
      games: gamesA.data?.items ?? [],
      opponents: opps,
      builds: buildsList,
      customBuilds: customList,
      communityBuilds: communityList,
      matchups: matchups.data?.matchups ?? [],
      maps: maps.data?.maps ?? [],
      summary: summaryOut,
      mapPool: seasons.data?.mapPool ?? [],
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
