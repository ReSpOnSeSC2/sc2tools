"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { VIEW_FILTER_KEYS, VIEW_QUERY_MARKER } from "./analyzerViews";
import { SECTION_QUERY_KEYS } from "./sectionQueryKeys";
export { SECTION_QUERY_KEYS } from "./sectionQueryKeys";
import { browserQueryLocation, type QueryWriteGuard } from "./urlQueryNavigation";
import { useUrlQueryWriter, type UrlHistoryMode, type SectionHistoryState } from "./useUrlQueryWriter";
export { useUrlQueryWriter } from "./useUrlQueryWriter";
export type { UrlHistoryMode } from "./useUrlQueryWriter";

export type QueryPatch = Record<string, string | null>;
const legacyReplayKeys = new Set(["replaySearch", "replayResult", "replayMatchup", "replaySort", "dir"]);
const globalKeys = new Set([...VIEW_FILTER_KEYS, VIEW_QUERY_MARKER]);
export function sectionQueryKey(key: string) {
  return (SECTION_QUERY_KEYS as readonly string[]).includes(key) && !globalKeys.has(key);
}


export type UrlStateOptions<T> = {
  parse: (raw: string | null) => T; serialize: (value: T) => string | null;
  defaultValue: T; mode?: UrlHistoryMode; storageKey?: string; store?: (value: T) => unknown; debounceMs?: number;
};
type WriteSettings = { mode?: UrlHistoryMode; debounceMs?: number; historyState?: SectionHistoryState };

/** URL first, validated device preference second, default last. Text q writes
 * debounce300ms; callers use committedValue for request/pagination coherence
 * while value gives inputs their immediate draft. setMany clears cursor and
 * updates filters in the same navigation. */
export function useUrlState<T>(key: string, options: UrlStateOptions<T>) {
  if (!sectionQueryKey(key)) throw new Error(`Invalid section query key: ${key}`);
  const writer = useUrlQueryWriter();
  const { capture, update, epoch } = writer;
  const latest = useRef(options); latest.current = options;
  const [fallback, setFallback] = useState(options.defaultValue);
  const [draft, setDraft] = useState<{ value: T; epoch: number; path: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<{ patch: QueryPatch; guard: QueryWriteGuard | null } | null>(null);
  const parse = (raw: string | null) => { try { return options.parse(raw); } catch { return options.defaultValue; } };
  const params = new URLSearchParams(writer.search), values = params.getAll(key);
  const committedValue = values.length ? parse(values.length === 1 ? values[0] : null) : fallback;
  const hasDraft = draft?.epoch === writer.epoch && draft.path === writer.path;
  const value = hasDraft ? draft.value : committedValue;
  const serialized = options.serialize(committedValue), draftSerialized = hasDraft ? options.serialize(draft.value) : null;
  useEffect(() => {
    const current = latest.current;
    if (!current.storageKey) return;
    try { const raw = localStorage.getItem(current.storageKey); if (raw !== null) setFallback(current.parse(JSON.parse(raw))); } catch { /* Device preference is optional. */ }
  }, [options.storageKey]);
  useEffect(() => {
    if (hasDraft && serialized === draftSerialized) setDraft(null);
  }, [hasDraft, serialized, draftSerialized]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); pending.current = null; }, [writer.path, writer.epoch]);
  const setMany = useCallback((patch: QueryPatch, settings: WriteSettings = {}) => {
    if (Object.entries(patch).some(([name, raw]) => !sectionQueryKey(name) && !(legacyReplayKeys.has(name) && raw === null))) throw new Error("Section query patches cannot change global filters.");
    const current = latest.current, live = browserQueryLocation(); if (!live) return;
    const guard = capture();
    if (Object.hasOwn(patch, key)) {
      let next: T; try { next = current.parse(patch[key]); } catch { next = current.defaultValue; }
      setDraft({ value: next, epoch: guard?.epoch ?? epoch, path: live.path });
      if (current.storageKey) { setFallback(next); try { localStorage.setItem(current.storageKey, JSON.stringify(current.store ? current.store(next) : current.serialize(next))); } catch { /* Optional persistence. */ } }
    }
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const prior = pending.current;
    const intent = { patch: { ...(prior && prior.guard?.epoch === guard?.epoch && prior.guard?.path === guard?.path ? prior.patch : {}), ...patch }, guard };
    pending.current = intent;
    const write = () => {
      if (pending.current !== intent) return;
      pending.current = null;
      return update(params => {
      for (const [name, raw] of Object.entries(intent.patch)) {
        const normalized = name === key && raw === current.serialize(current.defaultValue) ? null : raw;
        if (normalized === null || normalized === "") params.delete(name); else params.set(name, normalized);
      }
      return params;
    }, settings.mode ?? current.mode ?? "replace", guard, settings.historyState);
    };
    const delay = settings.debounceMs ?? current.debounceMs ?? (Object.hasOwn(patch, "q") ? 300 : 0);
    if (delay > 0) timer.current = setTimeout(() => { timer.current = null; write(); }, delay); else write();
  }, [key, capture, update, epoch]);
  const setValue = useCallback((next: T, settings?: WriteSettings) => setMany({ [key]: latest.current.serialize(next) }, settings), [key, setMany]);
  return { value, committedValue, setValue, setMany, source: hasDraft ? "draft" : values.length ? "url" : options.storageKey ? "storage" : "default" };
}
