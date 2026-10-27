"use client";

import { useAuth } from "@clerk/nextjs";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Component, Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode,
} from "react";
import { isCommandSearchHref, type CommandPrivateTarget } from "@/lib/commandSearchTarget";
import type { CommandActivationPolicy } from "@/lib/commandSearchActivation";
import type { PrivateCommandSelectionDraft } from "@/lib/usePrivateCommandSearch";
import { clearCommandSearchRecent, recordCommandSearchRecent } from "@/lib/commandSearchRecent";
import { hasActiveFocusScope } from "@/lib/a11y/focusScopes";
import { useCommandSearchShortcuts } from "@/lib/useCommandSearchShortcuts";
import type { CommandSearchItem } from "@/lib/commandSearch";
import {
  CommandSearchContext, type CommandAdmission, type CommandChrome, type CommandOpening, type CommandSettings,
} from "./CommandSearchContext";

let activationPolicy: CommandActivationPolicy | null = null;
const Runtime = lazy(async () => {
  const runtime = await import("./CommandSearchRuntime");
  activationPolicy = runtime.commandActivationPolicy;
  return runtime;
});
type Mode = "palette" | "shortcuts" | "report" | "theme";
type Viewer = { key: string | null };
export type CommandFrame = CommandOpening & { id: number; owner: Viewer; route: object; path: string; mode: Mode };
type Authority = { owner: Viewer; route: object; path: string; active: boolean; frame: CommandFrame | null;
  query: object | null; location: string; lease: Lease | null };
type Lease = { active: boolean; authority: Authority; frame: CommandFrame; query: object; location: string;
  item: CommandSearchItem | null; target: CommandPrivateTarget | null; href?: string };
type Handoff = { lease: Lease; admission: CommandAdmission };
const locationKey = () => window.location.pathname + window.location.search + window.location.hash;
function retireLease(authority: Authority) {
  if (authority.lease) authority.lease.active = false;
  authority.lease = null;
}
function CommandRouteEntry({ path, commit }: { path: string; commit: (key: string) => void }) {
  const search = useSearchParams(), key = search ? `${path}?${search}` : null;
  useLayoutEffect(() => { if (key !== null) commit(key); }, [key, commit]);
  return null;
}

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

function useCommandController() {
  const auth = useAuth(), path = usePathname() ?? "/", router = useRouter();
  const key = auth.isLoaded && auth.isSignedIn ? auth.userId ?? null : null;
  const owner = useMemo(() => ({ key }), [key]);
  const route = useMemo(() => ({ path }), [path]);
  const chrome = useRegistration<CommandChrome>(), settings = useRegistration<CommandSettings>();
  const chromeRef = chrome.current, settingsRef = settings.current;
  const [frame, setFrame] = useState<CommandFrame | null>(null), [handoff, setHandoff] = useState<Handoff | null>(null);
  const sequence = useRef(0), live = useRef<Authority | null>(null);
  useLayoutEffect(() => {
    const authority: Authority = { owner, route, path, active: true, frame: null, query: null,
      location: locationKey(), lease: null };
    live.current = authority; setFrame(null); setHandoff(null);
    return () => {
      authority.active = false; retireLease(authority);
      if (live.current === authority) live.current = null;
    };
  }, [owner, route, path]);
  const [notice, setNotice] = useState("");
  const openMode = useCallback((mode: Mode, options: CommandOpening = {}) => {
    const current = live.current;
    if (!current?.active || current.owner !== owner || current.route !== route || window.location.pathname !== path) return;
    retireLease(current);
    setNotice("");
    const next: CommandFrame = {
      ...options, query: options.query?.slice(0, 160), id: ++sequence.current, owner, route, path, mode,
      returnFocus: options.returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null),
    };
    current.frame = next; current.query = next; current.location = locationKey();
    setHandoff(null); setFrame(next);
  }, [owner, route, path]);
  const open = useCallback((options?: CommandOpening) => openMode("palette", options), [openMode]);
  const close = useCallback((candidate: CommandFrame) => {
    const current = live.current;
    if (!current?.active || current.frame !== candidate) return;
    retireLease(current); current.frame = null; current.query = null;
    setFrame(previous => previous === candidate ? null : previous); setHandoff(null);
  }, []);
  const navigate = useCallback((href: string, admission?: CommandAdmission) => {
    if (!isCommandSearchHref(href) || !live.current?.active || live.current.owner !== owner
      || live.current.route !== route || (admission && !admission())) return;
    if (path === "/settings") {
      const guard = settingsRef.current;
      if (!guard || guard.ownerKey !== owner.key) {
        admission?.retire?.(); setNotice("Settings are still opening. Try search again."); return;
      }
      guard.navigate(href, admission);
    } else { router.push(href); admission?.retire?.(); }
  }, [owner, route, path, router, settingsRef]);
  useVisitedCommands(owner, path, chrome.value);
  useCommandSearchShortcuts({ owner, route, path, navigation: chrome.value?.ownerKey === key ? chrome.value.navigation : [],
    search: () => open(), help: () => openMode("shortcuts"), navigate: entry => navigate(entry.href) });
  useEffect(() => {
    if (!handoff) return;
    setHandoff(current => current === handoff ? null : current);
    if (!handoff.admission()) { handoff.admission.retire?.(); return; }
    const { lease } = handoff, item = lease.item;
    if (lease.href) navigate(lease.href, handoff.admission);
    else if (item?.action === "pair-device") navigate("/devices", handoff.admission);
    else if (item?.action === "whats-new") navigate("/changelog", handoff.admission);
    else openMode(item?.action === "report-problem" ? "report" : item?.action === "toggle-theme" ? "theme" : "shortcuts",
      { returnFocus: lease.frame.returnFocus });
  }, [handoff, navigate, openMode]);
  const ownsFrame = (candidate: CommandFrame) => {
    const current = live.current;
    return !!(current?.active && current.frame === candidate && current.owner === candidate.owner
      && current.route === candidate.route && current.path === candidate.path && current.location === locationKey());
  };
  const transfer = (candidate: CommandFrame, item: CommandSearchItem | null,
    draft: PrivateCommandSelectionDraft | null, query: object | null) => {
    if (!ownsFrame(candidate)) return false;
    const current = live.current!;
    const policy = activationPolicy;
    if (!policy) return false;
    const href = draft ? policy.privateHref(draft.target) : item?.href;
    if (draft ? !current.owner.key || chromeRef.current?.ownerKey !== current.owner.key || current.query !== query
      || !draft.isCurrent() || !href || href !== draft.href : !item || !policy.admitsItem(item, chromeRef.current, current.owner.key)) return false;
    retireLease(current);
    const lease: Lease = { active: true, authority: current, frame: candidate, query: current.query!,
      location: current.location, item, target: draft?.target ?? null, href: href ?? undefined };
    current.lease = lease;
    const admission: CommandAdmission = Object.assign(() => live.current === current && current.active && lease.active
      && current.lease === lease && current.query === lease.query && current.location === lease.location && locationKey() === lease.location
      && (lease.target ? !!current.owner.key && chromeRef.current?.ownerKey === current.owner.key
        && policy.privateHref(lease.target) === lease.href : !!lease.item && policy.admitsItem(lease.item, chromeRef.current, current.owner.key)), {
      retire: () => { lease.active = false; if (current.lease === lease) current.lease = null; },
    });
    // Transfer is complete before React unmounts the leaf. A stale Modal close
    // now sees no current frame and cannot cancel this one intentional handoff.
    current.frame = null; setFrame(previous => previous === candidate ? null : previous);
    setHandoff({ lease, admission }); return true;
  };
  const select = (candidate: CommandFrame, item: CommandSearchItem) => transfer(candidate, item, null, null);
  const selectPrivate = (candidate: CommandFrame, draft: PrivateCommandSelectionDraft, query: object) => transfer(candidate, null, draft, query);
  const editQuery = (candidate: CommandFrame): object | null => {
    if (!ownsFrame(candidate)) return null;
    const current = live.current!; retireLease(current); current.query = {};
    return current.query;
  };
  const retireLocation = useCallback(() => {
    const current = live.current;
    if (!current) return;
    retireLease(current); current.frame = null; current.query = null;
    setFrame(null); setHandoff(null);
  }, []);
  const routeEntry = useRef<string | null>(null);
  const commitRoute = useCallback((next: string) => {
    if (routeEntry.current !== null && routeEntry.current !== next) retireLocation();
    routeEntry.current = next;
  }, [retireLocation]);
  return { owner, route, path, frame, notice, chrome, settings, open, close, select, selectPrivate, editQuery, retireLocation, ownsFrame, commitRoute };
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
  const admitted = frame?.owner === owner && frame.route === route && controller.ownsFrame(frame) ? frame : null;
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
    const retire = controller.retireLocation;
    window.addEventListener("popstate", retire); window.addEventListener("hashchange", retire);
    return () => { window.removeEventListener("popstate", retire); window.removeEventListener("hashchange", retire); };
  }, [controller.retireLocation]);
  return <CommandSearchContext.Provider value={context}>{children}
    <Suspense fallback={null}><CommandRouteEntry path={controller.path} commit={controller.commitRoute} /></Suspense>
    {controller.notice ? <p role="status" className="sr-only">{controller.notice}</p> : null}
    {admitted ? <SearchBoundary key={admitted.id} onClose={() => close(admitted)}>
      <Suspense fallback={<PendingSearch onClose={() => close(admitted)} />}>
      <Runtime frame={admitted} navigation={chrome.value?.ownerKey === owner.key ? chrome.value.navigation : []}
        settingsTabs={settings.value?.ownerKey === owner.key ? settings.value.tabs : undefined}
        allowDefaultSettings={admitted.path !== "/settings" && chrome.value?.ownerKey === owner.key
          && chrome.value?.defaultSettingsAvailable === true}
        onClose={() => close(admitted)} onSelect={item => controller.select(admitted, item)}
        onQueryEdit={() => controller.editQuery(admitted)}
        onPrivateSelect={(draft, query) => controller.selectPrivate(admitted, draft, query)} />
      </Suspense>
    </SearchBoundary> : null}
  </CommandSearchContext.Provider>;
}
