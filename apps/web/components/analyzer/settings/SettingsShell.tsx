"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { InstallAppButton } from "@/components/pwa/InstallAppButton";

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
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
} from "lucide-react";
import { Tabs, useTabIds } from "@/components/ui/Tabs";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useDocumentTitle } from "@/lib/useDocumentTitle";
import {
  SETTINGS_GROUPS,
  SETTINGS_TABS,
  defaultTabVisibility,
  settingsTabForLegacyHash,
  type SettingsTabId,
} from "@/lib/settingsRegistry";
import {
  SettingsContextProvider,
  useSettingsContext,
} from "./SettingsContext";
import { revealSectionAnchor } from "./revealSectionAnchor";

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
  overlay: MonitorPlay, voice: Volume2, preferences: Settings2, help: LifeBuoy,
};
const TABS = SETTINGS_TABS.map((tab) => ({ ...tab, Icon: TAB_ICONS[tab.id] }));
type TabDef = (typeof TABS)[number];
type PendingDestination =
  | { kind: "tab"; tab: SettingsTabId; fromUrl: boolean }
  | { kind: "devices" };

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
}

export function SettingsShell({
  initialTab = "account",
  renderTab,
  isTabVisible = defaultTabVisibility,
}: SettingsShellProps) {
  return (
    <SettingsContextProvider>
      <SettingsShellInner
        initialTab={initialTab}
        renderTab={renderTab}
        isTabVisible={isTabVisible}
      />
    </SettingsContextProvider>
  );
}

function SettingsShellInner({
  initialTab,
  renderTab,
  isTabVisible,
}: Required<SettingsShellProps>) {
  const router = useRouter();
  const tabs = TABS.filter((t) => isTabVisible(t.id));
  const [active, setActive] = useState<SettingsTabId>(() =>
    tabs.some((t) => t.id === initialTab) ? initialTab : (tabs[0]?.id ?? initialTab),
  );
  // `fromUrl`: the URL already names the target, so it isn't rewritten
  // (that would drop a `#section` anchor the target tab scrolls to).
  const [pending, setPending] = useState<PendingDestination | null>(
    null,
  );
  const ctx = useSettingsContext();
  const lastRequested = useRef(initialTab);
  // "Overlay · Settings · SC2 Tools": the browser tab (and a bookmark of
  // the ?tab= URL) names the settings tab that is open.
  const activeLabel = tabs.find((t) => t.id === active)?.label;
  useDocumentTitle(activeLabel ? `${activeLabel} · Settings` : null);
  const previousInitialTab = useRef(initialTab);

  const activate = (tab: SettingsTabId, fromUrl: boolean) => {
    setActive(tab);
    // The shown tab is now the last one asked for, so a later link back
    // to the previous tab is a change even before the URL catches up.
    lastRequested.current = tab;
    if (!fromUrl) writeTabToUrl(tab);
  };

  const requestSwitch = (next: string, fromUrl = false) => {
    const target = next as SettingsTabId;
    if (target === active) return;
    if (ctx.isDirty(active)) {
      setPending({ kind: "tab", tab: target, fromUrl });
      return;
    }
    activate(target, fromUrl);
  };

  // A search-param-only navigation keeps this component mounted, so a
  // link to another tab arrives as a new `initialTab`. Don't remount the
  // shell for it: that would drop unsaved edits without asking.
  useEffect(() => {
    // Only a new value is a new request; the mount run is not (an old
    // `#tab` link may already have opened another tab by then).
    if (initialTab === previousInitialTab.current) return;
    previousInitialTab.current = initialTab;
    if (initialTab === lastRequested.current) return;
    lastRequested.current = initialTab;
    if (tabs.some((t) => t.id === initialTab)) requestSwitch(initialTab, true);
    // Only a changed request matters; the guard reads the current tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTab]);

  // Old `/settings#overlay` links (from before `?tab=`): open the tab
  // and rewrite the URL to `?tab=overlay` before the first paint. Checks
  // again on later renders until it has decided, because a tab can
  // appear late (Import waits on a feature flag).
  const legacyHashHandled = useRef(false);
  useLayoutEffect(() => {
    if (legacyHashHandled.current) return;
    const url = new URL(window.location.href);
    const legacyTab = url.searchParams.has("tab") ? null : settingsTabForLegacyHash(url.hash);
    if (legacyTab === null) {
      legacyHashHandled.current = true;
      return;
    }
    if (!tabs.some((t) => t.id === legacyTab)) return;
    legacyHashHandled.current = true;
    url.searchParams.set("tab", legacyTab);
    url.hash = "";
    window.history.replaceState(null, "", url);
    // When the rewritten URL comes back as `initialTab`, the tab is
    // already the last one asked for.
    lastRequested.current = legacyTab;
    requestSwitch(legacyTab, true);
  });

  // `#section` anchors: once the tab is showing, scroll to the section
  // and highlight it, and again whenever the anchor changes. Help opens
  // its own article anchors.
  const [anchorChanges, setAnchorChanges] = useState(0);
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
    const panel = document.querySelector<HTMLElement>(`[data-settings-panel="${panelScopeId}-${active}"]`);
    if (!panel) return undefined;
    return revealSectionAnchor(window.location.hash, panel);
  }, [active, anchorChanges, panelScopeId]);

  const confirmDiscard = () => {
    if (pending) {
      setPending(null);
      if (pending.kind === "devices") router.push("/devices");
      else activate(pending.tab, pending.fromUrl);
    }
  };

  const stay = () => {
    // A link asked for another tab but the player kept their edits: put
    // the URL back on the tab that is actually showing.
    if (pending?.kind === "tab" && pending.fromUrl) writeTabToUrl(active);
    setPending(null);
  };

  return (
    <>
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
                    setPending({ kind: "devices" });
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

        {tabs.map((t) => (
          <Tabs.Content
            key={t.id}
            value={t.id}
            data-settings-panel={`${panelScopeId}-${t.id}`}
            className="space-y-5 pb-24"
          >
            {renderTab(t.id)}
          </Tabs.Content>
        ))}
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

/**
 * Keep `?tab=` in step with the tab on screen so a refresh, a copied URL
 * or a later link to the same tab behaves. Replaces the history entry:
 * switching tabs isn't a navigation.
 */
function writeTabToUrl(tab: SettingsTabId): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (url.searchParams.get("tab") === tab) return;
  url.searchParams.set("tab", tab);
  url.hash = "";
  window.history.replaceState(null, "", url);
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
    <div ref={scroller} role="tablist" aria-label="Settings sections" aria-orientation="horizontal" onScroll={measure}
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
