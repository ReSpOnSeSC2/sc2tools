"use client";

import { useAuth } from "@clerk/nextjs";
import { useMemo } from "react";
import useSWRInfinite from "swr/infinite";
import { apiCall, useOwnerRequestScope, type ClientApiError } from "@/lib/clientApi";
import type { MyReviewPage } from "@/lib/reviews";

/** Every page belongs to one account and one section/filter/sort identity. */
export function useReviewPages<T>(path: string, enabled: boolean, initial?: MyReviewPage<T>) {
  const { isLoaded, isSignedIn, userId, getToken } = useAuth();
  const owner = isLoaded && isSignedIn && userId ? userId : null;
  const runOwned = useOwnerRequestScope(owner, getToken);
  const initialItems = initial?.items, initialCursor = initial?.nextCursor;
  const fallback = useMemo(() => initialItems ? [{ items: initialItems, nextCursor: initialCursor ?? null }] : undefined, [initialItems, initialCursor]);
  const result = useSWRInfinite<MyReviewPage<T>, ClientApiError>(
    (index: number, previous: MyReviewPage<T> | null) => {
      if (!enabled || !owner || (index > 0 && !previous?.nextCursor)) return null;
      const page = `${path}${index > 0 ? `&cursor=${encodeURIComponent(previous!.nextCursor!)}` : ""}`;
      return ["my-review-pages", owner, page] as const;
    },
    ([, requestOwner, page]: readonly [string, string, string]) => runOwned(requestOwner, async (scopedToken, signal, assertCurrent) => {
      const data = await apiCall<MyReviewPage<T>>(scopedToken, page, { signal });
      assertCurrent();
      return data;
    }),
    { fallbackData: fallback, keepPreviousData: false,
      revalidateOnMount: !initial, revalidateOnFocus: true },
  );
  const pages = enabled && owner ? result.data : undefined;
  const last = pages?.at(-1);
  return { ...result, data: pages, items: pages?.flatMap((page) => page.items) ?? [],
    hasMore: Boolean(last?.nextCursor), loadingMore: result.isValidating && Boolean(pages?.length),
    loadMore: () => result.error ? result.mutate() : result.setSize(result.size + 1) };
}
