"use client";

import { useState, useCallback, useMemo, type ReactNode } from "react";
import {
  FiltersContext,
  type AnalyzerFilters,
} from "@/lib/filterContext";

/**
 * Wraps the analyzer pages with shared filter state + a `dbRev`
 * counter that downstream useApi hooks include in their cache key so
 * they re-fetch when the user clicks Refresh.
 */
export function AnalyzerProvider({ children }: { children: ReactNode }) {
  const [filters, setFilters] = useState<AnalyzerFilters>({});
  const [dbRev, setDbRev] = useState(0);
  const bumpRev = useCallback(() => setDbRev((v) => v + 1), []);
  const value = useMemo(
    () => ({ filters, setFilters, dbRev, bumpRev }),
    [filters, dbRev, bumpRev],
  );
  return (
    <FiltersContext.Provider value={value}>{children}</FiltersContext.Provider>
  );
}
