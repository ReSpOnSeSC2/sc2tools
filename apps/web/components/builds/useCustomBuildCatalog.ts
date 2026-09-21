"use client";

import { createContext, createElement, useContext, useEffect, useState, type ReactNode } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall, type ClientApiError } from "@/lib/clientApi";
import { useFilters } from "@/lib/filterContext";

export interface CustomBuildCatalogItem {
  slug: string;
  name: string;
  race: string;
  vsRace?: string;
}

interface CatalogPage {
  items: CustomBuildCatalogItem[];
  nextCursor?: string | null;
}

/** Arcade needs the complete catalog, but never editor rules or replay data. */
export async function fetchCustomBuildCatalog(
  request: (path: string, signal: AbortSignal) => Promise<CatalogPage>,
  signal: AbortSignal,
): Promise<CustomBuildCatalogItem[]> {
  const bySlug = new Map<string, CustomBuildCatalogItem>();
  let cursor: string | null = null;
  const cursors = new Set<string>();
  do {
    signal.throwIfAborted();
    const params = new URLSearchParams({ view: "summary", limit: "100" });
    if (cursor) params.set("cursor", cursor);
    const page = await request(`/v1/custom-builds?${params}`, signal);
    signal.throwIfAborted();
    for (const item of Array.isArray(page.items) ? page.items : []) {
      if (!item.slug) continue;
      bySlug.set(item.slug, {
        slug: item.slug,
        name: item.name,
        race: item.race,
        vsRace: item.vsRace,
      });
    }
    cursor = page.nextCursor || null;
    if (cursor && cursors.has(cursor)) throw new Error("Couldn't finish loading your build catalog. Try again.");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return [...bySlug.values()];
}

interface CatalogState {
  accountKey: string | null;
  revision: number;
  data?: { items: CustomBuildCatalogItem[] };
  error?: ClientApiError;
}

/** One current metadata snapshot; old pages do not accumulate in the SWR cache. */
function useCatalogSnapshot() {
  const { getToken, isLoaded, isSignedIn, userId } = useAuth();
  const { dbRev } = useFilters();
  const accountKey = isLoaded && isSignedIn && userId ? userId : null;
  const [state, setState] = useState<CatalogState>({ accountKey: null, revision: dbRev });
  useEffect(() => {
    if (!accountKey) return;
    const controller = new AbortController();
    fetchCustomBuildCatalog(
      (path, signal) => apiCall<CatalogPage>(getToken, path, { signal }),
      controller.signal,
    ).then(
      (items) => {
        if (!controller.signal.aborted) setState({ accountKey, revision: dbRev, data: { items } });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setState({
          accountKey,
          revision: dbRev,
          error: { status: 0, message: error instanceof Error ? error.message : "Couldn't load your build catalog." },
        });
      },
    );
    return () => controller.abort();
  }, [accountKey, dbRev, getToken]);
  const current = state.accountKey === accountKey && state.revision === dbRev ? state : null;
  return {
    data: accountKey ? current?.data : undefined,
    error: accountKey ? current?.error : undefined,
    isLoading: !isLoaded || (!!accountKey && !current?.data && !current?.error),
  };
}

const CustomBuildCatalogContext = createContext<ReturnType<typeof useCatalogSnapshot> | null>(null);

/** All Arcade surfaces share one walk and snapshot, including newly mounted modes. */
export function CustomBuildCatalogProvider({ children }: { children: ReactNode }) {
  const catalog = useCatalogSnapshot();
  return createElement(CustomBuildCatalogContext.Provider, { value: catalog }, children);
}

export function useCustomBuildCatalog() {
  const catalog = useContext(CustomBuildCatalogContext);
  if (!catalog) throw new Error("Custom build catalog needs its Arcade provider.");
  return catalog;
}
