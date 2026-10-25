"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useLocalStorageState } from "@/lib/useLocalStorageState";

export type SortDir = "asc" | "desc";
/** Full-row comparators return final order; null picked values remain last. */
export type SortComparators = Readonly<Record<string, (a: unknown, b: unknown, dir: SortDir) => number>>;

export type SortState = {
  sortBy: string;
  sortDir: SortDir;
  setSort: (col: string) => void;
  /**
   * Deterministically set both the sort column and direction. Used by
   * controls that own their own direction UI (e.g. a win-rate
   * high→low / low→high toggle) where the click-to-flip semantics of
   * ``setSort`` would be ambiguous.
   * Persistent sorts accept ``persist: false`` for passive URL restoration.
   */
  setSortExplicit: (col: string, dir: SortDir, options?: { persist?: boolean }) => void;
  sortRows: <T>(rows: T[], pick: (row: T, col: string) => unknown) => T[];
};

export function useSort(initialCol: string, initialDir: SortDir = "desc", comparators?: SortComparators): SortState {
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
        if (comparators?.[sortBy]) return comparators[sortBy](a, b, sortDir);
        if (av < bv) return sortDir === "asc" ? -1 : 1;
        if (av > bv) return sortDir === "asc" ? 1 : -1;
        return 0;
      });
      return copy;
    },
    [sortBy, sortDir, comparators],
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
 * in an effect after mount. Only returned explicit handlers persist;
 * hydration and passive URL synchronization must not overwrite a choice.
 */
export function usePersistentSort(
  key: string,
  initialCol: string,
  initialDir: SortDir = "desc",
  comparators?: SortComparators,
  options?: { preferInitial?: boolean },
): SortState {
  const sort = useSort(initialCol, initialDir, comparators);
  const preferInitial = options?.preferInitial === true;
  const { setSortExplicit: applySort } = sort;
  const [stored, setStored] = useLocalStorageState<PersistedSort>(
    key,
    { sortBy: initialCol, sortDir: initialDir },
    isPersistedSort,
  );
  const latest = useRef({ key, sortBy: sort.sortBy, sortDir: sort.sortDir });
  latest.current = { key, sortBy: sort.sortBy, sortDir: sort.sortDir };

  // Apply the hydrated preference once it arrives (and whenever it
  // changes); ``setSortExplicit`` no-ops when the live sort already
  // agrees, so there's no render churn after the values converge.
  useEffect(() => {
    if (!preferInitial) {
      latest.current = { key, sortBy: stored.sortBy, sortDir: stored.sortDir };
      applySort(stored.sortBy, stored.sortDir);
    }
  }, [key, stored, applySort, preferInitial]);

  const setSortExplicit = useCallback((col: string, dir: SortDir, update?: { persist?: boolean }) => {
    if (latest.current.key !== key) return;
    latest.current = { key, sortBy: col, sortDir: dir };
    applySort(col, dir);
    if (update?.persist !== false) setStored({ sortBy: col, sortDir: dir });
  }, [key, applySort, setStored]);
  const setSort = useCallback((col: string) => {
    const current = latest.current;
    setSortExplicit(col, current.sortBy === col ? current.sortDir === "asc" ? "desc" : "asc" : "desc");
  }, [setSortExplicit]);

  return { ...sort, setSort, setSortExplicit };
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
