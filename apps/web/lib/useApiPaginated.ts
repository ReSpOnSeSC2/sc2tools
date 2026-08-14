"use client";

// Multi-page cursor fetcher — chases `nextBefore` until exhaustion or
// a hard page cap, accumulating items across pages.
//
// The cloud /v1/opponents endpoint returns `{ items, nextBefore }`.
// To show every opponent in one table without forcing the user to
// click "load more", we fan out a small chain of GETs (capped at
// MAX_PAGES) and concatenate. Re-fetches on dbRev / path changes.

import { useAuth } from "@clerk/nextjs";
import { useEffect, useMemo, useState } from "react";
import { API_BASE } from "@/lib/clientApi";

type CursorPage<T> = { items: T[]; nextBefore: string | null };

const DEFAULT_PAGE_LIMIT = 1000;
const DEFAULT_MAX_PAGES = 8;
const BEFORE_PARAM = "before";

export type UsePaginatedResult<T> = {
  items: T[];
  isLoading: boolean;
  error: Error | null;
  pagesFetched: number;
  hitMaxPages: boolean;
};

type AccountBoundState<T> = UsePaginatedResult<T> & {
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
  const requestKey = useMemo(
    () => isLoaded && isSignedIn && userId && path
      ? JSON.stringify([userId, path, dbRev, pageLimit, maxPages])
      : null,
    [dbRev, isLoaded, isSignedIn, maxPages, pageLimit, path, userId],
  );
  const [state, setState] = useState<AccountBoundState<T>>(() =>
    emptyState(requestKey, !isLoaded || requestKey !== null),
  );

  useEffect(() => {
    if (!requestKey || !path) {
      setState(emptyState(null, !isLoaded));
      return;
    }

    const ctrl = new AbortController();
    let cancelled = false;

    setState(emptyState(requestKey, true));

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
          if (!res.ok) {
            const text = await safeText(res);
            throw new Error(text || `HTTP ${res.status}`);
          }
          const body: CursorPage<T> | T[] = await res.json();
          const page: CursorPage<T> = Array.isArray(body)
            ? { items: body, nextBefore: null }
            : body;
          all.push(...(page.items || []));
          pages = i + 1;
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
          error: null,
          pagesFetched: pages,
          hitMaxPages: hit,
        });
      } catch (err) {
        if (cancelled) return;
        if (err && typeof err === "object" && (err as { name?: string }).name === "AbortError") {
          return;
        }
        setState({
          ...emptyState<T>(requestKey, false),
          isLoading: false,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    })();

    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [getToken, isLoaded, maxPages, pageLimit, path, requestKey]);

  // Effects clean up after a render commits. Fail closed during that one
  // render: if Clerk's account changed, never expose pages tagged for the old
  // request while its AbortController is being retired.
  if (state.requestKey !== requestKey) {
    return emptyState(requestKey, !isLoaded || requestKey !== null);
  }
  return state;
}

function appendQuery(path: string, cursor: string | null, pageLimit: number): string {
  const sep = path.includes("?") ? "&" : "?";
  const parts = [`limit=${pageLimit}`];
  if (cursor) parts.push(`${BEFORE_PARAM}=${encodeURIComponent(cursor)}`);
  return `${path}${sep}${parts.join("&")}`;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return res.statusText || "";
  }
}
