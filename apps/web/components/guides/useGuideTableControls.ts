"use client";

import { useMemo, useState } from "react";
import { useSort, type SortComparators, type SortDir } from "@/components/ui/SortableTh";

export interface GuideTableSort<T> {
  label: string;
  pick: (row: T) => string | number | null | undefined;
  compare?: (a: T, b: T, direction: SortDir) => number;
}

export function normalizeGuideSearch(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("en-US").trim();
}

/** A null default keeps the exact server ranking until the reader chooses a sort. */
export function useGuideTableControls<T>(rows: ReadonlyArray<T>, options: {
  sorts: Readonly<Record<string, GuideTableSort<T>>>;
  defaultSort: { by: string; direction: SortDir } | null;
  filterText?: string;
  filterFn: (row: T, normalizedQuery: string) => boolean;
}) {
  const [query, setQuery] = useState(options.filterText ?? "");
  const comparators = useMemo<SortComparators>(() => Object.fromEntries(
    Object.entries(options.sorts).filter(([, sort]) => sort.compare).map(([key, sort]) => [key,
      (a: unknown, b: unknown, direction: SortDir) => sort.compare!(a as T, b as T, direction),
    ]),
  ), [options.sorts]);
  const sort = useSort(options.defaultSort?.by ?? "", options.defaultSort?.direction ?? "desc", comparators);
  const filtered = rows.filter((row) => options.filterFn(row, normalizeGuideSearch(query)));
  const visibleRows = sort.sortBy ? sort.sortRows(filtered, (row, key) => options.sorts[key]?.pick(row)) : filtered;
  const { sortBy, sortDir, setSort, setSortExplicit } = sort;
  return { visibleRows, sortProps: { sortBy, sortDir, setSort }, setSortExplicit, query, setQuery, count: visibleRows.length };
}
