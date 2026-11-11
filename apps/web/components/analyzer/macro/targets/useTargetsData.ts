"use client";

import { useApi } from "@/lib/clientApi";
import { useFilters } from "@/lib/filterContext";
import type { LeagueBenchmark } from "@/lib/benchmarks";
import {
  DEFAULT_LEAGUE_PREFS,
  isLeagueId,
  selectBands,
  type LeagueTargetsPrefs,
  type TargetsResponse,
  type TimingTable,
} from "@/lib/leagueTargets";

/** League tables change nightly; one read an hour is plenty. */
const TABLE_SWR = {
  dedupingInterval: 60 * 60 * 1000,
  revalidateOnFocus: false,
  revalidateIfStale: false,
  shouldRetryOnError: false,
} as const;

type MmrResponse = { entries: Array<{ mmr: number }> };

function useLeagueTable(leagueId: number | null, matchup: string | null) {
  const valid = isLeagueId(leagueId) && !!matchup && /^[PTZ]v[PTZ]$/.test(matchup);
  return useApi<{ table: LeagueBenchmark }>(valid ? `/v1/benchmarks?leagueId=${leagueId}&matchup=${matchup}` : null, TABLE_SWR);
}

function useTimingTable(leagueId: number | null, matchup: string | null, era: string) {
  const valid = isLeagueId(leagueId) && !!matchup && /^[PTZ]v[PTZ]$/.test(matchup);
  return useApi<{ table: TimingTable }>(valid ? `/v1/benchmarks/timings?leagueId=${leagueId}&matchup=${matchup}&era=${era}` : null, TABLE_SWR);
}

/**
 * Everything the Targets card and Today's strip read: the caller's own
 * medians (/v1/benchmarks/targets, refetched on ``games:changed``), the
 * league choice (manual override, then replay MMR, then SC2Pulse), and the
 * current and next league's metric and timing tables (SWR 1 h). A 404 on a
 * table means that band is under the 50-game floor.
 */
export function useTargetsData(requestedMatchup: string | null, includeTimings = true) {
  const { dbRev } = useFilters();
  const query = new URLSearchParams();
  if (requestedMatchup) query.set("matchup", requestedMatchup);
  if (!includeTimings) query.set("timings", "0");
  const targets = useApi<TargetsResponse>(
    `/v1/benchmarks/targets${query.size ? `?${query}` : ""}#${dbRev}`,
    { keepPreviousData: true, revalidateOnFocus: false },
  );
  const prefsReq = useApi<LeagueTargetsPrefs>("/v1/me/preferences/leagueTargets", { revalidateOnFocus: false });
  const prefs = prefsReq.data ?? DEFAULT_LEAGUE_PREFS;
  const needPulse = !!targets.data && targets.data.mmr.current === null && !isLeagueId(prefs.leagueOverride);
  const pulse = useApi<MmrResponse>(needPulse ? "/v1/me/mmr" : null, { revalidateOnFocus: false, shouldRetryOnError: false });
  const pulseMmr = pulse.data?.entries?.reduce<number | null>((best, entry) =>
    typeof entry.mmr === "number" && (best === null || entry.mmr > best) ? entry.mmr : best, null) ?? null;
  const bands = selectBands({ override: prefs.leagueOverride, replayMmr: targets.data?.mmr.current, pulseMmr });
  const matchup = targets.data?.matchup ?? null;
  const era = targets.data?.timings?.era ?? "after";
  const current = useLeagueTable(bands?.current ?? null, matchup);
  const next = useLeagueTable(bands?.next ?? null, matchup);
  const timingMatchup = includeTimings && targets.data?.timings?.era ? matchup : null;
  const currentTimings = useTimingTable(bands?.current ?? null, timingMatchup, era);
  const nextTimings = useTimingTable(bands?.next ?? null, timingMatchup, era);
  return {
    targets,
    prefsReq,
    prefs,
    bands,
    matchup,
    currentTable: current.data?.table ?? null,
    nextTable: next.data?.table ?? null,
    tablesLoading: current.isLoading || next.isLoading,
    currentTimings: currentTimings.data?.table ?? null,
    nextTimings: nextTimings.data?.table ?? null,
    currentMmr: targets.data?.mmr.current ?? pulseMmr,
  };
}
