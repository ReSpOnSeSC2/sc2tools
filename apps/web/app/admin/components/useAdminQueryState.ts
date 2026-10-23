"use client";

import { useCallback, useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

type Values = Record<string, string | number | boolean>;
type QueryState<T> = { [K in keyof T]: T[K] extends boolean ? boolean : T[K] extends number ? number : string };
type Options<T> = { allowed?: Partial<Record<keyof T, readonly (string | number | boolean)[]>>; debounceMs?: Partial<Record<keyof T, number>> };

export function coerceAdminQuery<T extends Values>(defaults: T, params: URLSearchParams, allowed: Options<T>["allowed"] = {}): QueryState<T> {
  return Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => {
    const raw = params.get(key);
    let value: string | number | boolean = fallback;
    if (raw !== null) {
      if (typeof fallback === "boolean") value = ["1", "true"].includes(raw) ? true : ["0", "false"].includes(raw) ? false : fallback;
      else if (typeof fallback === "number") value = raw.trim() && Number.isFinite(Number(raw)) && Number(raw) >= 0 ? Number.isInteger(fallback) ? Math.trunc(Number(raw)) : Number(raw) : fallback;
      else value = raw;
    }
    return [key, allowed[key]?.includes(value) === false ? fallback : value];
  })) as QueryState<T>;
}

/** Read at the timer boundary too: Back can precede React's navigation effects. */
export function adminBrowserLocation() {
  if (typeof window === "undefined") return null;
  const path = window.location.pathname, search = new URLSearchParams(window.location.search).toString();
  return { path, search, key: `${path}${search ? `?${search}` : ""}` };
}
function clearTimers(timers: Map<string, ReturnType<typeof setTimeout>>) { for (const timer of timers.values()) clearTimeout(timer); timers.clear(); }

/** URL reads synchronize during render; owned acknowledgements may lag newer input. */
export function useAdminQueryState<T extends Values>(defaults: T, options: Options<T> = {}): [QueryState<T>, (patch: Partial<QueryState<T>>, options?: { history?: "replace" | "push" }) => void] {
  const router = useRouter(), pathname = usePathname(), search = useSearchParams().toString(), key = `${pathname}${search ? `?${search}` : ""}`;
  const latest = useRef({ defaults, options, router }); latest.current = { defaults, options, router };
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const nav = useRef({ key, expected: key, path: pathname, params: new URLSearchParams(search), epoch: 0, pending: new Set<string>(), known: new Set<string>() });
  if (key !== nav.current.key) {
    const owned = nav.current.pending.delete(key);
    if (!owned) { clearTimers(timers.current); nav.current.epoch++; nav.current.pending.clear(); nav.current.expected = key; }
    if (!owned || key === nav.current.expected) { nav.current.params = new URLSearchParams(search); nav.current.path = pathname; }
    nav.current.key = key;
  }
  useEffect(() => {
    const state = nav.current, pending = timers.current;
    const history = () => { const live = adminBrowserLocation(); clearTimers(pending); state.epoch++; state.pending.clear(); state.known.clear(); if (live) { state.params = new URLSearchParams(live.search); state.path = live.path; state.expected = live.key; } };
    window.addEventListener("popstate", history);
    return () => { window.removeEventListener("popstate", history); clearTimers(pending); state.epoch++; };
  }, []);
  const set = useCallback((patch: Partial<QueryState<T>>, settings: { history?: "replace" | "push" } = {}) => {
    const write = (changes: Partial<QueryState<T>>, guard?: { epoch: number; browser: string | undefined }) => {
      const state = nav.current, current = latest.current, live = adminBrowserLocation();
      if (guard && (guard.epoch !== state.epoch || live?.key !== guard.browser && !state.known.has(live?.key || ""))) return;
      const params = new URLSearchParams(state.params), parsed = coerceAdminQuery(current.defaults, params, current.options.allowed);
      const changed = Object.keys(changes).filter(name => changes[name] !== parsed[name]); if (!changed.length) return;
      if (changed.some(name => !["page", "before", "game", "owner"].includes(name))) { params.delete("page"); params.delete("before"); }
      for (const [name, value] of Object.entries(changes)) {
        const valueParsed = coerceAdminQuery(current.defaults, new URLSearchParams([[name, String(value)]]), current.options.allowed)[name];
        if (valueParsed === current.defaults[name]) params.delete(name); else params.set(name, typeof valueParsed === "boolean" ? valueParsed ? "1" : "0" : String(valueParsed));
      }
      state.params = params; state.expected = `${state.path}${params.size ? `?${params}` : ""}`;
      state.pending.add(state.expected); state.known.add(state.expected);
      if (state.known.size > 16) { const oldest = state.known.values().next().value!; state.known.delete(oldest); state.pending.delete(oldest); }
      const history = settings.history || (changed.every(name => ["page", "before"].includes(name)) ? "push" : "replace"); current.router[history](state.expected, { scroll: false });
    };
    const immediate: Partial<QueryState<T>> = {};
    for (const [name, value] of Object.entries(patch)) {
      clearTimeout(timers.current.get(name)); timers.current.delete(name); const delay = latest.current.options.debounceMs?.[name];
      if (delay) { const guard = { epoch: nav.current.epoch, browser: adminBrowserLocation()?.key }; timers.current.set(name, setTimeout(() => { timers.current.delete(name); write({ [name]: value } as Partial<QueryState<T>>, guard); }, delay)); }
      else Object.assign(immediate, { [name]: value });
    }
    write(immediate);
  }, []);
  return [coerceAdminQuery(defaults, new URLSearchParams(search), options.allowed), set];
}
