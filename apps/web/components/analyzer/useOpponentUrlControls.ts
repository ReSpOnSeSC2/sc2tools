"use client";
import { useLayoutEffect, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { useSort, type SortState } from "@/components/ui/SortableTh";
import { useUrlState } from "@/lib/useUrlState";
import { OPPONENT_COMPARATORS } from "./opponentListSort";
import { OPPONENT_SORTS, type MmrImpactFilter, type OpponentListControls } from "./useOpponentListNavigation";
const searchOptions = { defaultValue: "", parse: (raw: string | null) => raw && raw.length <= 200 && !/[\u0000-\u001f\u007f]/.test(raw) ? raw : "", serialize: (value: string) => value || null };
const impactOptions = { defaultValue: "all" as MmrImpactFilter, parse: (raw: string | null): MmrImpactFilter => ["tracked", "net-gain", "net-loss"].includes(raw || "") ? raw as MmrImpactFilter : "all", serialize: (value: MmrImpactFilter) => value === "all" ? null : value };
type Pair = { sortBy: string; sortDir: "asc" | "desc" };
const DEFAULT: Pair = { sortBy: "lastPlayed", sortDir: "desc" };
function pair(raw: unknown, legacyDir: string | null): Pair {
  if (raw && typeof raw === "object" && "sortBy" in raw && "sortDir" in raw && OPPONENT_SORTS.has(String(raw.sortBy)) && ["asc", "desc"].includes(String(raw.sortDir))) return { sortBy: String(raw.sortBy), sortDir: raw.sortDir as Pair["sortDir"] };
  const [column, direction] = typeof raw === "string" ? raw.split(":") : [];
  return { sortBy: OPPONENT_SORTS.has(column) ? column : "lastPlayed", sortDir: (direction || legacyDir) === "asc" ? "asc" : "desc" };
}
export function useOpponentUrlControls(): OpponentListControls {
  const legacyDir = useSearchParams()?.get("dir") ?? null;
  const search = useUrlState("q", searchOptions), impact = useUrlState("impact", impactOptions);
  const notes = useUrlState("notes", { defaultValue: false, parse: raw => raw === "1", serialize: value => value ? "1" : null });
  const selected = useUrlState<Pair>("sort", { defaultValue: legacyDir ? pair(null, legacyDir) : DEFAULT,
    storageKey: legacyDir ? undefined : "analyzer.opponents.sort", parse: raw => pair(raw, legacyDir),
    serialize: value => `${value.sortBy}:${value.sortDir}`, store: value => value });
  const base = useSort(selected.value.sortBy, selected.value.sortDir, OPPONENT_COMPARATORS);
  const { setSortExplicit } = base;
  useLayoutEffect(() => { setSortExplicit(selected.value.sortBy, selected.value.sortDir); }, [setSortExplicit, selected.value.sortBy, selected.value.sortDir]);
  const sort = useMemo<SortState>(() => ({ ...base, sortBy: selected.value.sortBy, sortDir: selected.value.sortDir,
    setSort: column => selected.setMany({ sort: `${column}:${column === selected.value.sortBy && selected.value.sortDir === "desc" ? "asc" : "desc"}`, dir: null }),
    setSortExplicit: (column, direction) => selected.setMany({ sort: `${column}:${direction}`, dir: null }),
  }), [base, selected]);
  return { search: search.value, setSearch: search.setValue, impact: impact.value, setImpact: impact.setValue, hasNotes: notes.value, setHasNotes: notes.setValue, sort };
}
