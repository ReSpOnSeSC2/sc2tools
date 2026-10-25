"use client";

import { createContext, createElement, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { safeGameSource, type GameSource } from "./gameNavigation";
import { gameSourceFilters } from "./gameSourceFilters";
import { filtersToQuery, useFilters } from "./filterContext";

const SourceContext = createContext<{ label?: string; filters?: string; replace?: boolean }>({});

/** A modal or build dossier can supply the exact cohort behind its displayed rows. */
export function GameSourceProvider({ label, filters, replace = false, children }: {
  label?: string; filters?: string; replace?: boolean; children: ReactNode;
}) {
  const parent = useContext(SourceContext);
  const value = useMemo(() => ({ label: label ?? parent.label, replace: replace || parent.replace,
    filters: gameSourceFilters(replace ? undefined : parent.filters, filters) }), [label, filters, replace, parent]);
  return createElement(SourceContext.Provider, { value }, children);
}

function subscribe(onChange: () => void) {
  window.addEventListener("popstate", onChange);
  window.addEventListener("hashchange", onChange);
  return () => { window.removeEventListener("popstate", onChange); window.removeEventListener("hashchange", onChange); };
}
const readSource = () => `${window.location.pathname}${window.location.search}${window.location.hash}`;
const serverSource = () => "";

/** Hydration-safe source, refreshed on history changes and list rerenders. */
export function useGameSource(label?: string, query?: string): GameSource | null {
  const href = useSyncExternalStore(subscribe, readSource, serverSource);
  const { filters } = useFilters();
  const context = useContext(SourceContext);
  const analyzerSection = href.startsWith("/app/") || /[?&]tab=(?!today(?:&|$))/.test(href);
  const globalQuery = analyzerSection && !context.replace ? filtersToQuery(filters) : undefined;
  return useMemo(() => {
    const source = safeGameSource(href, label ?? context.label);
    return source ? { ...source, filters: gameSourceFilters(new URL(href, "https://sc2tools.invalid").search, globalQuery, context.filters, query) } : null;
  }, [href, label, globalQuery, context, query]);
}
