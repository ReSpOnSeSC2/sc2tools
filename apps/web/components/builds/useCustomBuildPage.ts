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
  /** Every tag in the library with its build count (full views only). */
  availableTags?: Array<{ tag: string; count: number }>;
}

export interface CustomBuildQuery {
  search?: string;
  nameSearch?: string;
  matchup?: string;
  sort?: "updated" | "name" | "winRate" | "games" | "lastPlayed";
  hideEmpty?: boolean;
  view?: "summary";
  includeGeneric?: boolean;
  /** Your own builds ("you") or opponent captures ("opponent"). */
  perspective?: "you" | "opponent";
  published?: boolean;
  /** The build's own race letter. */
  race?: "P" | "T" | "Z";
  /** Builds carrying every one of these tags. */
  tags?: string[];
}

function restoredCursors(query: string): string[] {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(`builds:cursors:${query}`) || "[]");
    return Array.isArray(value) && value.length <= 100 && value.every((cursor) => typeof cursor === "string" && cursor.length <= 2048) ? value : [];
  } catch { return []; }
}

/** Keep one page of definitions on screen; cursors never contain build data. */
export function useCustomBuildPage(query: CustomBuildQuery = {}) {
  const { userId } = useAuth();
  const params = new URLSearchParams();
  if (query.search?.trim()) params.set("search", query.search.trim());
  if (query.nameSearch?.trim()) params.set("nameSearch", query.nameSearch.trim());
  if (query.matchup && query.matchup !== "All") params.set("matchup", query.matchup);
  if (query.sort && query.sort !== "updated") params.set("sort", query.sort);
  if (query.hideEmpty) params.set("hideEmpty", "true");
  if (query.view) params.set("view", query.view);
  if (query.includeGeneric) params.set("includeGeneric", "true");
  if (query.perspective) params.set("perspective", query.perspective);
  if (query.published) params.set("published", "true");
  if (query.race) params.set("race", query.race);
  if (query.tags?.length) params.set("tags", query.tags.join(","));
  const queryKey = `${userId ?? ""}:${params.toString()}`;
  const [navigation, setNavigation] = useState<{ query: string; cursors: string[] }>({ query: queryKey, cursors: restoredCursors(queryKey) });
  useEffect(() => {
    setNavigation((current) => current.query === queryKey ? current : { query: queryKey, cursors: restoredCursors(queryKey) });
  }, [queryKey]);
  useEffect(() => {
    if (navigation.query !== queryKey) return;
    try { sessionStorage.setItem(`builds:cursors:${queryKey}`, JSON.stringify(navigation.cursors)); } catch { /* Storage is optional. */ }
  }, [navigation, queryKey]);
  // A changed filter always starts at the beginning, including the render
  // before effects run. Never request the new filter with an old cursor.
  const cursors = navigation.query === queryKey ? navigation.cursors : restoredCursors(queryKey);
  const cursor = cursors.at(-1);
  if (cursor) params.set("cursor", cursor);
  const search = params.toString();
  const path = `/v1/custom-builds${search ? `?${search}` : ""}`;
  const resource = useApi<CustomBuildPage>(path, { keepPreviousData: true, dedupingInterval: 0 });
  useEffect(() => {
    if (cursor && resource.error?.status === 400 && resource.error.code === "invalid_custom_build_page") {
      try { sessionStorage.removeItem(`builds:cursors:${queryKey}`); } catch { /* Storage is optional. */ }
      setNavigation({ query: queryKey, cursors: [] });
    }
  }, [cursor, queryKey, resource.error]);
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
    pageNumber, pageSize,
    pageStart: (pageNumber - 1) * pageSize,
    hasPrevious: cursors.length > 0,
    hasNext: !!resource.data?.nextCursor,
    nextPage,
    previousPage,
    resetPage,
  };
}
