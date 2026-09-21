"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { useApi } from "@/lib/clientApi";
import type { CustomBuild } from "./types";

export interface CustomBuildPage {
  items: CustomBuild[];
  total?: number | null;
  libraryTotal?: number | null;
  limit?: number | null;
  nextCursor?: string | null;
}

export interface CustomBuildQuery {
  search?: string;
  matchup?: string;
  sort?: "updated" | "name" | "winRate" | "games";
  hideEmpty?: boolean;
  view?: "summary";
  includeGeneric?: boolean;
}

/** Keep one page of definitions on screen; cursors never contain build data. */
export function useCustomBuildPage(query: CustomBuildQuery = {}) {
  const { userId } = useAuth();
  const params = new URLSearchParams();
  if (query.search?.trim()) params.set("search", query.search.trim());
  if (query.matchup && query.matchup !== "All") params.set("matchup", query.matchup);
  if (query.sort && query.sort !== "updated") params.set("sort", query.sort);
  if (query.hideEmpty) params.set("hideEmpty", "true");
  if (query.view) params.set("view", query.view);
  if (query.includeGeneric) params.set("includeGeneric", "true");
  const queryKey = `${userId ?? ""}:${params.toString()}`;
  const [navigation, setNavigation] = useState<{ query: string; cursors: string[] }>({ query: queryKey, cursors: [] });
  useEffect(() => {
    setNavigation((current) => current.query === queryKey ? current : { query: queryKey, cursors: [] });
  }, [queryKey]);
  // A changed filter always starts at the beginning, including the render
  // before effects run. Never request the new filter with an old cursor.
  const cursors = navigation.query === queryKey ? navigation.cursors : [];
  const cursor = cursors.at(-1);
  if (cursor) params.set("cursor", cursor);
  const search = params.toString();
  const path = `/v1/custom-builds${search ? `?${search}` : ""}`;
  const resource = useApi<CustomBuildPage>(path, { keepPreviousData: false, dedupingInterval: 0 });
  const resetPage = useCallback(() => setNavigation({ query: queryKey, cursors: [] }), [queryKey]);
  const nextPage = () => {
    if (resource.data?.nextCursor && !resource.isValidating) {
      setNavigation({ query: queryKey, cursors: [...cursors, resource.data.nextCursor] });
    }
  };
  const previousPage = () => setNavigation({ query: queryKey, cursors: cursors.slice(0, -1) });
  const pageNumber = cursors.length + 1;
  const pageSize = resource.data?.limit ?? 50;
  return {
    ...resource,
    pageNumber,
    pageStart: (pageNumber - 1) * pageSize,
    hasPrevious: cursors.length > 0,
    hasNext: !!resource.data?.nextCursor,
    nextPage,
    previousPage,
    resetPage,
  };
}
