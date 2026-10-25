"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useDebouncedValue } from "@/lib/useDebouncedValue";
import { usePersistentSort } from "@/components/ui/SortableTh";
import type { SortState } from "@/components/ui/SortableTh";
import { OPPONENT_COMPARATORS } from "./opponentListSort";

export type MmrImpactFilter = "all" | "tracked" | "net-gain" | "net-loss";
export type OpponentListLocation = {
  pathname: string;
  query: string;
  replace: (href: string) => void;
  prefetch: (href: string) => void;
  navigate: (href: string) => void;
  queryForReturn?: () => string;
};
export const OPPONENT_SORTS = new Set(["name", "race", "pulseId", "wins", "losses", "winRate", "games", "mmr", "netMmr", "mmrWon", "mmrLost", "lastPlayed"]);
export function readOpponentListQuery(query: string) {
  const params = new URLSearchParams(query);
  const impact = params.get("impact");
  const [column, direction] = (params.get("sort") || "").split(":");
  return {
    q: (params.get("q") || "").slice(0, 200).replace(/[\u0000-\u001f\u007f]/g, ""),
    sort: OPPONENT_SORTS.has(column) ? column : "lastPlayed",
    dir: (direction || params.get("dir")) === "asc" ? "asc" as const : "desc" as const,
    impact: (["tracked", "net-gain", "net-loss"].includes(impact || "") ? impact : "all") as MmrImpactFilter,
    notes: params.get("notes") === "1",
  };
}
type Query = ReturnType<typeof readOpponentListQuery>;
export function writeOpponentListQuery(query: string, state: Query) {
  const params = new URLSearchParams(query);
  const values = { q: state.q || null, sort: state.sort === "lastPlayed" && state.dir === "desc" ? null : `${state.sort}:${state.dir}`, dir: null, impact: state.impact === "all" ? null : state.impact, notes: state.notes ? "1" : null };
  for (const [key, value] of Object.entries(values)) { if (value === null) params.delete(key); else params.set(key, value); }
  return params.toString();
}
export type OpponentListSnapshot = { listUrl: string; scrollY: number; renderWindow: number; expandedGroups: string[] };
export function storedOpponentListUrl() {
  try {
    const stored = JSON.parse(sessionStorage.getItem("opponents:list-state") || "null");
    const url = new URL(stored?.listUrl || "/app/opponents", window.location.origin);
    if (url.origin === window.location.origin && url.pathname === "/app/opponents") return `${url.pathname}${url.search}`;
  } catch { /* A malformed or unavailable entry falls back to the list. */ }
  return "/app/opponents";
}

export type OpponentListControls = { search: string; setSearch: (value: string) => void; impact: MmrImpactFilter; setImpact: (value: MmrImpactFilter) => void; hasNotes: boolean; setHasNotes: (value: boolean) => void; sort: SortState };
export function useOpponentListNavigation(location?: OpponentListLocation, controls?: OpponentListControls) {
  const initial = useRef(readOpponentListQuery(location?.query || "")).current;
  const [localSearch, setLocalSearch] = useState(initial.q);
  const [localImpact, setLocalImpact] = useState(initial.impact);
  const [localNotes, setLocalNotes] = useState(initial.notes);
  const search = controls?.search ?? localSearch, setSearch = controls?.setSearch ?? setLocalSearch;
  const impact = controls?.impact ?? localImpact, setImpact = controls?.setImpact ?? setLocalImpact;
  const hasNotes = controls?.hasNotes ?? localNotes, setHasNotes = controls?.setHasNotes ?? setLocalNotes;
  const explicitSort = useRef(new URLSearchParams(location?.query).has("sort") || new URLSearchParams(location?.query).has("dir")).current;
  const localSort = usePersistentSort("analyzer.opponents.sort", initial.sort, initial.dir, OPPONENT_COMPARATORS, { preferInitial: explicitSort || !!controls });
  const sort = controls?.sort ?? localSort;
  const debouncedSearch = useDebouncedValue(search, 300);
  const observed = useRef(location?.query);
  const written = useRef<string | null>(null);
  const applying = useRef<string | null>(null);
  const current = { q: search, sort: sort.sortBy, dir: sort.sortDir, impact, notes: hasNotes };
  const currentRef = useRef(current); currentRef.current = current;
  const locationRef = useRef(location); locationRef.current = location;
  const { setSortExplicit } = sort;
  useEffect(() => {
    if (controls || !location || location.query === observed.current) return;
    observed.current = location.query;
    if (location.query === written.current) { written.current = null; return; }
    const next = readOpponentListQuery(location.query);
    applying.current = JSON.stringify(next);
    setSearch(next.q); setImpact(next.impact); setHasNotes(next.notes); setSortExplicit(next.sort, next.dir);
  }, [location, controls, setSearch, setImpact, setHasNotes, setSortExplicit]);
  useEffect(() => {
    if (controls || !location) return;
    const settled = { q: debouncedSearch, sort: sort.sortBy, dir: sort.sortDir, impact, notes: hasNotes };
    if (applying.current) { if (JSON.stringify(settled) === applying.current) applying.current = null; return; }
    if (JSON.stringify(settled) === JSON.stringify(readOpponentListQuery(location.query))) return;
    const query = writeOpponentListQuery(location.query, settled);
    if (query === location.query || query === written.current) return;
    written.current = query;
    location.replace(`${location.pathname}${query ? `?${query}` : ""}`);
  }, [location, controls, debouncedSearch, sort.sortBy, sort.sortDir, impact, hasNotes]);

  const remember = useCallback((state: Pick<OpponentListSnapshot, "renderWindow" | "expandedGroups">) => {
    const route = locationRef.current;
    const query = writeOpponentListQuery(route?.queryForReturn?.() ?? route?.query ?? "", currentRef.current);
    const listUrl = `${route?.pathname || "/app/opponents"}${query ? `?${query}` : ""}`;
    try {
      // Flush a search still inside its debounce before leaving this history
      // entry, so browser Back and the saved scroll window refer to one URL.
      if (route && `${window.location.pathname}${window.location.search}` !== listUrl) window.history.replaceState(window.history.state, "", listUrl);
      sessionStorage.setItem("opponents:list-state", JSON.stringify({ ...state, listUrl, scrollY: window.scrollY }));
      sessionStorage.setItem("opponents:from-list", "1");
    } catch { /* Navigation still works when storage is blocked. */ }
  }, []);
  return { search, setSearch, impact, setImpact, hasNotes, setHasNotes, sort, remember };
}
