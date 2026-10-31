"use client";

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAuth } from "@clerk/nextjs";
import { mayHaveDeviceCopy } from "@/lib/analysisCorpus/deviceNote";
import { apiCall, type ClientApiError } from "@/lib/clientApi";
import { useFilters } from "@/lib/filterContext";
import type { ArcadeGame } from "../types";
import type { CorpusSnapshot, CorpusSync } from "./analysisCorpusSync";

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
  /** True when this account's corpus is kept on this device. */
  onDevice: boolean;
  /** Whether a consumer has explicitly asked for the expensive corpus. */
  isActive: boolean;
  /** Activate the corpus, or retry it after a failed request. */
  load: () => void;
  /**
   * Activate the corpus and keep it on this device from now on: later loads
   * show it at once and sync only changes (the one-time history gate).
   */
  keepOnDevice: () => void;
  /** Release a Daily Pulse request; Arcade can independently keep it active. */
  release: () => void;
};

type AccountBoundAnalysisState = Omit<
  AnalysisGamesResult,
  "isActive" | "load" | "keepOnDevice" | "release"
> & {
  accountKey: string | null;
};

function emptyAnalysisState(
  accountKey: string | null,
  isLoading = false,
): AccountBoundAnalysisState {
  return {
    accountKey,
    items: [],
    isLoading,
    error: null,
    pagesFetched: 0,
    hitCorpusLimit: false,
    onDevice: false,
  };
}

/**
 * On refresh, keep rendering the last complete corpus until its replacement
 * is ready; only a first load (nothing fetched or stored yet) reports loading.
 */
function reloadingState(
  previous: AccountBoundAnalysisState,
  accountKey: string,
): AccountBoundAnalysisState {
  return previous.accountKey === accountKey
    ? {
        ...previous,
        isLoading: previous.pagesFetched === 0 && !previous.onDevice,
        error: null,
      }
    : emptyAnalysisState(accountKey, true);
}

function syncedState(
  accountKey: string,
  synced: CorpusSnapshot & { onDevice: boolean },
): AccountBoundAnalysisState {
  return {
    accountKey,
    items: synced.items,
    isLoading: false,
    error: null,
    pagesFetched: synced.pagesFetched,
    hitCorpusLimit: synced.hitCorpusLimit,
    onDevice: synced.onDevice,
  };
}

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
 * One snapshot read: the rows newest first up to the 20,000-game ceiling, and
 * each page's corpus marks as the server sent them, for the sync to check.
 */
export type RawAnalysisSnapshot = {
  items: AnalysisApiGame[];
  pagesFetched: number;
  hitCorpusLimit: boolean;
  /** The first page's corpusVersion, watermark and corpusEpoch fields. */
  firstPage: unknown;
  /** Every page's corpusEpoch field, in order. */
  pageEpochs: unknown[];
};

type CorpusPageMarks = {
  corpusVersion?: unknown;
  watermark?: unknown;
  corpusEpoch?: unknown;
};

/** Read the bounded snapshot page by page. */
async function readAnalysisSnapshot(
  fetchPage: (path: string) => Promise<unknown>,
): Promise<RawAnalysisSnapshot> {
  const items: AnalysisApiGame[] = [];
  const pageEpochs: unknown[] = [];
  let firstPage: unknown = null;
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
    const page = (await fetchPage(path)) as AnalysisGamesPage & CorpusPageMarks;
    if (pageIndex === 0) {
      const { corpusVersion, watermark, corpusEpoch } = page ?? {};
      firstPage = { corpusVersion, watermark, corpusEpoch };
    }
    pageEpochs.push(page?.corpusEpoch);
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
  return { items, pagesFetched, hitCorpusLimit, firstPage, pageEpochs };
}

/** A snapshot shown from memory only. */
function inMemory(snapshot: RawAnalysisSnapshot): CorpusSync {
  const { items, pagesFetched, hitCorpusLimit } = snapshot;
  return { items, pagesFetched, hitCorpusLimit, marks: null, onDevice: false, kept: false };
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
 *
 * Once an account asks to keep its history on this device (`keepOnDevice`),
 * the stored copy shows first and each load reads only what changed since it
 * (see analysisCorpusSync). Every other account reads snapshots as before.
 */
export function AnalysisGamesProvider({
  children,
  enabled: enabledBySurface = false,
  refreshQuietMs = ANALYSIS_GAMES_REFRESH_QUIET_MS,
}: {
  children: ReactNode;
  /** Arcade passes true only while its tab is mounted. */
  enabled?: boolean;
  refreshQuietMs?: number;
}) {
  const { getToken, isLoaded, isSignedIn, userId } = useAuth();
  const { dbRev } = useFilters();
  const settledRevision = useSettledAnalysisRevision(dbRev, refreshQuietMs);
  const accountKey = isLoaded && isSignedIn && userId ? userId : null;
  const [requestedForAccount, setRequestedForAccount] = useState<string | null>(
    null,
  );
  const [manualRevision, setManualRevision] = useState(0);
  // Asked to keep history on this device, until the device records the
  // choice; after that, a copy another tab cleared is not recreated here.
  const keepRequestedFor = useRef<string | null>(null);
  const active = enabledBySurface
    || (accountKey !== null && requestedForAccount === accountKey);
  const enabled = active && accountKey !== null;
  const [state, setState] = useState<AccountBoundAnalysisState>(() =>
    emptyAnalysisState(accountKey),
  );

  const load = useCallback(() => {
    if (!accountKey) return;
    // Keep the compact Daily Pulse gate visible as a loading state on the
    // very render that follows the click; the fetch effect starts afterward.
    setState((previous) => reloadingState(previous, accountKey));
    setRequestedForAccount(accountKey);
    setManualRevision((value) => value + 1);
  }, [accountKey]);
  const keepOnDevice = useCallback(() => {
    if (!accountKey) return;
    keepRequestedFor.current = accountKey;
    load();
  }, [accountKey, load]);
  const release = useCallback(() => setRequestedForAccount(null), []);

  useEffect(() => {
    if (!active) {
      setState(emptyAnalysisState(accountKey));
      return;
    }
    if (!isLoaded) {
      setState(emptyAnalysisState(null));
      return;
    }
    if (!enabled) {
      setState(emptyAnalysisState(accountKey));
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    setState((previous) => reloadingState(previous, accountKey));

    void (async () => {
      try {
        const fetchPage = (path: string) =>
          apiCall<unknown>(getToken, path, { signal: controller.signal });
        const readSnapshot = () => readAnalysisSnapshot(fetchPage);
        const keepOnDevice = keepRequestedFor.current === accountKey;
        // Only an account that asked to keep its history here, or that this
        // browser notes as keeping it, loads the sync and device store (on
        // demand, outside the dashboard's first-load JavaScript); every other
        // account reads its snapshot at once, as before. If that chunk cannot
        // load (a deploy replaced it), the corpus still loads, in memory.
        const sync = keepOnDevice || mayHaveDeviceCopy(accountKey)
          ? await import("./analysisCorpusSync").catch(() => null)
          : null;
        if (cancelled) return;
        const synced = sync
          ? await sync.syncAnalysisCorpus({
              accountKey,
              keepOnDevice,
              fetchPage,
              readSnapshot,
              onStored: (stored) => {
                if (cancelled) return;
                // History kept on this device shows at once wherever this
                // account's corpus is not on screen yet.
                setState((previous) =>
                  previous.accountKey === accountKey && previous.items.length > 0
                    ? previous
                    : syncedState(accountKey, stored));
              },
              onSnapshot: (snapshot) => {
                if (cancelled) return;
                setState(syncedState(accountKey, { ...snapshot, onDevice: false }));
              },
              signal: controller.signal,
              maxRows: ANALYSIS_GAMES_CORPUS_MAX,
              pageSize: ANALYSIS_GAMES_PAGE_SIZE,
              maxPages: ANALYSIS_GAMES_MAX_PAGES,
            })
          : inMemory(await readSnapshot());

        if (cancelled) return;
        if (synced.kept && keepRequestedFor.current === accountKey) {
          keepRequestedFor.current = null;
        }
        // One replacement assignment is the retention guarantee: old pages
        // and old flat arrays are not kept in an application-wide cache.
        setState(syncedState(accountKey, synced));
      } catch (err) {
        if (cancelled || isAbortError(err)) return;
        setState((previous) => previous.accountKey === accountKey
          ? {
              ...previous,
              isLoading: false,
              error: asClientApiError(err),
            }
          : previous);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    active,
    accountKey,
    enabled,
    getToken,
    isLoaded,
    manualRevision,
    settledRevision,
  ]);

  const value = useMemo(
    () => {
      // React runs effect cleanup after a render commits. During an A → B
      // switch, synchronously hide A's corpus before aborting its requests.
      const visibleState = state.accountKey === accountKey
        ? state
        : emptyAnalysisState(accountKey, enabled);
      return { ...visibleState, isActive: active, load, keepOnDevice, release };
    },
    [accountKey, active, enabled, keepOnDevice, load, release, state],
  );
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
