"use client";

import { useSyncExternalStore } from "react";

const CHANGE = "sc2tools:replay-list-state";
const KEYS = ["replaySearch", "replayResult", "replayMatchup", "replaySort"] as const;
type Key = (typeof KEYS)[number];
const DEFAULTS = { replaySearch: "", replayResult: "all", replayMatchup: "all", replaySort: "date_desc" };

function subscribe(notify: () => void) {
  window.addEventListener("popstate", notify); window.addEventListener(CHANGE, notify);
  return () => { window.removeEventListener("popstate", notify); window.removeEventListener(CHANGE, notify); };
}

function valid(key: Key, value: string): string {
  if (key === "replaySearch") return value.length <= 100 && !/[\u0000-\u001f\u007f]/.test(value) ? value : "";
  if (key === "replayResult") return ["all", "win", "loss", "tie"].includes(value) ? value : "all";
  if (key === "replayMatchup") return /^[PTZR]v[PTZR]$/.test(value) ? value : "all";
  return value === "date_asc" ? value : "date_desc";
}

/** Local replay controls survive both a remount and a durable game backlink. */
export function useReplayListFilters() {
  const search = useSyncExternalStore(subscribe, () => window.location.search, () => "");
  const query = new URLSearchParams(search);
  const update = (key?: Key, value = "") => {
    const url = new URL(window.location.href);
    for (const name of key ? [key] : KEYS) {
      const next = key ? valid(name, value) : DEFAULTS[name];
      if (next === DEFAULTS[name]) url.searchParams.delete(name); else url.searchParams.set(name, next);
    }
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    window.dispatchEvent(new Event(CHANGE));
  };
  return {
    search: valid("replaySearch", query.get("replaySearch") ?? ""), setSearch: (value: string) => update("replaySearch", value),
    result: valid("replayResult", query.get("replayResult") ?? "") as "all" | "win" | "loss" | "tie", setResult: (value: string) => update("replayResult", value),
    matchup: valid("replayMatchup", query.get("replayMatchup") ?? ""), setMatchup: (value: string) => update("replayMatchup", value),
    sort: valid("replaySort", query.get("replaySort") ?? "") as "date_desc" | "date_asc", setSort: (value: string) => update("replaySort", value),
    reset: () => update(),
  };
}
