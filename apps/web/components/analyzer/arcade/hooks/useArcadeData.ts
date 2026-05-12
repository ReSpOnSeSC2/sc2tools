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
  ArcadeUnitStats,
} from "../types";

interface ApiOpp {
  pulseId: string;
  /** Canonical sc2pulse numeric character id; populated post-ingest. */
  pulseCharacterId?: string | null;
  /** Resolved sc2pulse display name; overrides barcode `name`. */
  displayName?: string | null;
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

/**
 * The wire shape of /v1/games is a Mongo-document projection produced
 * by the agent — see apps/api/src/validation/gameRecord.js. The agent
 * canonicalised on camelCase (`durationSec`, `macroScore`) and nests
 * the opponent race under `opponent.race`, but historic SPA code
 * standardised on `duration` / `macro_score` / `oppRace` (the
 * ArcadeGame type). We normalise on read so the arcade modes don't
 * have to know about either naming.
 */
interface ApiGame extends ArcadeGame {
  durationSec?: number;
  macroScore?: number | null;
}

interface ApiGamesPage {
  items: ApiGame[];
  nextBefore?: string | null;
}

export function normaliseGame(g: ApiGame): ArcadeGame {
  const duration =
    typeof g.duration === "number" ? g.duration : g.durationSec;
  const macroScore =
    typeof g.macro_score === "number"
      ? g.macro_score
      : typeof g.macroScore === "number"
        ? g.macroScore
        : null;
  const oppRace = g.oppRace || g.opponent?.race || undefined;
  // The agent persists opponent strategy + pulseId nested under
  // `opponent.{strategy,pulseId}` (see apps/agent/.../replay_pipeline.py
  // line ~570-578). Historic SPA code reads them as top-level
  // `opp_strategy` / `oppPulseId` — Buildle's opponent-opener question
  // and every per-opponent lookup (timesPlayed, careerWR) need these.
  // Without the lift, oppOpener returns null for every game and the
  // case-file generator falls through to "couldn't build today".
  const oppStrategy =
    g.opp_strategy ??
    (g.opponent && typeof g.opponent === "object"
      ? ((g.opponent as { strategy?: string | null }).strategy ?? null)
      : null);
  const oppPulseId =
    g.oppPulseId ??
    (g.opponent && typeof g.opponent === "object"
      ? ((g.opponent as { pulseId?: string }).pulseId ?? undefined)
      : undefined);
  return {
    ...g,
    duration,
    macro_score: macroScore,
    oppRace,
    opp_strategy: oppStrategy,
    oppPulseId,
  };
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
  // /v1/games returns { items, nextBefore }. Request the full corpus
  // up to the server-side GAMES_LIST_MAX ceiling (20 000) — arcade
  // modes aggregate histograms over the user's full history, and a
  // 200-row window was effectively useless for prolific users.
  const gamesA = useApi<ApiGamesPage>("/v1/games?limit=20000");
  // /v1/builds, /v1/matchups, /v1/maps return bare arrays.
  const builds = useApi<ArcadeBuild[]>("/v1/builds");
  // /v1/matchups returns rows of shape `{ name: "vs P", wins, losses,
  // total }` (see apps/api/src/services/aggregations.js matchupFacet).
  // The SPA's `ArcadeDataset.matchups` type uses `name` + `oppRace`;
  // we normalise the wire rows on read.
  const matchups = useApi<
    Array<{ name: string; wins: number; losses: number; total: number; winRate?: number }>
  >("/v1/matchups");
  const maps = useApi<
    Array<{ map: string; wins: number; losses: number; total: number; winRate: number }>
  >("/v1/maps");
  // /v1/summary returns { totals: { wins, losses, total, winRate }, ... }.
  const summary = useApi<ApiSummary>("/v1/summary");
  const custom = useApi<ApiCustomBuilds>("/v1/custom-builds");
  // Arcade-universe endpoint: balanced top-N-per-matchup so the Stock
  // Market spans every matchup (PvP/PvT/PvZ/TvP/TvT/TvZ/ZvP/ZvT/ZvZ +
  // unclassified). The default `?sort=top` over /v1/community/builds
  // collapses to whichever race dominates vote counts — Protoss-heavy
  // communities would crowd Zerg/Terran builds out of the top 100
  // entirely, hiding the entire ZvX/TvX side of the market.
  const community = useApi<ApiCommunityBuilds>(
    "/v1/community/arcade-universe?perMatchup=12",
  );
  const seasons = useApi<ApiSeasons>("/v1/seasons");
  // /v1/arcade/unit-stats — bounded aggregate over the user's recent
  // game_details. Powers the unit-trivia quiz; missing it just means
  // that quiz stays in its empty state, so don't gate ``loading`` on
  // it (other modes don't need it and shouldn't block on the heavy
  // round-trip).
  const unitStats = useApi<ArcadeUnitStats>("/v1/arcade/unit-stats");

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
    const opps: ArcadeOpponent[] = oppRaw.map((o) => {
      const total = o.wins + o.losses;
      const userWr =
        o.winRate ??
        (total > 0 ? o.wins / total : 0);
      return {
        pulseId: o.pulseId,
        pulseCharacterId: o.pulseCharacterId ?? null,
        name: o.name || o.displayNameSample || "(unknown)",
        displayName: o.displayName ?? null,
        wins: o.wins,
        losses: o.losses,
        games: o.games ?? o.gameCount ?? total,
        userWinRate: userWr,
        opponentWinRate: total > 0 ? 1 - userWr : 0,
        lastPlayed: o.lastPlayed || o.lastSeen || null,
      };
    });
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
      games: Array.isArray(gamesA.data?.items)
        ? gamesA.data!.items.map(normaliseGame)
        : [],
      opponents: opps,
      builds: buildsList,
      customBuilds: customList,
      communityBuilds: communityList,
      matchups: Array.isArray(matchups.data)
        ? matchups.data.map((m) => {
            // API names are "vs P" / "vs T" / "vs Z" / "vs Unknown".
            // Pull the race letter off position 3 ("vs <X>") and only
            // tag P/T/Z; everything else is null (e.g. "vs Unknown",
            // legacy "Random" payloads).
            const letter = m.name?.startsWith("vs ")
              ? m.name.charAt(3).toUpperCase()
              : "";
            const oppRace =
              letter === "P" || letter === "T" || letter === "Z"
                ? (letter as "P" | "T" | "Z")
                : null;
            return {
              name: m.name,
              oppRace,
              wins: m.wins ?? 0,
              losses: m.losses ?? 0,
              total: m.total ?? 0,
              winRate:
                typeof m.winRate === "number"
                  ? m.winRate
                  : m.total
                    ? (m.wins ?? 0) / m.total
                    : 0,
            };
          })
        : [],
      maps: Array.isArray(maps.data) ? maps.data : [],
      summary: summaryOut,
      mapPool: Array.isArray(seasons.data?.mapPool) ? seasons.data!.mapPool : [],
      unitStats:
        unitStats.data && typeof unitStats.data === "object"
          ? {
              scannedGames: Number(unitStats.data.scannedGames) || 0,
              builtByUnit:
                unitStats.data.builtByUnit &&
                typeof unitStats.data.builtByUnit === "object"
                  ? unitStats.data.builtByUnit
                  : {},
              totalUnitsLost: Number(unitStats.data.totalUnitsLost) || 0,
              lostGames: Number(unitStats.data.lostGames) || 0,
            }
          : null,
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
    unitStats.data,
  ]);

  return { data, loading, error };
}
