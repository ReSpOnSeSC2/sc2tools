"use client";

import { useApi } from "./clientApi";
import type { GameContext, LeagueBenchmark } from "./benchmarks";

/** Cached aggregate table, scoped by useApi to the signed-in account. */
export function useBenchmarks(leagueId: number | null | undefined, matchup: string | null | undefined, initial?: LeagueBenchmark | null) {
  const valid = Number.isInteger(leagueId) && leagueId! >= 0 && leagueId! <= 6 && /^[PTZ]v[PTZ]$/.test(matchup || "");
  return useApi<{ table: LeagueBenchmark }>(valid ? `/v1/benchmarks?leagueId=${leagueId}&matchup=${matchup}` : null, {
    dedupingInterval: 24 * 60 * 60 * 1000,
    revalidateOnFocus: false,
    revalidateIfStale: false,
    revalidateOnMount: !initial,
    shouldRetryOnError: false,
    ...(initial ? { fallbackData: { table: initial } } : {}),
  });
}

export function useGameContext(gameId: string | null, checkinRevision = 0) {
  return useApi<GameContext>(gameId ? `/v1/games/${encodeURIComponent(gameId)}/context?revision=${checkinRevision}` : null, {
    revalidateOnFocus: false,
    dedupingInterval: 60_000,
    shouldRetryOnError: false,
  });
}
