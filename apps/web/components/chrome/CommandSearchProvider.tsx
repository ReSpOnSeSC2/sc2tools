"use client";

import { useAuth } from "@clerk/nextjs";
import { usePathname, useRouter } from "next/navigation";
import {
  Component, Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode,
} from "react";
import { isCommandSearchHref } from "@/lib/commandSearchTarget";
import { clearCommandSearchRecent, recordCommandSearchRecent } from "@/lib/commandSearchRecent";
import { hasActiveFocusScope } from "@/lib/a11y/focusScopes";
import { useCommandSearchShortcuts } from "@/lib/useCommandSearchShortcuts";
import type { CommandSearchItem } from "@/lib/commandSearch";
import {
  CommandSearchContext, type CommandChrome, type CommandOpening, type CommandSettings,
} from "./CommandSearchContext";

const Runtime = lazy(() => import("./CommandSearchRuntime"));
type Mode = "palette" | "shortcuts" | "report" | "theme";
type Viewer = { key: string | null };
export type CommandFrame = CommandOpening & { id: number; owner: Viewer; route: object; path: string; mode: Mode };
type Handoff = { frame: CommandFrame; item: CommandSearchItem };

function useRegistration<T>() {
  const [value, setValue] = useState<T | null>(null), current = useRef<T | null>(null);
  const register = useCallback((next: T) => {
    current.current = next; setValue(next);
    return () => {
      if (current.current === next) current.current = null;
      setValue(previous => previous === next ? null : previous);
    };
  }, []);
  return { value, current, register };
}

function useVisitedCommands(viewer: Viewer, path: string, chrome: CommandChrome | null) {
  const lifetime = useMemo(() => ({ viewer, path, chrome }), [viewer, path, chrome]);
  const latest = useRef<typeof lifetime | null>(null);
  useLayoutEffect(() => { latest.current = lifetime; return () => { latest.current = null; }; }, [lifetime]);
  const previous = useRef(viewer.key);
  useEffect(() => {
    if (latest.current !== lifetime) return;
    if (previous.current && !viewer.key) clearCommandSearchRecent(previous.current);
    previous.current = viewer.key;
    if (!viewer.key || chrome?.ownerKey !== viewer.key) return;
    const here = path + window.location.search;
    const entry = chrome.navigation.find(row => row.href === here)
      ?? chrome.navigation.find(row => row.href === path);
    if (entry) recordCommandSearchRecent(viewer.key, entry.key, chrome.navigation.map(row => row.key));
  }, [viewer, path, chrome, lifetime]);
}

function admittedItem(item: CommandSearchItem, chrome: CommandChrome | null, owner: Viewer): boolean {
  if (item.disabled || (item.href && !isCommandSearchHref(item.href))) return false;
  if (item.group === "navigation" || item.group === "recent") {
    return chrome?.ownerKey === owner.key && chrome.navigation.some(row =>
      row.href === item.href && (item.id === `navigation:${row.key}` || item.id === `recent:${row.key}`));
  }
  if ((item.group === "settings" || item.action === "pair-device") && !owner.key) return false;
  return Boolean(item.href || item.action);
}

type HandoffContext = {
  owner: Viewer; route: object; path: string; chrome: CommandChrome | null;
  navigate: (href: string) => void; open: (mode: Mode, options?: CommandOpening) => void;
};
function completeHandoff(handoff: Handoff, current: HandoffContext) {
  if (current.owner !== handoff.frame.owner || current.route !== handoff.frame.route
    || window.location.pathname !== current.path || !admittedItem(handoff.item, current.chrome, current.owner)) return;
  if (handoff.item.href) current.navigate(handoff.item.href);
  else if (handoff.item.action === "pair-device") current.navigate("/devices");
  else if (handoff.item.action === "whats-new") current.navigate("/changelog");
  else current.open(handoff.item.action === "report-problem" ? "report"
    : handoff.item.action === "toggle-theme" ? "theme" : "shortcuts", { returnFocus: handoff.frame.returnFocus });
}

function useCommandController() {
  const auth = useAuth(), path = usePathname() ?? "/", router = useRouter();
  const key = auth.isLoaded && auth.isSignedIn ? auth.userId ?? null : null;
  const owner = useMemo(() => ({ key }), [key]);
  const route = useMemo(() => ({ path }), [path]);
  const chrome = useRegistration<CommandChrome>(), settings = useRegistration<CommandSettings>();
  const chromeRef = chrome.current, settingsRef = settings.current;
  const [frame, setFrame] = useState<CommandFrame | null>(null), [handoff, setHandoff] = useState<Handoff | null>(null);
  const sequence = useRef(0), live = useRef<{ owner: Viewer; route: object; path: string;
    frame: CommandFrame | null } | null>(null);
  useLayoutEffect(() => {
    live.current = { owner, route, path, frame };
    return () => { live.current = null; };
  }, [owner, route, path, frame]);
  const [notice, setNotice] = useState("");
  const openMode = useCallback((mode: Mode, options: CommandOpening = {}) => {
    if (live.current?.owner !== owner || live.current.route !== route || window.location.pathname !== path) return;
    setNotice("");
    setFrame(current => current?.owner === owner && current.route === route ? current : {
      ...options, query: options.query?.slice(0, 160), id: ++sequence.current, owner, route, path, mode,
      returnFocus: options.returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null),
    });
  }, [owner, route, path]);
  const open = useCallback((options?: CommandOpening) => openMode("palette", options), [openMode]);
  const close = useCallback((candidate: CommandFrame) => setFrame(current => current === candidate ? null : current), []);
  const navigate = useCallback((href: string) => {
    if (!isCommandSearchHref(href)) return;
    if (path === "/settings") {
      const guard = settingsRef.current;
      if (!guard || guard.ownerKey !== owner.key) { setNotice("Settings are still opening. Try search again."); return; }
      guard.navigate(href);
    } else router.push(href);
  }, [owner, path, router, settingsRef]);
  useVisitedCommands(owner, path, chrome.value);
  useCommandSearchShortcuts({ owner, route, path, navigation: chrome.value?.ownerKey === key ? chrome.value.navigation : [],
    search: () => open(), help: () => openMode("shortcuts"), navigate: entry => navigate(entry.href) });
  useEffect(() => {
    if (!handoff) return;
    setHandoff(null);
    if (live.current) completeHandoff(handoff, { ...live.current, chrome: chromeRef.current, navigate, open: openMode });
  }, [handoff, chromeRef, navigate, openMode]);
  useEffect(() => {
    setFrame(current => current?.owner === owner && current.route === route ? current : null);
    setHandoff(null);
  }, [owner, route]);
  const select = (candidate: CommandFrame, item: CommandSearchItem) => {
    if (live.current?.frame !== candidate || live.current.owner !== candidate.owner || live.current.route !== candidate.route) return;
    close(candidate); setHandoff({ frame: candidate, item });
  };
  return { owner, route, path, frame, notice, chrome, settings, open, close, select };
}

function PendingSearch({ onClose, failed = false }: { onClose: () => void; failed?: boolean }) {
  return <section aria-label="Search status" className="fixed right-4 top-20 z-50 max-w-xs rounded-xl border-2
    border-line bg-bg-surface p-4 text-text shadow-hard">
    <p role="status">{failed ? "Search could not load. You can still use the navigation and Help." : "Loading search…"}</p>
    <button type="button" onClick={onClose} className="min-h-11 px-3 font-semibold underline">Close search</button>
  </section>;
}
class SearchBoundary extends Component<{ onClose: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <PendingSearch failed onClose={this.props.onClose} /> : this.props.children; }
}

export function CommandSearchProvider({ children }: { children: ReactNode }) {
  const controller = useCommandController(), { owner, route, frame, chrome, settings, open, close } = controller;
  const context = useMemo(() => ({ ownerKey: owner.key, open,
    registerChrome: chrome.register, registerSettings: settings.register }), [owner, open, chrome.register, settings.register]);
  const admitted = frame?.owner === owner && frame.route === route ? frame : null;
  useEffect(() => {
    if (!admitted) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !hasActiveFocusScope()) {
        event.preventDefault(); close(admitted);
      }
    };
    document.addEventListener("keydown", escape); return () => document.removeEventListener("keydown", escape);
  }, [admitted, close]);
  useEffect(() => {
    const retire = () => { if (frame) close(frame); };
    window.addEventListener("popstate", retire); window.addEventListener("hashchange", retire);
    return () => { window.removeEventListener("popstate", retire); window.removeEventListener("hashchange", retire); };
  }, [frame, close]);
  return <CommandSearchContext.Provider value={context}>{children}
    {controller.notice ? <p role="status" className="sr-only">{controller.notice}</p> : null}
    {admitted ? <SearchBoundary key={admitted.id} onClose={() => close(admitted)}>
      <Suspense fallback={<PendingSearch onClose={() => close(admitted)} />}>
      <Runtime frame={admitted} navigation={chrome.value?.ownerKey === owner.key ? chrome.value.navigation : []}
        settingsTabs={settings.value?.ownerKey === owner.key ? settings.value.tabs : undefined}
        allowDefaultSettings={admitted.path !== "/settings" && chrome.value?.ownerKey === owner.key
          && chrome.value?.defaultSettingsAvailable === true}
        onClose={() => close(admitted)} onSelect={item => controller.select(admitted, item)} />
      </Suspense>
    </SearchBoundary> : null}
  </CommandSearchContext.Provider>;
}
