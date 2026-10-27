"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { focusPageSearchTarget, searchShortcutBlocked } from "./usePageSearchShortcut";
import type { CommandNavigation } from "@/components/chrome/CommandSearchContext";

export const COMMAND_GO_KEYS: Readonly<Record<string, string>> = {
  t: "today", o: "opponents", r: "reviews", s: "settings",
};
type Options = {
  owner: object; route: object; path: string; navigation: readonly CommandNavigation[];
  search: () => void; help: () => void; navigate: (entry: CommandNavigation) => void;
};

/** Local page search wins regardless of document-listener registration order. */
export function useCommandSearchShortcuts(options: Options) {
  const latest = useRef<Options | null>(null);
  useLayoutEffect(() => { latest.current = options; return () => { latest.current = null; }; }, [options]);
  const prefix = useRef<{ until: number; owner: object; route: object } | null>(null);
  useEffect(() => { prefix.current = null; }, [options.owner, options.route]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const current = latest.current;
      if (!current) return;
      if (searchShortcutBlocked(event)) { prefix.current = null; return; }
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && key === "k") {
        prefix.current = null; event.preventDefault(); current.search(); return;
      }
      if (event.ctrlKey || event.metaKey) { prefix.current = null; return; }
      if (key === "/") {
        prefix.current = null; event.preventDefault();
        if (!focusPageSearchTarget()) current.search(); return;
      }
      if (key === "?") { prefix.current = null; event.preventDefault(); current.help(); return; }
      const pending = prefix.current; prefix.current = null;
      if (pending && pending.owner === current.owner && pending.route === current.route && Date.now() <= pending.until) {
        const entry = current.navigation.find(row => row.key === COMMAND_GO_KEYS[key]);
        if (entry) { event.preventDefault(); current.navigate(entry); return; }
      }
      if (key === "g" && !event.shiftKey) {
        prefix.current = { until: Date.now() + 1000, owner: current.owner, route: current.route };
        event.preventDefault();
      }
    };
    document.addEventListener("keydown", onKey);
    const retire = () => { prefix.current = null; };
    window.addEventListener("popstate", retire); window.addEventListener("hashchange", retire);
    return () => {
      prefix.current = null; document.removeEventListener("keydown", onKey);
      window.removeEventListener("popstate", retire); window.removeEventListener("hashchange", retire);
    };
  }, []);
}
