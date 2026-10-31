"use client";

import { createContext, useContext, useLayoutEffect, useRef, type ReactNode } from "react";

const ROUTES = ["/v1/timeseries", "/v1/timeseries/day-hour", "/v1/length-buckets",
  "/v1/activity-calendar", "/v1/momentum", "/v1/timeseries/maps",
  "/v1/summary", "/v1/macro/summary", "/v1/timeseries/mmr",
  "/v1/timeseries/my-builds", "/v1/timeseries/opp-strategies",
  "/v1/matchups", "/v1/maps", "/v1/maps/matchups", "/v1/build-vs-strategy", "/v1/streak", "/v1/macro/report", "/v1/mmr-by-matchup", "/v1/mmr-by-matchup/opponents", "/v1/random-summary", "/v1/timeseries/matchups", "/v1/opp-mmr-buckets", "/v1/opp-mmr-buckets/games"];
let nextScope = 0;

export type ConditionalApiScope = {
  id: number; owner: string | null; active: boolean; retired: boolean;
  capabilities: number; retention: object; onRetire: Set<() => void>;
};
const Context = createContext<ConditionalApiScope | null>(null);
const makeScope = (owner: string | null): ConditionalApiScope => ({
  id: ++nextScope, owner, active: !!owner, retired: false, capabilities: 0, retention: {}, onRetire: new Set(),
});

export function retireConditionalScope(scope: ConditionalApiScope) {
  scope.active = false;
  if (scope.retired) return;
  scope.retired = true; scope.capabilities = 0;
  for (const stop of scope.onRetire) stop();
  scope.onRetire.clear();
}

/** An observed rejection retires ledger authority before reading its error body. */
export function rejectConditionalAuth(scope: ConditionalApiScope | null, owner: string, status: number) {
  if ((status !== 401 && status !== 403) || !scope?.active || scope.retired || scope.owner !== owner) return;
  scope.capabilities = 0; scope.retention = {};
  // Keep the listener registered for later capability rediscovery in this epoch.
  for (const stop of scope.onRetire) stop();
}

/** Ledger authority only: existing per-hook request/SWR lifetimes are unchanged. */
export function ConditionalApiProvider({ owner, children }: { owner: string | null; children: ReactNode }) {
  const ref = useRef<ConditionalApiScope | null>(null);
  if (!ref.current) ref.current = makeScope(owner);
  if (ref.current.owner !== owner) {
    retireConditionalScope(ref.current);
    ref.current = makeScope(owner);
  }
  const scope = ref.current;
  useLayoutEffect(() => {
    if (!scope.retired && ref.current === scope) scope.active = !!owner;
    return () => {
      scope.active = false;
      queueMicrotask(() => { if (!scope.active) retireConditionalScope(scope); });
    };
  }, [owner, scope]);
  return <Context.Provider value={scope}>{children}</Context.Provider>;
}

export const useConditionalApiScope = () => useContext(Context);
export function conditionalRoute(path: string): number { return ROUTES.indexOf(path.split(/[?#]/, 1)[0]); }
export function conditionalCapability(res: Response): boolean {
  const tag = res.headers?.get("etag");
  const control = res.headers?.get("cache-control")?.toLowerCase().split(",").map(value => value.trim()) ?? [];
  return res.status === 200 && /^W\/"uc1-[0-9a-f]{64}"$/.test(tag ?? "")
    && control.includes("private") && control.includes("no-cache");
}
export function noteConditionalCapability(scope: ConditionalApiScope | null, owner: string, path: string, res: Response) {
  const route = conditionalRoute(path);
  if (!scope?.active || scope.retired || scope.owner !== owner || route < 0 || !conditionalCapability(res)) return false;
  scope.capabilities |= 1 << route;
  return true;
}

/** One nonblocking import attempt. A failed enhancement never repeats an API request. */
export function createConditionalLoader<T>(load: () => Promise<T>) {
  let ready: T | undefined, started = false;
  return {
    get: () => ready,
    start: () => {
      if (started) return;
      started = true;
      void load().then(value => { ready = value; }, () => {});
    },
  };
}

