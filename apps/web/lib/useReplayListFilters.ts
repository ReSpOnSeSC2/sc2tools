"use client";
import { useRef } from "react";
import { useSearchParams } from "next/navigation";
import { useUrlQueryWriter, useUrlState, type QueryPatch } from "./useUrlState";
import { replayBefore, replayCursor, replayMatchup, replayResult, replaySearch, replaySort } from "./replayListNavigation";

const LEGACY = { q: "replaySearch", result: "replayResult", matchup: "replayMatchup", sort: "replaySort" } as const;
/** Canonical section state; legacy backlinks remain readable until an explicit edit. */
export function useReplayListFilters() {
  const params = useSearchParams(), writer = useUrlQueryWriter();
  const q = useUrlState("q", { parse: replaySearch, serialize: value => value || null, defaultValue: "" });
  const result = useUrlState("result", { parse: replayResult, serialize: value => value === "all" ? null : value, defaultValue: "all" as ReturnType<typeof replayResult> });
  const matchup = useUrlState("matchup", { parse: replayMatchup, serialize: value => value === "all" ? null : value, defaultValue: "all" });
  const sort = useUrlState("sort", { parse: replaySort, serialize: value => value === "date_desc" ? null : value, defaultValue: "date_desc" as ReturnType<typeof replaySort> });
  const cursor = useUrlState("cursor", { parse: replayCursor, serialize: value => value, defaultValue: null as string | null });
  const before = useUrlState("before", { parse: replayBefore, serialize: value => value || null, defaultValue: "" });
  const legacy = { q: replaySearch(params?.get(LEGACY.q) ?? null), result: replayResult(params?.get(LEGACY.result) ?? null), matchup: replayMatchup(params?.get(LEGACY.matchup) ?? null), sort: replaySort(params?.get(LEGACY.sort) ?? null) };
  const selected = { search: params?.has("q") || q.source === "draft" ? q.value : legacy.q,
    result: params?.has("result") ? result.value : legacy.result, matchup: params?.has("matchup") ? matchup.value : legacy.matchup, sort: params?.has("sort") ? sort.value : legacy.sort };
  const committed = { search: params?.has("q") ? q.committedValue : legacy.q,
    result: params?.has("result") ? result.committedValue : legacy.result, matchup: params?.has("matchup") ? matchup.committedValue : legacy.matchup,
    sort: params?.has("sort") ? sort.committedValue : legacy.sort, cursor: cursor.committedValue, before: before.committedValue };
  const canonical: Record<"q" | "result" | "matchup" | "sort" | "before", string | null> = { q: committed.search || null, result: committed.result === "all" ? null : committed.result, matchup: committed.matchup === "all" ? null : committed.matchup, sort: committed.sort === "date_desc" ? null : committed.sort, before: committed.before || null };
  const pending = useRef<{ epoch: number; path: string; values: typeof canonical } | null>(null);
  if (pending.current && (pending.current.epoch !== writer.epoch || pending.current.path !== writer.path || Object.entries(canonical).every(([key, value]) => pending.current?.values[key as keyof typeof canonical] === value))) pending.current = null;
  const migration = useRef({ epoch: writer.epoch, path: writer.path, done: false });
  if (migration.current.epoch !== writer.epoch || migration.current.path !== writer.path) migration.current = { epoch: writer.epoch, path: writer.path, done: false };
  function change(patch: QueryPatch, debounceMs = 0, mode: "replace" | "push" = "replace") {
    const compat: QueryPatch = {};
    if (!migration.current.done) {
      for (const [key, alias] of Object.entries(LEGACY)) if (params?.has(alias)) {
        compat[alias] = null;
        if (!params.has(key)) compat[key] = key === "q" ? legacy.q || null : key === "result" ? legacy.result === "all" ? null : legacy.result : key === "matchup" ? legacy.matchup === "all" ? null : legacy.matchup : legacy.sort === "date_desc" ? null : legacy.sort;
      }
      migration.current.done = true;
    }
    // One writer cancels the pending text timer before another control commits.
    const combined: QueryPatch = { ...compat, q: pending.current ? pending.current.values.q : selected.search || null, cursor: null, ...patch };
    const intended = { ...canonical, ...pending.current?.values };
    for (const key of Object.keys(canonical) as Array<keyof typeof canonical>) if (Object.hasOwn(combined, key)) intended[key] = combined[key];
    pending.current = Object.entries(canonical).some(([key, value]) => intended[key as keyof typeof canonical] !== value) ? { epoch: writer.epoch, path: writer.path, values: intended } : null;
    q.setMany(combined, { debounceMs, mode });
  }
  const draft = pending.current?.values;
  return { ...selected, search: draft ? draft.q || "" : selected.search,
    result: draft ? replayResult(draft.result) : selected.result,
    matchup: draft ? replayMatchup(draft.matchup) : selected.matchup,
    sort: draft ? replaySort(draft.sort) : selected.sort,
    before: draft ? replayBefore(draft.before) : before.value, committed, pendingFilters: !!draft,
    setSearch: (value: string) => change({ q: replaySearch(value) || null }, 300),
    setResult: (value: string) => change({ result: replayResult(value) === "all" ? null : replayResult(value) }),
    setMatchup: (value: string) => change({ matchup: replayMatchup(value) === "all" ? null : replayMatchup(value) }),
    setSort: (value: string) => change({ sort: replaySort(value) === "date_desc" ? null : replaySort(value) }),
    setBefore: (value: string) => change({ before: replayBefore(value) || null }),
    setCursor: (value: string | null) => change({ cursor: value }, 0, "push"),
    clearCursor: () => change({ cursor: null }),
    reset: () => change({ q: null, result: null, matchup: null, sort: null, before: null }),
  };
}
