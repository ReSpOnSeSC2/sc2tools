"use client";

import { useState, useCallback } from "react";

export type SortDir = "asc" | "desc";

export type SortState = {
  sortBy: string;
  sortDir: SortDir;
  setSort: (col: string) => void;
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
  return { sortBy, sortDir, setSort, sortRows };
}

export function SortableTh({
  col,
  label,
  sortBy,
  sortDir,
  setSort,
  align = "left",
  width,
}: {
  col: string;
  label: string;
  sortBy: string;
  sortDir: SortDir;
  setSort: (col: string) => void;
  align?: "left" | "right";
  width?: string;
}) {
  const active = sortBy === col;
  const arrow = active ? (sortDir === "asc" ? "↑" : "↓") : "";
  return (
    <th
      onClick={() => setSort(col)}
      className={`cursor-pointer px-3 py-2 text-${align} text-[11px] uppercase tracking-wider hover:text-text ${
        active ? "text-text" : "text-text-muted"
      }`}
      style={width ? { width } : undefined}
    >
      <span className="select-none">
        {label} {arrow}
      </span>
    </th>
  );
}
