"use client";

// Multi-page cursor fetcher — chases `nextBefore` until exhaustion or
// a hard page cap, accumulating items across pages.
//
// The cloud /v1/opponents endpoint returns `{ items, nextBefore }`.
// To show every opponent in one table without forcing the user to
// click "load more", we fan out a small chain of GETs (capped at
// MAX_PAGES) and concatenate. Re-fetches on dbRev / path changes.

import { useAuth } from "@clerk/nextjs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_BASE, buildApiError, type ClientApiError } from "@/lib/clientApi";
import { toClientApiError } from "@/lib/requestErrors";

type CursorPage<T> = { items: T[]; nextBefore: string | null };

const DEFAULT_PAGE_LIMIT = 1000;
const DEFAULT_MAX_PAGES = 8;
const BEFORE_PARAM = "before";

export type UsePaginatedResult<T> = {
  items: T[];
  isLoading: boolean;
  isRefreshing: boolean;
  isLoadingMore: boolean;
  isStale: boolean;
  /** Same shape as useApi's errors, so RequestError can explain it. */
  error: ClientApiError | null;
  pagesFetched: number;
  hitMaxPages: boolean;
  /** Fetch every page again (a Retry button). */
  mutate: () => void;
  retry: () => void;
};

type AccountBoundState<T> = Omit<UsePaginatedResult<T>, "mutate" | "retry"> & {
  requestKey: string | null;
};

function emptyState<T>(
  requestKey: string | null,
  isLoading: boolean,
): AccountBoundState<T> {
  return {
    requestKey,
    items: [],
    isLoading,
    isRefreshing: false,
    isLoadingMore: false,
    isStale: false,
    error: null,
    pagesFetched: 0,
    hitMaxPages: false,
  };
}

/**
 * Hook that follows the cursor on a `{items, nextBefore}` endpoint
 * until exhaustion. Pass the path WITHOUT a `before` query param —
 * the hook owns it.
 *
 * @param path     The endpoint path, including any non-cursor filters.
 *                 Pass `null` to skip the fetch (e.g. before sign-in).
 * @param dbRev    Cache-buster value from the filter context.
 */
export function useApiPaginated<T>(
  path: string | null,
  dbRev: number,
  opts: { pageLimit?: number; maxPages?: number } = {},
): UsePaginatedResult<T> {
  const { getToken, isLoaded, isSignedIn, userId } = useAuth();
  const pageLimit = opts.pageLimit || DEFAULT_PAGE_LIMIT;
  const maxPages = opts.maxPages || DEFAULT_MAX_PAGES;
  // Retry re-runs the same request without discarding its error panel.
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const requestKey = useMemo(
    () => isLoaded && isSignedIn && userId && path
      ? JSON.stringify([userId, path, pageLimit, maxPages])
      : null,
    [isLoaded, isSignedIn, maxPages, pageLimit, path, userId],
  );
  const [state, setState] = useState<AccountBoundState<T>>(() =>
    emptyState(requestKey, !isLoaded || requestKey !== null),
  );
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (!requestKey || !path) {
      setState(emptyState(null, !isLoaded));
      return;
    }

    const ctrl = new AbortController();
    let cancelled = false;

    const previous = stateRef.current;
    const refreshing = previous.requestKey === requestKey
      && ((!previous.isLoading && !previous.error) || previous.items.length > 0);
    setState(refreshing
      ? { ...previous, isRefreshing: true, isLoadingMore: false }
      : { ...emptyState<T>(requestKey, true), error: previous.requestKey === requestKey ? previous.error : null });

    (async () => {
      try {
        const token = await getToken();
        if (cancelled) return;
        const all: T[] = [];
        let cursor: string | null = null;
        let pages = 0;
        let hit = false;
        for (let i = 0; i < maxPages; i++) {
          const url = appendQuery(path, cursor, pageLimit);
          const res = await fetch(`${API_BASE}${url}`, {
            headers: token ? { authorization: `Bearer ${token}` } : undefined,
            cache: "no-store",
            signal: ctrl.signal,
          });
          // Same envelope parsing as useApi: a friendly message and the
          // request id, never the raw response body.
          if (!res.ok) throw await buildApiError(res);
          const body: CursorPage<T> | T[] = await res.json();
          if (cancelled) return;
          const page: CursorPage<T> = Array.isArray(body)
            ? { items: body, nextBefore: null }
            : body;
          all.push(...(page.items || []));
          pages = i + 1;
          if (!refreshing) setState({
            requestKey, items: [...all], isLoading: false,
            isRefreshing: false, isLoadingMore: !!page.nextBefore && i < maxPages - 1,
            isStale: false, error: null, pagesFetched: pages,
            hitMaxPages: !!page.nextBefore && i === maxPages - 1,
          });
          if (!page.nextBefore) {
            cursor = null;
            break;
          }
          cursor = page.nextBefore;
          if (i === maxPages - 1) hit = true;
        }
        if (cancelled) return;
        setState({
          requestKey,
          items: all,
          isLoading: false,
          isRefreshing: false,
          isLoadingMore: false,
          isStale: false,
          error: null,
          pagesFetched: pages,
          hitMaxPages: hit,
        });
      } catch (err) {
        if (cancelled) return;
        if (err && typeof err === "object" && (err as { name?: string }).name === "AbortError") {
          return;
        }
        const apiError = toClientApiError(err);
        const message = apiError.status === 401 ? "Your session expired. Sign in again."
          : apiError.status === 503 || apiError.code?.endsWith("_busy") ? "The server is busy. Try again in a moment."
            : apiError.code === "network_unavailable" ? "Can't reach SC2 Tools. Check your connection."
              : "We couldn't load your opponents.";
        setState((current) => ({
          ...(current.requestKey === requestKey ? current : emptyState<T>(requestKey, false)),
          isLoading: false, isRefreshing: false, isLoadingMore: false,
          isStale: refreshing, error: { ...apiError, message },
        }));
      }
    })();

    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [attempt, dbRev, getToken, isLoaded, maxPages, pageLimit, path, requestKey]);

  // Effects clean up after a render commits. Fail closed during that one
  // render: if Clerk's account changed, never expose pages tagged for the old
  // request while its AbortController is being retired.
  if (state.requestKey !== requestKey) {
    return { ...emptyState<T>(requestKey, !isLoaded || requestKey !== null), mutate: retry, retry };
  }
  return { ...state, mutate: retry, retry };
}

function appendQuery(path: string, cursor: string | null, pageLimit: number): string {
  const sep = path.includes("?") ? "&" : "?";
  const parts = [`limit=${pageLimit}`];
  if (cursor) parts.push(`${BEFORE_PARAM}=${encodeURIComponent(cursor)}`);
  return `${path}${sep}${parts.join("&")}`;
}
