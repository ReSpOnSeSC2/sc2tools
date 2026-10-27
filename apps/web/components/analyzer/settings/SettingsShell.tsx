"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { InstallAppButton } from "@/components/pwa/InstallAppButton";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ServerCog,
  UserRound,
  MonitorPlay,
  Volume2,
  Database,
  Settings2,
  Dices,
  LifeBuoy,
  Upload,
  ClipboardCheck,
  MessagesSquare,
} from "lucide-react";
import { Tabs, useTabIds } from "@/components/ui/Tabs";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useDocumentTitle } from "@/lib/useDocumentTitle";
import {
  SETTINGS_GROUPS,
  SETTINGS_TABS,
  defaultTabVisibility,
  resolveSettingsDestination,
  settingsTabFromParam as settingsTabFromParamForShell,
  type SettingsDestination,
  type SettingsOverlayPane,
  type SettingsTabId,
} from "@/lib/settingsRegistry";
import {
  SettingsContextProvider,
  useSettingsContext,
} from "./SettingsContext";
import { revealSectionAnchor } from "./revealSectionAnchor";
import { settingsSectionsForTab } from "@/lib/settingsIndex";
import { SettingsSectionNav } from "./SettingsSectionNav";
import { OverlayManagerNav } from "./OverlayManagerNav";
import { SettingsSearch } from "./SettingsSearch";
import { useCommandSettings } from "@/components/chrome/CommandSearchContext";
import { isCommandSearchHref } from "@/lib/commandSearchTarget";

// Preserve existing imports while non-UI consumers can use the pure leaf.
export {
  defaultTabVisibility,
  isSettingsTabId,
  SETTINGS_TAB_ALIASES,
  settingsTabFromParam,
  settingsTabForLegacyHash,
  visibleSettingsTabs,
  type SettingsTabId,
} from "@/lib/settingsRegistry";

const TAB_ICONS: Record<SettingsTabId, typeof ServerCog> = {
  account: ServerCog, profile: UserRound, backups: Database,
  checkin: ClipboardCheck, randomizer: Dices, import: Upload,
  overlay: MonitorPlay, chat: MessagesSquare, voice: Volume2, preferences: Settings2, help: LifeBuoy,
};
const TABS = SETTINGS_TABS.map((tab) => ({ ...tab, Icon: TAB_ICONS[tab.id] }));
type TabDef = (typeof TABS)[number];
type PendingDestination =
  | { kind: "tab"; destination: SettingsDestination; fromUrl: boolean; previousHref: string; action: object; owner: object }
  | { kind: "devices"; action: object; owner: object }
  | { kind: "route"; href: string; action: object; owner: object };

export interface SettingsShellProps {
  /**
   * The tab the URL asks for (`?tab=`). A later change (a link to another
   * tab while Settings is open) switches tabs too, through the same
   * unsaved-changes guard as a click.
   *
   * With no `?tab=` in the URL, an old `/settings#<tab>` link opens that
   * tab and the URL is rewritten to `?tab=<tab>`. Any other `#anchor`
   * names a section: once its tab is showing, the page scrolls to it and
   * highlights it.
   */
  initialTab?: SettingsTabId;
  renderTab: (id: SettingsTabId) => ReactNode;
  /** Which tabs to show; defaults to every registered tab. */
  isTabVisible?: (id: SettingsTabId) => boolean;
  /** Complete search input: same-tab section links also pass the dirty guard. */
  requestedSearch?: string;
  ownerKey?: string | null;
  /** One lazy authority inside the persistent streaming panel, outside its keyed private body. */
  renderStreaming?: (children: ReactNode, section: SettingsOverlayPane) => ReactNode;
}

export function SettingsShell({
  initialTab = "account",
  renderTab,
  isTabVisible = defaultTabVisibility,
  requestedSearch,
  ownerKey = null,
  renderStreaming,
}: SettingsShellProps) {
  return (
    <SettingsContextProvider>
      <SettingsShellInner
        initialTab={initialTab}
        renderTab={renderTab}
        isTabVisible={isTabVisible}
        requestedSearch={requestedSearch}
        ownerKey={ownerKey}
        renderStreaming={renderStreaming}
      />
    </SettingsContextProvider>
  );
}

function SettingsShellInner({
  initialTab,
  renderTab,
  isTabVisible,
  requestedSearch,
  ownerKey,
  renderStreaming,
}: SettingsShellProps & { initialTab: SettingsTabId; isTabVisible: (id: SettingsTabId) => boolean }) {
  const router = useRouter();
  const tabs = useMemo(() => TABS.filter((t) => isTabVisible(t.id)), [isTabVisible]);
  const [active, setActive] = useState<SettingsTabId>(() =>
    tabs.some((t) => t.id === initialTab) ? initialTab : (tabs[0]?.id ?? initialTab),
  );
  // URL-origin requests retain the full admitted destination and the previous
  // href; Stay can restore aliases, extras and section hashes exactly.
  const [pending, setPending] = useState<PendingDestination | null>(
    null,
  );
  const ctx = useSettingsContext();
  const [destination, setDestination] = useState(() => resolveSettingsDestination(`tab=${initialTab}`));
  const [locationReady, setLocationReady] = useState(false);
  const owner = useMemo(() => ({ key: ownerKey }), [ownerKey]);
  const latestOwner = useRef(owner); latestOwner.current = owner;
  const mounted = useRef(true);
  const action = useRef<object>({});
  const admittedHref = useRef("");
  const [anchorChanges, setAnchorChanges] = useState(0);
  // "Overlay · Settings · SC2 Tools": the browser tab (and a bookmark of
  // the ?tab= URL) names the settings tab that is open.
  const activeLabel = tabs.find((t) => t.id === active)?.label;
  useDocumentTitle(activeLabel ? `${activeLabel} · Settings` : null);
  const activate = useCallback((next: SettingsDestination) => {
    setActive(next.tab); setDestination(next);
    if (window.location.pathname + window.location.search + window.location.hash !== next.href) window.history.replaceState(null, "", next.href);
    admittedHref.current = next.href;
  }, []);
  const requestDestination = useCallback((next: SettingsDestination, fromUrl: boolean) => {
    if (!mounted.current || latestOwner.current !== owner) return;
    if (!tabs.some(tab => tab.id === next.tab)) return;
    const attempt = {}; action.current = attempt;
    if (next.tab === active && next.href === admittedHref.current) {
      setPending(null);
      // A player may scroll elsewhere while this anchor stays in the URL.
      // Only an explicit repeat choice reveals it again; URL sync stays inert.
      if (!fromUrl) setAnchorChanges(value => value + 1);
      return;
    }
    if (next.tab !== active && ctx.isDirty(active)) {
      setPending({ kind: "tab", destination: next, fromUrl, previousHref: admittedHref.current, action: attempt, owner });
      return;
    }
    setPending(null); activate(next);
  }, [tabs, active, ctx, owner, activate]);
  const requestSwitch = useCallback((next: string) => {
    if (!tabs.some(tab => tab.id === next) || next === active) return;
    const query = new URLSearchParams(window.location.search);
    query.set("tab", next); query.delete("section"); query.delete("pack"); query.delete("widget");
    requestDestination(resolveSettingsDestination(query.toString()), false);
  }, [tabs, active, requestDestination]);
  const previousRequest = useRef<string | null>(null);
  const previousInitialTab = useRef<SettingsTabId | null>(null);
  useLayoutEffect(() => {
    const query = new URLSearchParams(requestedSearch ?? window.location.search);
    // Keep the existing standalone initialTab contract used by consumers.
    if (requestedSearch === undefined && initialTab !== previousInitialTab.current &&
        (previousInitialTab.current !== null || query.has("tab")) && settingsTabFromParamForShell(query.get("tab")) !== initialTab) query.set("tab", initialTab);
    previousInitialTab.current = initialTab;
    const requestKey = `${query}#${window.location.hash}`;
    if (requestKey === previousRequest.current) return;
    const next = resolveSettingsDestination(query.toString(), window.location.hash, initialTab);
    if (!tabs.some(tab => tab.id === next.tab)) return;
    previousRequest.current = requestKey;
    if (!locationReady) {
      activate(next); setLocationReady(true);
    } else requestDestination(next, true);
  }, [requestedSearch, initialTab, tabs, locationReady, activate, requestDestination, anchorChanges]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; action.current = {}; };
  }, []);
  useEffect(() => { action.current = {}; setPending(null); }, [owner]);

  // `#section` anchors: once the tab is showing, scroll to the section
  // and highlight it, and again whenever the anchor changes. Help opens
  // its own article anchors.
  const panelRegion = useRef<HTMLDivElement>(null);
  const activeBody = useRef<HTMLDivElement>(null);
  const panelScopeId = useId();
  const desktopRows = SETTINGS_GROUPS.flatMap((group) => {
    const groupTabs = tabs.filter((tab) => tab.group === group.id);
    if (!groupTabs.length && group.id !== "account") return [];
    return [
      ...(group.showHeading ? [{ kind: "heading" as const, group }] : []),
      ...groupTabs.map((tab) => ({ kind: "tab" as const, tab })),
      ...(group.id === "account" ? [{ kind: "devices" as const }] : []),
    ];
  });
  useEffect(() => {
    const onHashChange = () => setAnchorChanges((n) => n + 1);
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  useEffect(() => {
    if (active === "help") return undefined;
    // The streaming authority gates its children on a fresh token read. Keep
    // the bounded observer on this stable content region while that panel is
    // absent, so a late Chat/Overlay section still reveals once it appears.
    const panel = active === "overlay" || active === "chat" ? panelRegion.current
      : document.querySelector<HTMLElement>(`[data-settings-panel="${panelScopeId}-${active}"]`);
    if (!panel) return undefined;
    return revealSectionAnchor(destination.hash, panel);
  }, [active, destination, anchorChanges, panelScopeId, owner]);

  const requestSection = (href: string) => {
    if (!mounted.current || latestOwner.current !== owner) return;
    const [search, hash = ""] = href.replace(/^\/settings\?/, "").split("#");
    requestDestination(resolveSettingsDestination(search, hash ? `#${hash}` : "", active), false);
  };
  const requestCommand = (href: string) => {
    if (!mounted.current || latestOwner.current !== owner || !isCommandSearchHref(href)) return;
    const target = new URL(href, window.location.origin);
    if (target.pathname === "/settings") {
      requestDestination(resolveSettingsDestination(target.search.slice(1), target.hash, active), false);
    } else {
      const attempt = {}; action.current = attempt;
      if (ctx.hasAnyDirty()) setPending({ kind: "route", href, action: attempt, owner });
      else router.push(href);
    }
  };
  useCommandSettings({ ownerKey: owner.key ?? null, tabs: tabs.map(tab => tab.id), navigate: requestCommand });

  const confirmDiscard = () => {
    if (pending && mounted.current && pending.owner === latestOwner.current && pending.action === action.current) {
      setPending(null);
      if (pending.kind === "devices") router.push("/devices");
      else if (pending.kind === "route") router.push(pending.href);
      else activate(pending.destination);
    }
  };

  const stay = () => {
    // A link asked for another tab but the player kept their edits: put
    // the URL back on the tab that is actually showing.
    if (!pending || !mounted.current || pending.owner !== latestOwner.current || pending.action !== action.current) return;
    if (pending.kind === "tab" && pending.fromUrl) window.history.replaceState(null, "", pending.previousHref);
    action.current = {};
    setPending(null);
  };

  return (
    <>
      <SettingsSearch key={owner.key ?? "signed-out"} ownerKey={owner.key ?? null} onNavigate={requestSection} />
      <Tabs
        value={active}
        onValueChange={(next) => requestSwitch(next)}
        orientation="vertical"
        className="lg:grid-cols-[240px_minmax(0,1fr)]"
      >
        <MobileSettingsTabs tabs={tabs} active={active} isDirty={ctx.isDirty} requestSwitch={requestSwitch} />

        {/* Desktop sidebar */}
        <nav aria-label="Settings navigation" className="hidden space-y-2 lg:block">
          <div className="sticky top-4 grid gap-0.5 rounded-xl border-2 border-line bg-bg-surface p-1 shadow-hard">
            {desktopRows.map((row, index) => row.kind === "heading" ? (
              <h2 key={row.group.id} id={`${panelScopeId}-group-${row.group.id}`} data-settings-group={row.group.id} style={{ gridRow: index + 1 }} className="px-3 pb-1 pt-3 text-caption font-semibold text-text-muted">{row.group.label}</h2>
            ) : row.kind === "devices" ? (
              <Link key="devices" href="/devices" aria-label="Devices" aria-describedby={`${panelScopeId}-devices-description`} data-settings-group="account" style={{ gridRow: index + 1 }}
                onNavigate={(event) => {
                  // Next only calls onNavigate for same-tab client navigation;
                  // modified clicks and opening a new tab keep native behavior.
                  if (ctx.isDirty(active)) {
                    event.preventDefault();
                    const attempt = {}; action.current = attempt;
                    setPending({ kind: "devices", action: attempt, owner });
                  }
                }}
                className="block min-h-11 rounded-md px-3 py-2 text-caption font-medium text-text-muted hover:bg-bg-elevated hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                <span className="block">Devices</span>
                <span id={`${panelScopeId}-devices-description`} className="mt-1 block font-normal leading-snug">Pair and manage your PCs</span>
              </Link>
            ) : null)}
            {/* Grid placement groups the sidebar visually. Only tabs are owned
                by this one list, and direct siblings share its arrow keys. */}
            <Tabs.List ariaLabel="Settings sections" style={{ display: "contents" }}>
              {desktopRows.map((row, index) => row.kind === "tab" ? (
                <Tabs.Trigger key={row.tab.id} value={row.tab.id} aria-label={row.tab.label}
                  aria-describedby={[SETTINGS_GROUPS.find((group) => group.id === row.tab.group)?.showHeading ? `${panelScopeId}-group-${row.tab.group}` : null, `${panelScopeId}-${row.tab.id}-description`, ctx.isDirty(row.tab.id) ? `${panelScopeId}-${row.tab.id}-dirty` : null].filter(Boolean).join(" ")}
                  data-settings-group={row.tab.group} style={{ gridRow: index + 1 }}>
                  <span className="inline-flex w-full items-center gap-2.5">
                    <row.tab.Icon className="h-4 w-4 flex-shrink-0" aria-hidden />
                    <span className="flex-1 truncate text-left">{row.tab.label}</span>
                    {ctx.isDirty(row.tab.id) ? <span id={`${panelScopeId}-${row.tab.id}-dirty`} role="img" aria-label="Unsaved changes" title="Unsaved changes" className="inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-accent-cyan"><span className="sr-only">Unsaved changes</span></span> : null}
                  </span>
                  <span id={`${panelScopeId}-${row.tab.id}-description`} className="mt-1 block text-caption leading-snug text-text-muted">{row.tab.description}</span>
                </Tabs.Trigger>
              ) : null)}
            </Tabs.List>
          </div>
          <InstallAppButton className="w-full" />
        </nav>

        <div ref={panelRegion} className="min-w-0">
        {(() => {
          if (active === "overlay" || active === "chat") {
            const sections = settingsSectionsForTab(active);
            const body = <div key={active}>
              <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_160px]">
                {active === "overlay" ? <OverlayManagerNav scope={panelRegion} hash={destination.hash} onNavigate={requestSection} />
                  : <SettingsSectionNav tab={active} sections={sections} scope={panelRegion} hash={destination.hash} onNavigate={requestSection} />}
                <div className="min-w-0 lg:col-start-1 lg:row-start-1">{renderTab(active)}</div>
              </div>
            </div>;
            return <>
              {tabs.filter(tab => tab.id !== active).map(tab => <Tabs.Content
                key={tab.id}
                value={tab.id}
                data-settings-panel={`${panelScopeId}-${tab.id}`}
                className="space-y-5 pb-24"
              >{null}</Tabs.Content>)}
              <Tabs.Content
              value={active}
              data-settings-panel={`${panelScopeId}-${active}`}
              className="space-y-5 pb-24"
            >
              {locationReady
                ? renderStreaming ? renderStreaming(body, destination.overlayPane) : body
                : <p role="status">Opening streaming settings…</p>}
              </Tabs.Content>
            </>;
          }
          return tabs.map((t) => (
          <Tabs.Content
            key={t.id}
            value={t.id}
            data-settings-panel={`${panelScopeId}-${t.id}`}
            className="space-y-5 pb-24"
          >
            {t.id !== "help" && settingsSectionsForTab(t.id).length >= 3 ? <div ref={activeBody}
              className="grid min-w-0 gap-5 lg:has-[>nav]:grid-cols-[minmax(0,1fr)_160px]">
              <SettingsSectionNav key={`${owner.key ?? "signed-out"}:${t.id}`} tab={t.id}
                sections={settingsSectionsForTab(t.id)} scope={activeBody} hash={destination.hash}
                onNavigate={requestSection} targetPolicy="mounted" minimumSections={3} />
              <div className="min-w-0 lg:col-start-1 lg:row-start-1">{renderTab(t.id)}</div>
            </div> : renderTab(t.id)}
          </Tabs.Content>
          ));
        })()}
        </div>
      </Tabs>

      <ConfirmDialog
        open={pending !== null}
        onClose={stay}
        onConfirm={confirmDiscard}
        title="Discard unsaved changes?"
        description={pending?.kind === "devices" ? "You have edits on this panel that haven't been saved. Leave Settings for Devices?" : "You have edits on this panel that haven't been saved. Switch tabs anyway?"}
        confirmLabel={pending?.kind === "devices" ? "Discard & open Devices" : "Discard & switch"}
        cancelLabel="Stay on this tab"
        intent="danger"
      />
    </>
  );
}

function MobileSettingsTabs({ tabs, active, isDirty, requestSwitch }: { tabs: readonly TabDef[]; active: SettingsTabId; isDirty: (id: SettingsTabId) => boolean; requestSwitch: (id: string) => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  const [edges, setEdges] = useState({ left: false, right: false });
  const measure = () => { const el = scroller.current; if (el) setEdges({ left: el.scrollLeft > 1, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 }); };
  useEffect(() => {
    const el = scroller.current;
    const button = el?.querySelector<HTMLElement>('[aria-selected="true"]');
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    button?.scrollIntoView?.({ inline: 'nearest', block: 'nearest', behavior: first.current || reduced ? 'auto' : 'smooth' });
    first.current = false; measure();
  }, [active]);
  useEffect(() => {
    const el = scroller.current; if (!el) return;
    measure(); const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure); observer?.observe(el);
    for (const child of Array.from(el.children)) observer?.observe(child);
    return () => observer?.disconnect();
  }, []);
  return <div className="relative min-w-0 lg:hidden">
    <div ref={scroller} role="tablist" tabIndex={-1} aria-label="Settings sections" aria-orientation="horizontal" onScroll={measure}
      className="-mx-4 flex items-center gap-1 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0"
      onKeyDown={(event) => {
        const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
        const index = items.indexOf(event.target as HTMLButtonElement);
        const next = event.key === 'ArrowRight' ? (index + 1) % items.length : event.key === 'ArrowLeft' ? (index + items.length - 1) % items.length : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : null;
        if (next !== null) { event.preventDefault(); items[next]?.focus(); requestSwitch(items[next].dataset.value!); }
      }}>
      {tabs.map((tab) => <MobileTabTrigger key={tab.id} tab={tab} active={active === tab.id} dirty={isDirty(tab.id)} onActivate={() => requestSwitch(tab.id)} />)}
    </div>
    {edges.left ? <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-bg to-transparent" /> : null}
    {edges.right ? <span aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-bg to-transparent" /> : null}
  </div>;
}

function MobileTabTrigger({ tab, active, dirty, onActivate }: { tab: TabDef; active: boolean; dirty: boolean; onActivate: () => void }) {
  const { triggerId, panelId } = useTabIds(tab.id);
  return <button type="button" role="tab" id={triggerId + '-mobile'} data-value={tab.id} aria-controls={panelId} aria-selected={active} tabIndex={active ? 0 : -1} onClick={onActivate}
    className={['relative inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-md border px-3 py-2 text-caption focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent', active ? 'border-accent/40 bg-accent/15 text-accent' : 'border-border bg-bg-surface text-text-muted'].join(' ')}>
    <tab.Icon className="h-4 w-4 shrink-0" aria-hidden /><span className="whitespace-nowrap">{tab.label}</span>
    {dirty ? <span role="img" aria-label="Unsaved changes" className="ml-0.5 h-1.5 w-1.5 rounded-full bg-accent-cyan" /> : null}
  </button>;
}
