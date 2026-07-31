"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useLocalStorageState } from "@/lib/useLocalStorageState";

export type SortDir = "asc" | "desc";

export type SortState = {
  sortBy: string;
  sortDir: SortDir;
  setSort: (col: string) => void;
  /**
   * Deterministically set both the sort column and direction. Used by
   * controls that own their own direction UI (e.g. a win-rate
   * high→low / low→high toggle) where the click-to-flip semantics of
   * ``setSort`` would be ambiguous.
   */
  setSortExplicit: (col: string, dir: SortDir) => void;
  sortRows: <T>(rows: T[], pick: (row: T, col: string) => unknown) => T[];
};

export function useSort(initialCol: string, initialDir: SortDir = "desc"): SortState {
  const [sortBy, setSortBy] = useState(initialCol);
  const [sortDir, setSortDir] = useState<SortDir>(initialDir);
  const setSort = useCallback(
    (col: string) => {
      if (col === sortBy) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      } else {
        setSortBy(col);
        setSortDir("desc");
      }
    },
    [sortBy],
  );
  const setSortExplicit = useCallback((col: string, dir: SortDir) => {
    setSortBy(col);
    setSortDir(dir);
  }, []);
  const sortRows = useCallback(
    <T,>(rows: T[], pick: (row: T, col: string) => unknown): T[] => {
      const copy = [...rows];
      copy.sort((a, b) => {
        const av = pick(a, sortBy);
        const bv = pick(b, sortBy);
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        if (av < bv) return sortDir === "asc" ? -1 : 1;
        if (av > bv) return sortDir === "asc" ? 1 : -1;
        return 0;
      });
      return copy;
    },
    [sortBy, sortDir],
  );
  return { sortBy, sortDir, setSort, setSortExplicit, sortRows };
}

type PersistedSort = { sortBy: string; sortDir: SortDir };

function isPersistedSort(raw: unknown): raw is PersistedSort {
  if (!raw || typeof raw !== "object") return false;
  const r = raw as Record<string, unknown>;
  return (
    typeof r.sortBy === "string" &&
    (r.sortDir === "asc" || r.sortDir === "desc")
  );
}

/**
 * ``useSort`` whose column + direction survive reloads via
 * localStorage. SSR-safe: both the in-memory sort and the persisted
 * store start at the same ``initial`` values, so the first client
 * render matches the server render; the stored preference is applied
 * in an effect after mount. The two effects settle on the first pass
 * (the sync effect no-ops once the values already agree), so there's
 * no render loop.
 */
export function usePersistentSort(
  key: string,
  initialCol: string,
  initialDir: SortDir = "desc",
): SortState {
  const sort = useSort(initialCol, initialDir);
  const { setSortExplicit } = sort;
  const [stored, setStored] = useLocalStorageState<PersistedSort>(
    key,
    { sortBy: initialCol, sortDir: initialDir },
    isPersistedSort,
  );

  // Apply the hydrated preference once it arrives (and whenever it
  // changes); ``setSortExplicit`` no-ops when the live sort already
  // agrees, so there's no render churn after the values converge.
  useEffect(() => {
    setSortExplicit(stored.sortBy, stored.sortDir);
  }, [stored, setSortExplicit]);

  // Persist every change the user makes through the table headers or a
  // direction toggle. The first run is skipped so the pre-hydration
  // default doesn't overwrite a stored preference before the read
  // effect above has applied it.
  const persistGuard = useRef(false);
  useEffect(() => {
    if (!persistGuard.current) {
      persistGuard.current = true;
      return;
    }
    setStored({ sortBy: sort.sortBy, sortDir: sort.sortDir });
  }, [sort.sortBy, sort.sortDir, setStored]);

  return sort;
}

export function SortableTh({
  col,
  label,
  sortBy,
  sortDir,
  setSort,
  align = "left",
  width,
  title,
  compact = false,
}: {
  col: string;
  label: string;
  sortBy: string;
  sortDir: SortDir;
  setSort: (col: string) => void;
  align?: "left" | "right";
  width?: string;
  /** Optional hover tooltip clarifying what the column means. */
  title?: string;
  /** Use tighter table-cell padding for dense, horizontally scrollable tables. */
  compact?: boolean;
}) {
  const active = sortBy === col;
  const arrow = active ? (sortDir === "asc" ? "↑" : "↓") : "";
  return (
    <th
      aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
      className="p-0"
      style={width ? { width } : undefined}
    >
      <button
        type="button"
        onClick={() => setSort(col)}
        title={title}
        className={`flex w-full items-center gap-1 text-micro uppercase tracking-wider hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent ${
          compact ? "px-2 py-1.5" : "px-3 py-2"
        } ${
          align === "right" ? "justify-end text-right" : "justify-start text-left"
        } ${active ? "text-text" : "text-text-muted"}`}
      >
        <span>{label}</span>
        {arrow ? <span aria-hidden>{arrow}</span> : null}
      </button>
    </th>
  );
}
