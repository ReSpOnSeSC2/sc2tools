"use client";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { browserQueryLocation, queryLocation, UrlQueryNavigation, type QueryWriteGuard } from "./urlQueryNavigation";
export type UrlHistoryMode = "replace" | "push";
const navigation = new UrlQueryNavigation();
export type SectionHistoryState = { sc2toolsStrategyDrill?: string };
const historyMetadata = new Map<string, { epoch: number; value: SectionHistoryState }>();

/** Shared with AnalyzerFilterUrlSync so its delayed filter writes preserve
 * section changes that Next has not acknowledged yet. */
export function useUrlQueryWriter() {
  const path = usePathname() ?? "", search = useSearchParams()?.toString() ?? "", router = useRouter();
  if (typeof window !== "undefined") navigation.observe(queryLocation(path, search));
  const epoch = navigation.epoch, key = queryLocation(path, search).key, owned = navigation.known.has(key);
  useLayoutEffect(() => {
    const carried = historyMetadata.get(key);
    if (!owned || carried?.epoch !== epoch || browserQueryLocation()?.key !== key || !carried.value.sc2toolsStrategyDrill || window.history.state?.sc2toolsStrategyDrill === carried.value.sc2toolsStrategyDrill) return;
    window.history.replaceState({ ...window.history.state, ...carried.value }, "", window.location.href);
  }, [key, epoch, owned]);
  const latest = useRef(router); latest.current = router;
  useEffect(() => {
    const onHistory = () => { const live = browserQueryLocation(); if (live) navigation.reset(live); };
    window.addEventListener("popstate", onHistory);
    return () => window.removeEventListener("popstate", onHistory);
  }, []);
  const capture = useCallback(() => {
    const browser = browserQueryLocation();
    return browser ? navigation.guard(browser) : null;
  }, []);
  const update = useCallback((change: (params: URLSearchParams) => URLSearchParams, mode: UrlHistoryMode = "replace", guard?: QueryWriteGuard | null, state?: SectionHistoryState) => {
    const live = browserQueryLocation(); if (!live) return false;
    const beforeEpoch = navigation.epoch;
    const pending = historyMetadata.get(navigation.expected);
    const previous = mode === "replace" ? pending?.epoch === navigation.epoch ? pending.value : { sc2toolsStrategyDrill: window.history.state?.sc2toolsStrategyDrill } : {};
    const href = navigation.prepare(change, live, guard ?? undefined); if (!href) return false;
    const carried = navigation.epoch === beforeEpoch ? previous : { sc2toolsStrategyDrill: window.history.state?.sc2toolsStrategyDrill };
    const marker = (state ?? carried).sc2toolsStrategyDrill;
    historyMetadata.set(href, { epoch: navigation.epoch, value: typeof marker === "string" && marker.length <= 100 ? { sc2toolsStrategyDrill: marker } : {} });
    if (historyMetadata.size > 16) historyMetadata.delete(historyMetadata.keys().next().value!);
    latest.current[mode](`${href}${window.location.hash}`, { scroll: false }); return true;
  }, []);
  return { path, search, epoch, owned, capture, update };
}

