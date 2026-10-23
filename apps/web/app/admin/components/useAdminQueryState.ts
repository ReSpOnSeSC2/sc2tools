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
      else if (typeof fallback === "number") value = raw.trim() && Number.isFinite(Number(raw)) && Number(raw) >= 0 ? Number(raw) : fallback;
      else value = raw;
    }
    return [key, allowed[key]?.includes(value) === false ? fallback : value];
  })) as QueryState<T>;
}

/** URL is authoritative; pending search writes never fire after Back or unmount. */
export function useAdminQueryState<T extends Values>(defaults: T, options: Options<T> = {}): [QueryState<T>, (patch: Partial<QueryState<T>>, options?: { history?: "replace" | "push" }) => void] {
  const router = useRouter(), pathname = usePathname(), search = useSearchParams().toString();
  const latest = useRef({ defaults, options, params: new URLSearchParams(search), pathname, router });
  const expected = useRef(search), timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  latest.current = { ...latest.current, defaults, options, pathname, router };
  useEffect(() => {
    if (search !== expected.current) { for (const timer of timers.current.values()) clearTimeout(timer); timers.current.clear(); }
    expected.current = search; latest.current.params = new URLSearchParams(search);
  }, [search]);
  useEffect(() => { const pending = timers.current; return () => { for (const timer of pending.values()) clearTimeout(timer); }; }, []);
  const set = useCallback((patch: Partial<QueryState<T>>, settings: { history?: "replace" | "push" } = {}) => {
    const write = (changes: Partial<QueryState<T>>) => {
      const current = latest.current, params = new URLSearchParams(current.params);
      const changed = Object.keys(changes).filter(key => changes[key] !== coerceAdminQuery(current.defaults, params, current.options.allowed)[key]);
      if (!changed.length) return;
      if (changed.some(key => !["page", "before", "game", "owner"].includes(key))) { params.delete("page"); params.delete("before"); }
      for (const [key, value] of Object.entries(changes)) {
        const candidate = new URLSearchParams([[key, String(value)]]);
        const parsed = coerceAdminQuery(current.defaults, candidate, current.options.allowed)[key];
        if (parsed === current.defaults[key]) params.delete(key); else params.set(key, typeof parsed === "boolean" ? parsed ? "1" : "0" : String(parsed));
      }
      current.params = params; expected.current = params.toString();
      const history = settings.history || (changed.every(key => ["page", "before"].includes(key)) ? "push" : "replace");
      current.router[history](`${current.pathname}${params.size ? `?${params}` : ""}`, { scroll: false });
    };
    const immediate: Partial<QueryState<T>> = {};
    for (const [key, value] of Object.entries(patch)) {
      clearTimeout(timers.current.get(key)); timers.current.delete(key);
      const delay = latest.current.options.debounceMs?.[key];
      if (delay) timers.current.set(key, setTimeout(() => { timers.current.delete(key); write({ [key]: value } as Partial<QueryState<T>>); }, delay));
      else Object.assign(immediate, { [key]: value });
    }
    write(immediate);
  }, []);
  return [coerceAdminQuery(defaults, new URLSearchParams(search), options.allowed), set];
}
