"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { Badge } from "@/components/ui/Badge";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import {
  COMMAND_GUIDE_GROUPS, COMMAND_QUERY_MAX_CHARS, COMMAND_RESULTS_MAX, searchCommands, type CommandSearchItem,
} from "@/lib/commandSearch";
import { createCommandCatalog, type CommandCatalogOptions } from "@/lib/commandSearchCatalog";
import type {
  PrivateCommandChoice, PrivateCommandSearchResponse, PrivateSearchGroup, PrivateSearchMap, PrivateSearchUnavailableReason,
} from "@/lib/privateCommandSearch";

/** Personal maps filtered in the browser; replaces the server's deferred maps group. */
export type CommandPaletteMapsState = {
  phase: "idle" | "loading" | "ready" | "error"; group: PrivateSearchGroup<PrivateSearchMap> | null;
  partial: boolean; timedOut: boolean; choices: readonly PrivateCommandChoice[];
};
/** Recent games through the replay library. `validQuery` is false when the query is too long for it. */
export type CommandPaletteGamesState = {
  phase: "idle" | "debouncing" | "loading" | "ready" | "error"; validQuery: boolean; hasMore: boolean;
  timedOut: boolean; choices: readonly PrivateCommandChoice[];
};
export type CommandPalettePrivateState = {
  phase: "idle" | "debouncing" | "loading" | "ready" | "error";
  validQuery: boolean; data: PrivateCommandSearchResponse | null; choices: readonly PrivateCommandChoice[];
  maps?: CommandPaletteMapsState; games?: CommandPaletteGamesState;
  /** Retries every source that failed. */
  onRetry: () => void; onSelect: (choice: PrivateCommandChoice) => boolean;
};

/** Community builds for a signed-out viewer; rows come from the runtime's anonymous request. */
export type CommandPaletteCommunityState = {
  phase: "idle" | "debouncing" | "loading" | "ready" | "error"; items: readonly CommandSearchItem[];
  hasMore: boolean; onRetry: () => void;
};
export type CommandPaletteProps = CommandCatalogOptions & {
  initialQuery?: string;
  controlledQuery?: { value: string; onChange: (value: string) => void };
  privateSearch?: CommandPalettePrivateState;
  community?: CommandPaletteCommunityState;
  /** The /search page for this query, offered once a guide matches. */
  searchPageHref?: string | null;
  scope?: "all" | "guides";
  guideItems: readonly CommandSearchItem[];
  guidesStatus: "loading" | "ready" | "unavailable";
  onRetryGuides: () => void;
  onClose: () => void;
  onSelect: (item: CommandSearchItem) => boolean | void;
  returnFocusRef?: RefObject<HTMLElement | null>;
};
type PrivateItem = { id: string; group: string; label: string; href: string; privateChoice: PrivateCommandChoice;
  description?: string; matchup?: string; disabled?: never; action?: never };
type PaletteItem = CommandSearchItem | PrivateItem;
type PaletteGroup = { id: string; label: string; items: readonly PaletteItem[]; detail?: string };
type Choose = (item: PaletteItem) => void;
type Activate = (id: string) => void;
type KeyboardState = {
  enabled: readonly PaletteItem[]; activeId: string | null; onActive: Activate; onChoose: Choose;
};
const SHORTCUTS: CommandSearchItem = {
  id: "action:shortcuts", group: "actions", label: "Keyboard shortcuts", action: "shortcuts",
};

function boundedDraft(value: string): string {
  return Array.from(value.slice(0, COMMAND_QUERY_MAX_CHARS * 2)).slice(0, COMMAND_QUERY_MAX_CHARS).join("");
}

function optionId(base: string, id: string): string {
  return `${base}-option-${encodeURIComponent(id)}`;
}

function canChoose(item: PaletteItem): boolean {
  return !item.disabled && !!(item.href || item.action);
}

function ignoresPaletteKey(event: KeyboardEvent<HTMLInputElement>): boolean {
  return event.defaultPrevented || event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey;
}

function handlePaletteEnter(event: KeyboardEvent<HTMLInputElement>, state: KeyboardState): boolean {
  if (event.key !== "Enter") return false;
  if (event.repeat) return true;
  const active = state.enabled.find(item => item.id === state.activeId) ?? state.enabled[0];
  event.preventDefault();
  if (active) state.onChoose(active);
  return true;
}

function movePaletteActive(key: string, state: KeyboardState): boolean {
  const direction = key === "ArrowDown" ? 1 : key === "ArrowUp" ? -1 : 0;
  if (!direction) return false;
  const index = state.enabled.findIndex(item => item.id === state.activeId);
  const next = index < 0 ? (direction === 1 ? 0 : state.enabled.length - 1)
    : (index + direction + state.enabled.length) % state.enabled.length;
  if (state.enabled[next]) state.onActive(state.enabled[next].id);
  return true;
}

function movePaletteEdge(key: string, state: KeyboardState): boolean {
  if (state.activeId === null) return false;
  if (key !== "Home" && key !== "End") return false;
  const next = key === "Home" ? state.enabled[0] : state.enabled.at(-1);
  if (next) state.onActive(next.id);
  return true;
}

function handlePaletteKey(event: KeyboardEvent<HTMLInputElement>, state: KeyboardState): void {
  if (ignoresPaletteKey(event)) return;
  if (handlePaletteEnter(event, state)) return;
  if (movePaletteActive(event.key, state) || movePaletteEdge(event.key, state)) event.preventDefault();
}

function useActiveVisibility(list: RefObject<HTMLDivElement | null>, active: string | null): void {
  useEffect(() => {
    const container = list.current, row = active ? document.getElementById(active) : null;
    if (!container || !row || !container.contains(row)) return;
    const viewport = container.getBoundingClientRect(), box = row.getBoundingClientRect();
    if (box.top < viewport.top) container.scrollTop -= viewport.top - box.top;
    else if (box.bottom > viewport.bottom) container.scrollTop += box.bottom - viewport.bottom;
  }, [list, active]);
}

function ResultGroup({ group, base, activeId, onActive, onChoose }: {
  group: PaletteGroup; base: string; activeId: string | null; onActive: Activate; onChoose: Choose;
}) {
  const labelId = `${base}-group-${group.id}`;
  return <div role="group" aria-labelledby={labelId} className="min-w-0 py-1">
    <div id={labelId} className="px-3 py-2 text-caption font-semibold text-text-muted">{group.label}</div>
    {group.detail ? <p className="px-3 py-2 text-caption text-text-muted">{group.detail}</p> : null}
    {group.items.map(item => <button key={item.id} id={optionId(base, item.id)} type="button" role="option"
      tabIndex={-1} aria-selected={false} aria-disabled={!canChoose(item) || undefined}
      onPointerDown={event => event.preventDefault()}
      onPointerMove={() => { if (canChoose(item)) onActive(item.id); }} onClick={() => onChoose(item)}
      className={[
        "flex min-h-11 w-full min-w-0 flex-col gap-1 rounded-md px-3 py-2 text-left text-text",
        activeId === item.id ? "bg-bg-elevated outline outline-2 -outline-offset-2 outline-accent" : "",
        canChoose(item) ? "hover:bg-bg-elevated" : "cursor-default",
      ].join(" ")}>
      <span className="flex w-full min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
        {/* An unpublished guide stays listed, unlinked and greyed, with its reason. */}
        <span className={`min-w-0 break-words text-body font-medium ${canChoose(item) ? "" : "text-text-muted"}`}>{item.label}</span>
        {item.matchup ? <Badge size="sm">{item.matchup}</Badge> : null}
      </span>
      {item.description ? <span className="break-words text-caption text-text-muted">{item.description}</span> : null}
    </button>)}
  </div>;
}

/** Whether the library search is still running, was not complete, or failed in a way Retry can fix. */
function privateStatus(state: CommandPalettePrivateState) {
  const { maps, games } = state, local = maps && maps.phase !== "idle" ? maps : undefined;
  // Any unavailable group (deferred included) means the library was not fully searched, so an empty
  // result is "No public matches". Only a failure offers Retry: "deferred" is a lasting product state.
  const groups = state.data ? Object.entries(state.data.groups).filter(([key]) => !local || key !== "maps").map(([, group]) => group) : [];
  const localUnavailable = local?.phase === "ready" && local.group?.status === "unavailable";
  // Recent games skip a query the replay library would cut, so nothing there was searched.
  const gamesFailed = !!games?.validQuery && games.phase === "error", gamesSkipped = !!games && !games.validQuery;
  return {
    pending: state.validQuery && (["debouncing", "loading"].includes(state.phase) || local?.phase === "loading"
      || (!!games?.validQuery && ["debouncing", "loading"].includes(games.phase))),
    incomplete: state.phase === "error" || groups.some(group => group.status === "unavailable") || gamesFailed || gamesSkipped
      || (!!local && (local.phase !== "ready" || localUnavailable || local.partial)),
    unavailable: state.phase === "error" || groups.some(group => group.status === "unavailable" && group.reason !== "deferred")
      || gamesFailed || local?.phase === "error" || localUnavailable,
  };
}

function PaletteStatus({ count, enabled, query, status, onRetry, id, privateSearch, community }: {
  count: number; enabled: number; query: string; status: CommandPaletteProps["guidesStatus"];
  onRetry: () => void; id: string; privateSearch?: CommandPalettePrivateState; community?: CommandPaletteCommunityState;
}) {
  const own = privateSearch?.validQuery ? privateStatus(privateSearch) : null;
  const privatePending = !!own?.pending, privateIncomplete = !!own?.incomplete, privateUnavailable = !!own?.unavailable;
  const communityPending = community?.phase === "debouncing" || community?.phase === "loading";
  const communityFailed = community?.phase === "error";
  const result = count ? `${count} results, ${enabled} available.`
    : privateSearch && (!privateSearch.validQuery || privatePending || privateIncomplete) ? "No public matches."
      : communityPending || communityFailed ? "No page or guide matches yet."
        : query.trim() ? "No matching results. Try another word." : "No results available.";
  const guides = status === "loading" ? " Loading guide availability."
    : status === "unavailable" ? " Guide availability is unavailable." : "";
  return <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
    <p id={id} role="status" aria-live="polite" aria-atomic="true" className="text-caption text-text-muted">
      {result}{guides}{privateSearch && !privateSearch.validQuery ? " Enter at least 2 valid characters to search your library."
        : privatePending ? " Searching your library…" : privateUnavailable ? " Some library results are unavailable." : ""}
      {communityPending ? " Searching community builds…" : communityFailed ? " Community builds are unavailable." : ""}
    </p>
    {status === "unavailable" ? <button type="button" onClick={onRetry}
      className="min-h-11 rounded-md px-3 text-caption font-semibold text-accent underline
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
      Retry guide availability
    </button> : null}
    {privateUnavailable ? <button type="button" onClick={privateSearch!.onRetry}
      className="min-h-11 rounded-md px-3 text-caption font-semibold text-accent underline
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Retry your library search</button> : null}
    {communityFailed ? <button type="button" onClick={community!.onRetry}
      className="min-h-11 rounded-md px-3 text-caption font-semibold text-accent underline
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Retry community builds</button> : null}
  </div>;
}

const OPEN_COMMUNITY: CommandSearchItem = { id: "action:community-builds", group: "actions", label: "Open Community builds", href: "/community" };
function communityGroup(state?: CommandPaletteCommunityState): PaletteGroup | null {
  if (!state || state.phase === "idle") return null;
  const detail = state.phase === "error" ? "Community builds are unavailable right now."
    : state.phase !== "ready" ? "Searching community builds…"
      : !state.items.length ? "No matching community builds." : state.hasMore ? "More matches on Community builds." : undefined;
  return { id: "community-builds", label: "Community builds", items: state.phase === "ready" ? state.items : [], detail };
}

const PRIVATE_GROUPS = [
  { key: "opponents", id: "your-opponents", label: "Your opponents", empty: "No matching opponents." },
  { key: "customBuilds", id: "your-builds", label: "Your builds", empty: "No matching saved builds." },
  { key: "maps", id: "your-maps", label: "Your maps", empty: "No matching maps." },
] as const;
const PRIVATE_REASONS: Record<PrivateSearchUnavailableReason, string> = {
  source_budget_exceeded: "This library is too large for quick search.", invalid_data: "Some library entries could not be searched.",
  deferred: "Not in quick search yet. Open the full library to browse it.", missing_access_path: "Quick search is unavailable for this library.",
  deadline: "This library search took too long.", busy: "This library search is busy.", retired: "This library changed during search. Search again.",
};
const LIBRARY_ITEMS: readonly CommandSearchItem[] = [
  { id: "library:opponents", group: "actions", label: "Open Opponents", href: "/app/opponents" },
  { id: "library:customBuilds", group: "actions", label: "Open Build library", href: "/builds" },
  { id: "library:maps", group: "actions", label: "Open Maps", href: "/app/maps" },
];
const GAMES_LIBRARY: CommandSearchItem = { id: "library:games", group: "actions", label: "Open Replays", href: "/app/replays" };
const MORE = "More matches are available in the full library.";
function rows(choices: readonly PrivateCommandChoice[], key: PrivateCommandChoice["group"], id: string): PrivateItem[] {
  return choices.filter(choice => choice.group === key).map(choice => ({ id: `${id}:${choice.href}`, group: id,
    label: choice.label, href: choice.href, privateChoice: choice, description: choice.description, matchup: choice.matchup }));
}
function localMapsDetail(maps: CommandPaletteMapsState, items: readonly PrivateItem[]): string | undefined {
  if (maps.phase === "loading") return "Loading your maps…";
  if (maps.phase === "error") return maps.timedOut ? "Your maps took too long to load." : "Your maps could not load. Try again or open Maps.";
  if (maps.group?.status === "unavailable") return PRIVATE_REASONS[maps.group.reason];
  if (maps.partial) return PRIVATE_REASONS.invalid_data;
  return !items.length ? "No matching maps." : maps.group?.hasMore ? MORE : undefined;
}
function gamesGroup(games: CommandPaletteGamesState): PaletteGroup {
  const items = games.validQuery ? rows(games.choices, "games", "your-games") : [];
  const detail = !games.validQuery ? "Use a shorter search to find games."
    : games.phase === "error" ? games.timedOut ? "Recent games took too long." : "Recent games are unavailable. Try again or open Replays."
      : games.phase !== "ready" ? "Searching your latest games…"
        : !items.length ? "No matching games among your latest 1,000." : games.hasMore ? "More matching games are in Replays." : undefined;
  return { id: "your-games", label: "Recent games", items, detail };
}
function privateGroups(state?: CommandPalettePrivateState): PaletteGroup[] {
  if (!state?.validQuery || (state.phase !== "ready" && state.phase !== "error")) return [];
  const groups: PaletteGroup[] = PRIVATE_GROUPS.map(meta => {
    const local = meta.key === "maps" && state.maps && state.maps.phase !== "idle" ? state.maps : undefined;
    const items = rows(local ? local.choices : state.choices, meta.key, meta.id);
    if (local) return { id: meta.id, label: meta.label, items, detail: localMapsDetail(local, items) };
    const group = state.data?.groups[meta.key];
    const detail = !group ? "This library search is unavailable. Try again or open the full library."
      : group.status === "unavailable" ? PRIVATE_REASONS[group.reason]
        : !items.length ? meta.empty : group.hasMore ? MORE : undefined;
    return { id: meta.id, label: meta.label, items, detail };
  });
  return state.games ? [...groups, gamesGroup(state.games)] : groups;
}

function PaletteFooter({ onChoose }: { onChoose: Choose }) {
  return <>
    <span className="min-w-0 flex-1 break-words text-caption text-text-muted">
      ↑↓ move · Enter open · Esc close · ? shortcuts
    </span>
    <button type="button" onClick={() => onChoose(SHORTCUTS)}
      className="min-h-11 rounded-md px-3 text-caption font-semibold text-accent underline
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
      Keyboard shortcuts
    </button>
  </>;
}

/** Lazy mounted dialog; its caller owns navigation, guards and handoffs.
 * Example: <CommandPalette {...catalogOptions} guideItems={guides} onSelect={select} {...callbacks} />. */
export function CommandPalette({ navigation, settingsTabs, signedIn, initialQuery = "", controlledQuery, privateSearch, community,
  searchPageHref, scope = "all", guideItems, guidesStatus, onRetryGuides, onClose, onSelect, returnFocusRef }: CommandPaletteProps) {
  const base = useId(), input = useRef<HTMLInputElement>(null), list = useRef<HTMLDivElement>(null);
  const selected = useRef(false);
  const [localQuery, setQuery] = useState(() => boundedDraft(initialQuery));
  const query = controlledQuery?.value ?? localQuery;
  const [activeId, setActiveId] = useState<string | null>(null);
  const catalog = useMemo(() => createCommandCatalog({ navigation, settingsTabs, signedIn }),
    [navigation, settingsTabs, signedIn]);
  const publicGroups = useMemo(() => searchCommands([...catalog, ...guideItems], query,
    scope === "guides" ? COMMAND_GUIDE_GROUPS : undefined), [catalog, guideItems, query, scope]);
  const personal = scope === "all" && signedIn ? privateSearch : undefined;
  const ownGroups = privateGroups(personal);
  const libraries = personal ? personal.games ? [...LIBRARY_ITEMS, GAMES_LIBRARY] : LIBRARY_ITEMS : [];
  const publicCommunity = signedIn ? null : communityGroup(community), withCommunity = publicCommunity ? [publicCommunity] : [];
  const guideMatch = publicGroups.some(group => COMMAND_GUIDE_GROUPS.includes(group.id) && group.items.some(canChoose));
  const more: CommandSearchItem[] = [
    ...(publicCommunity && (community?.phase === "error" || community?.hasMore) ? [OPEN_COMMUNITY] : []),
    ...(searchPageHref && guideMatch ? [{ id: "search:all", group: "actions" as const, label: "See all guide results",
      description: "Published guides for this search on one page", href: searchPageHref }] : []),
  ];
  // Reserve every server row and the fixed library actions first. Only static
  // public rows are clipped; private and Community rows are never normalized or re-scored.
  let remaining = COMMAND_RESULTS_MAX - [...ownGroups, ...withCommunity].reduce((count, group) => count + group.items.length, 0)
    - libraries.length - more.length;
  const groups: PaletteGroup[] = publicGroups.flatMap(group => {
    const items = group.items.slice(0, Math.max(0, remaining)); remaining -= items.length;
    return items.length ? [{ ...group, items }] : [];
  });
  groups.push(...ownGroups, ...withCommunity);
  const matchingRows = groups.flatMap(group => group.items);
  if (libraries.length) groups.push({ id: "your-library", label: "Your library", items: libraries });
  if (more.length) groups.push({ id: "more", label: "More", items: more });
  const rows = groups.flatMap(group => group.items), enabled = rows.filter(canChoose);
  const active = enabled.find(item => item.id === activeId) ?? enabled[0];
  const activeDomId = active ? optionId(base, active.id) : undefined;
  useActiveVisibility(list, activeId !== null ? activeDomId ?? null : null);
  const choose = (item: PaletteItem) => {
    if (selected.current || !canChoose(item)) return;
    selected.current = true;
    input.current?.focus({ preventScroll: true });
    const accepted = "privateChoice" in item ? personal?.onSelect(item.privateChoice) : onSelect(item);
    if (accepted === false) selected.current = false;
  };
  return <Modal open title={scope === "guides" ? "Find a guide" : "Search SC2 Tools"} onClose={onClose}
    initialFocusRef={input} returnFocusRef={returnFocusRef} size="lg" mobileLayout="center"
    footer={<PaletteFooter onChoose={choose} />}>
    <div className="min-w-0 space-y-3">
      <Input ref={input} type="text" role="combobox" aria-label={scope === "guides" ? "Find a guide" : "Search"}
        aria-controls={`${base}-list`} aria-expanded={true} aria-autocomplete="list"
        aria-activedescendant={activeDomId} aria-describedby={`${base}-status`}
        autoComplete="off" spellCheck={false} maxLength={COMMAND_QUERY_MAX_CHARS * 2}
        className="min-h-12" placeholder={scope === "guides" ? "Build, matchup or map…" : "Find a page, guide or library item…"}
        value={query} onChange={event => {
          const value = boundedDraft(event.target.value); selected.current = false;
          if (controlledQuery) controlledQuery.onChange(value); else setQuery(value);
          setActiveId(null);
        }}
        onKeyDown={event => handlePaletteKey(event, { enabled, activeId, onActive: setActiveId, onChoose: choose })} />
      <PaletteStatus count={matchingRows.length} enabled={matchingRows.filter(canChoose).length} query={query} status={guidesStatus}
        onRetry={onRetryGuides} id={`${base}-status`} privateSearch={personal} community={signedIn ? undefined : community} />
      <div ref={list} id={`${base}-list`} role="listbox" aria-label="Search results"
        className="relative max-h-[45dvh] min-w-0 space-y-1 overflow-y-auto overscroll-contain rounded-md">
        {groups.map(group => <ResultGroup key={group.id} group={group} base={base} activeId={active?.id ?? null}
          onActive={setActiveId} onChoose={choose} />)}
      </div>
    </div>
  </Modal>;
}
