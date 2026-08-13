"use client";

import { useAuth } from "@clerk/nextjs";
import { useEffect, useState } from "react";
import { API_BASE } from "@/lib/clientApi";
import {
  filtersToQuery,
  type AnalyzerFilters,
} from "@/lib/filterContext";

export type NetMmrRace = "P" | "T" | "Z" | "R" | "U";

/** One local calendar day's accepted, verified MMR movement. */
export type DailyMmrSwing = {
  day: string;
  netMmr: number;
  measuredGames: number;
  wins: number;
  losses: number;
};

/** Daily records computed from the same accepted pairs as matchup impact. */
export type DailyMmrSwings = {
  timezone: string;
  bestGain: DailyMmrSwing | null;
  biggestLoss: DailyMmrSwing | null;
  measuredDays: number;
  measuredGames: number;
  /**
   * Own Battle.net ladder-region records. Optional while responses cached
   * before the region-aware API revision expire.
   */
  regions?: DailyMmrRegionSwings[];
};

export type DailyMmrRegionSwings = {
  region: "NA" | "EU" | "KR" | "CN" | "SEA" | "U";
  bestGain: DailyMmrSwing | null;
  biggestLoss: DailyMmrSwing | null;
  measuredDays: number;
  measuredGames: number;
};

export type NetMmrByMatchupResponseBase = {
  dailySwings?: DailyMmrSwings;
};

export type NetMmrOpponentSort =
  | "net_mmr"
  | "mmr_won"
  | "mmr_lost"
  | "pairs"
  | "win_rate"
  | "avg_delta"
  | "last_played"
  | "name";

export type NetMmrSortOrder = "asc" | "desc";

/** One opponent aggregated from the same accepted pairs as the matchup chart. */
export type NetMmrOpponentRow = {
  pulseId: string | null;
  pulseCharacterId?: string | null;
  toonHandle?: string | null;
  name: string;
  displayName?: string | null;
  opponentRace: NetMmrRace;
  netMmr: number;
  /** Sum of positive pair deltas. */
  mmrWon: number;
  /** Positive magnitude of negative pair deltas. */
  mmrLost: number;
  pairs: number;
  games?: number;
  wins: number;
  losses: number;
  winRate: number;
  avgDelta: number;
  firstPlayed?: string | null;
  lastPlayed?: string | null;
};

export type NetMmrOpponentsSummary = {
  netMmr: number;
  mmrWon: number;
  mmrLost: number;
  pairs: number;
  opponents: number;
  /** Opponent with the greatest positive netMmr, or null when none qualify. */
  mostMmrGainedFrom: NetMmrOpponentRow | null;
  /** Opponent with the most negative netMmr, or null when none qualify. */
  mostMmrLostTo: NetMmrOpponentRow | null;
};

export type NetMmrOpponentsResponse = {
  items: NetMmrOpponentRow[];
  totalOpponents: number;
  /** Generic pagination alias of totalOpponents. */
  total?: number;
  limit: number;
  offset: number;
  summary?: NetMmrOpponentsSummary;
};

export type NetMmrOpponentControls = {
  opp_race?: NetMmrRace;
  search?: string;
  min_pairs?: number;
  sort?: NetMmrOpponentSort;
  order?: NetMmrSortOrder;
  limit?: number;
  offset?: number;
};

/**
 * Canonical path builder shared by the Trends drill-down and Opponents tab.
 * The hash is an SWR-only cache buster; browsers do not send it to the API.
 */
export function netMmrOpponentsPath(
  filters: AnalyzerFilters,
  controls: NetMmrOpponentControls = {},
  dbRev?: number,
): string {
  const path = `/v1/mmr-by-matchup/opponents${filtersToQuery({
    ...filters,
    ...controls,
  })}`;
  return typeof dbRev === "number" ? `${path}#${dbRev}` : path;
}

/**
 * Canonical cache key for the matchup summary. Both the matchup chart and
 * MMR-progression daily-record strip use this exact path so SWR performs one
 * request and the server performs one pairing aggregation.
 */
export function netMmrByMatchupPath(
  filters: AnalyzerFilters,
  timeZone: string,
  dbRev?: number,
): string {
  const path = `/v1/mmr-by-matchup${filtersToQuery({
    ...filters,
    tz: timeZone,
  })}`;
  return typeof dbRev === "number" ? `${path}#${dbRev}` : path;
}

export type AllNetMmrOpponentsResult = {
  items: NetMmrOpponentRow[];
  /** Authoritative pre-pagination totals and leaders from the API. */
  summary: NetMmrOpponentsSummary | null;
  isLoading: boolean;
  error: Error | null;
  pagesFetched: number;
  hitMaxPages: boolean;
};

const ALL_PAGE_SIZE = 500;
const ALL_MAX_PAGES = 20;

/**
 * Fetch every MMR-impact opponent for joins on the Opponents tab.
 * Pages are offset-based and bounded so an unexpected API cursor bug cannot
 * create an unending request chain.
 */
export function useAllNetMmrOpponents(
  filters: AnalyzerFilters,
  dbRev: number,
  options: { enabled?: boolean; pageSize?: number; maxPages?: number } = {},
): AllNetMmrOpponentsResult {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const enabled = options.enabled !== false;
  const pageSize = options.pageSize ?? ALL_PAGE_SIZE;
  const maxPages = options.maxPages ?? ALL_MAX_PAGES;
  const filterKey = filtersToQuery(filters);
  const [state, setState] = useState<AllNetMmrOpponentsResult>({
    items: [],
    summary: null,
    isLoading: true,
    error: null,
    pagesFetched: 0,
    hitMaxPages: false,
  });

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !enabled) {
      setState({
        items: [],
        summary: null,
        isLoading: !isLoaded,
        error: null,
        pagesFetched: 0,
        hitMaxPages: false,
      });
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    setState({
      items: [],
      summary: null,
      isLoading: true,
      error: null,
      pagesFetched: 0,
      hitMaxPages: false,
    });

    void (async () => {
      try {
        const token = await getToken();
        const items: NetMmrOpponentRow[] = [];
        let summary: NetMmrOpponentsSummary | null = null;
        let pagesFetched = 0;
        let totalOpponents = Number.POSITIVE_INFINITY;
        let nextOffset = 0;

        for (let page = 0; page < maxPages && items.length < totalOpponents; page += 1) {
          const path = netMmrOpponentsPathFromQuery(filterKey, {
            sort: "last_played",
            order: "desc",
            limit: pageSize,
            offset: nextOffset,
          });
          const response = await fetch(`${API_BASE}${path}`, {
            headers: token ? { authorization: `Bearer ${token}` } : undefined,
            cache: "no-store",
            signal: controller.signal,
          });
          if (!response.ok) {
            const message = await safeErrorText(response);
            throw new Error(message || `HTTP ${response.status}`);
          }
          const body = (await response.json()) as NetMmrOpponentsResponse;
          const pageItems = Array.isArray(body.items) ? body.items : [];
          if (page === 0) summary = body.summary ?? null;
          items.push(...pageItems);
          totalOpponents = Math.max(0, Number(body.totalOpponents) || 0);
          pagesFetched = page + 1;
          nextOffset += pageItems.length;
          if (pageItems.length === 0) break;
        }

        if (cancelled) return;
        setState({
          items,
          summary,
          isLoading: false,
          error: null,
          pagesFetched,
          hitMaxPages: items.length < totalOpponents,
        });
      } catch (error) {
        if (cancelled || isAbortError(error)) return;
        setState((previous) => ({
          ...previous,
          isLoading: false,
          error: error instanceof Error ? error : new Error(String(error)),
        }));
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    dbRev,
    enabled,
    filterKey,
    getToken,
    isLoaded,
    isSignedIn,
    maxPages,
    pageSize,
  ]);

  return state;
}

function netMmrOpponentsPathFromQuery(
  filterQuery: string,
  controls: NetMmrOpponentControls,
): string {
  const params = new URLSearchParams(filterQuery.replace(/^\?/, ""));
  for (const [key, value] of Object.entries(controls)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const query = params.toString();
  return `/v1/mmr-by-matchup/opponents${query ? `?${query}` : ""}`;
}

function isAbortError(error: unknown): boolean {
  return !!error && typeof error === "object" && "name" in error
    && (error as { name?: string }).name === "AbortError";
}

async function safeErrorText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return response.statusText;
  }
}
