"use client";

import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall, type ClientApiError } from "@/lib/clientApi";
import { useFilters } from "@/lib/filterContext";
import type { ArcadeGame } from "../types";

/**
 * Wire row returned by the strict API analysis projection. Historic rows may
 * still use the old aliases; normaliseGame owns that compatibility mapping.
 */
export interface AnalysisApiGame extends ArcadeGame {
  durationSec?: number;
  macroScore?: number | null;
}

export interface AnalysisGamesPage {
  items: AnalysisApiGame[];
  nextCursor: string | null;
}

export const ANALYSIS_GAMES_PAGE_SIZE = 2000;
export const ANALYSIS_GAMES_MAX_PAGES = 10;
export const ANALYSIS_GAMES_CORPUS_MAX = 20_000;
export const ANALYSIS_GAMES_REFRESH_QUIET_MS = 30_000;

export type AnalysisGamesResult = {
  items: AnalysisApiGame[];
  isLoading: boolean;
  error: ClientApiError | null;
  pagesFetched: number;
  /** True only when the established 20,000-game product ceiling was hit. */
  hitCorpusLimit: boolean;
};

const AnalysisGamesContext = createContext<AnalysisGamesResult | null>(null);

/** Build one bounded cursor URL; exported for the wire-contract tests. */
export function analysisGamesPageKey(
  pageIndex: number,
  previousPage: AnalysisGamesPage | null,
  enabled = true,
): string | null {
  if (!enabled || pageIndex >= ANALYSIS_GAMES_MAX_PAGES) return null;
  if (previousPage && !previousPage.nextCursor) return null;
  const query = new URLSearchParams({
    limit: String(ANALYSIS_GAMES_PAGE_SIZE),
  });
  if (previousPage?.nextCursor) {
    query.set("cursor", previousPage.nextCursor);
  }
  return `/v1/games/analysis-corpus?${query.toString()}`;
}

/**
 * Full Resync emits games:changed for every accepted batch. Waiting for a
 * quiet period prevents each batch from restarting a ten-page history read;
 * one ordinary post-game event still refreshes automatically after 30s.
 */
export function useSettledAnalysisRevision(
  dbRev: number,
  quietMs = ANALYSIS_GAMES_REFRESH_QUIET_MS,
): number {
  const [settledRevision, setSettledRevision] = useState(dbRev);
  useEffect(() => {
    if (dbRev === settledRevision) return;
    const timer = window.setTimeout(
      () => setSettledRevision(dbRev),
      quietMs,
    );
    return () => window.clearTimeout(timer);
  }, [dbRev, quietMs, settledRevision]);
  return settledRevision;
}

/**
 * Own the single current replay corpus shared by Daily Pulse and Arcade.
 *
 * This deliberately uses component state instead of SWR Infinite. Cursor URLs
 * change whenever a new leading game shifts page boundaries; SWR's global Map
 * retains each old cursor URL indefinitely, which could accumulate another
 * compact corpus after every refresh on a mobile tab. This provider loads
 * pages sequentially and replaces one flat array only after the next snapshot
 * succeeds, releasing all prior pages/keys for garbage collection.
 */
export function AnalysisGamesProvider({
  children,
  refreshQuietMs = ANALYSIS_GAMES_REFRESH_QUIET_MS,
}: {
  children: ReactNode;
  refreshQuietMs?: number;
}) {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const { dbRev } = useFilters();
  const settledRevision = useSettledAnalysisRevision(dbRev, refreshQuietMs);
  const enabled = isLoaded && isSignedIn;
  const [state, setState] = useState<AnalysisGamesResult>({
    items: [],
    isLoading: true,
    error: null,
    pagesFetched: 0,
    hitCorpusLimit: false,
  });

  useEffect(() => {
    if (!isLoaded) return;
    if (!enabled) {
      setState({
        items: [],
        isLoading: false,
        error: null,
        pagesFetched: 0,
        hitCorpusLimit: false,
      });
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    // On refresh, keep rendering the last complete snapshot until its
    // replacement is ready. Initial load still reports loading to consumers.
    setState((previous) => ({
      ...previous,
      isLoading: previous.pagesFetched === 0,
      error: null,
    }));

    void (async () => {
      try {
        const items: AnalysisApiGame[] = [];
        let previousPage: AnalysisGamesPage | null = null;
        let pagesFetched = 0;
        let hitCorpusLimit = false;

        for (
          let pageIndex = 0;
          pageIndex < ANALYSIS_GAMES_MAX_PAGES;
          pageIndex += 1
        ) {
          const path = analysisGamesPageKey(pageIndex, previousPage, true);
          if (!path) break;
          const page = await apiCall<AnalysisGamesPage>(getToken, path, {
            signal: controller.signal,
          });
          const pageItems = Array.isArray(page?.items) ? page.items : [];
          const remaining = ANALYSIS_GAMES_CORPUS_MAX - items.length;
          items.push(...pageItems.slice(0, remaining));
          pagesFetched += 1;
          previousPage = page;

          if (items.length >= ANALYSIS_GAMES_CORPUS_MAX) {
            hitCorpusLimit =
              pageItems.length > remaining || Boolean(page.nextCursor);
            break;
          }
          if (!page.nextCursor) break;
          if (pageIndex === ANALYSIS_GAMES_MAX_PAGES - 1) {
            hitCorpusLimit = true;
          }
        }

        if (cancelled) return;
        // One replacement assignment is the retention guarantee: old pages
        // and old flat arrays are not kept in an application-wide cache.
        setState({
          items,
          isLoading: false,
          error: null,
          pagesFetched,
          hitCorpusLimit,
        });
      } catch (err) {
        if (cancelled || isAbortError(err)) return;
        setState((previous) => ({
          ...previous,
          isLoading: false,
          error: asClientApiError(err),
        }));
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [enabled, getToken, isLoaded, settledRevision]);

  const value = useMemo(() => state, [state]);
  return createElement(AnalysisGamesContext.Provider, { value }, children);
}

/** Read the one current corpus owned by AnalyzerProvider. */
export function useAnalysisGames(): AnalysisGamesResult {
  const value = useContext(AnalysisGamesContext);
  if (!value) {
    throw new Error("useAnalysisGames requires AnalysisGamesProvider");
  }
  return value;
}

function isAbortError(err: unknown): boolean {
  return Boolean(
    err
      && typeof err === "object"
      && (err as { name?: unknown }).name === "AbortError",
  );
}

function asClientApiError(err: unknown): ClientApiError {
  if (
    err
    && typeof err === "object"
    && typeof (err as { message?: unknown }).message === "string"
  ) {
    return err as ClientApiError;
  }
  return { status: 0, message: String(err || "Request failed") };
}
