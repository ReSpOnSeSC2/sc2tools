"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { SWRConfiguration } from "swr";
import { useApi, type ClientApiError } from "@/lib/clientApi";
import { GLOBAL_TRENDS_REQUEST_OPTIONS, GLOBAL_TRENDS_SWR_CONFIG } from "./globalTrendsApi";

export type TrendsCohort = Record<
  string,
  string | number | boolean | readonly string[] | null | undefined
>;

type TrendsDataScope = {
  mode: "personal" | "global";
  cohort: TrendsCohort;
};

const TrendsDataContext = createContext<TrendsDataScope>({
  mode: "personal",
  cohort: {},
});

/** An explicit data boundary shared by every trends chart and its drilldowns. */
export function TrendsDataProvider({
  mode = "personal",
  cohort = {},
  children,
}: Partial<TrendsDataScope> & { children: ReactNode }) {
  const value = useMemo(() => ({ mode, cohort }), [mode, cohort]);
  return <TrendsDataContext.Provider value={value}>{children}</TrendsDataContext.Provider>;
}

export function useTrendsDataScope() {
  const scope = useContext(TrendsDataContext);
  return { ...scope, isGlobal: scope.mode === "global" };
}

/** Preserve chart filters and revision identity while applying the cohort last. */
export function trendsDataPath(path: string | null, scope: TrendsDataScope): string | null {
  if (!path || scope.mode !== "global") return path;
  const hashIndex = path.indexOf("#");
  const hash = hashIndex < 0 ? "" : path.slice(hashIndex);
  const resource = hashIndex < 0 ? path : path.slice(0, hashIndex);
  const queryIndex = resource.indexOf("?");
  const pathname = queryIndex < 0 ? resource : resource.slice(0, queryIndex);
  const params = new URLSearchParams(queryIndex < 0 ? "" : resource.slice(queryIndex + 1));
  for (const [key, value] of Object.entries(scope.cohort)) {
    if (value == null || value === "") continue;
    params.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  const globalPath = pathname.startsWith("/v1/admin/global-trends/")
    ? pathname
    : pathname.replace(/^\/v1(?=\/|$)/, "/v1/admin/global-trends");
  const query = params.toString();
  return `${globalPath}${query ? `?${query}` : ""}${hash}`;
}

/** Both SWR fetching and its imperative `request` helper retain this scope. */
export function useTrendsApi<T>(
  path: string | null,
  config?: SWRConfiguration<T, ClientApiError>,
) {
  const scope = useContext(TrendsDataContext);
  return useApi<T>(trendsDataPath(path, scope),
    scope.mode === "global" ? { ...GLOBAL_TRENDS_SWR_CONFIG, ...config } : config,
    scope.mode === "global" ? GLOBAL_TRENDS_REQUEST_OPTIONS : undefined);
}
