"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import {
  COMMAND_QUERY_MAX_CHARS, searchCommands, type CommandSearchGroup, type CommandSearchGroupId,
  type CommandSearchItem,
} from "@/lib/commandSearch";
import { createCommandCatalog, type CommandCatalogOptions } from "@/lib/commandSearchCatalog";

export type CommandPaletteProps = CommandCatalogOptions & {
  initialQuery?: string;
  scope?: "all" | "guides";
  guideItems: readonly CommandSearchItem[];
  guidesStatus: "loading" | "ready" | "unavailable";
  onRetryGuides: () => void;
  onClose: () => void;
  onSelect: (item: CommandSearchItem) => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
};
type Choose = (item: CommandSearchItem) => void;
type Activate = (id: string) => void;
type KeyboardState = {
  enabled: readonly CommandSearchItem[]; activeId: string | null; onActive: Activate; onChoose: Choose;
};
const GUIDE_GROUPS: readonly CommandSearchGroupId[] = ["guide-openers", "guide-counters", "guide-maps"];
const SHORTCUTS: CommandSearchItem = {
  id: "action:shortcuts", group: "actions", label: "Keyboard shortcuts", action: "shortcuts",
};

function boundedDraft(value: string): string {
  return Array.from(value.slice(0, COMMAND_QUERY_MAX_CHARS * 2)).slice(0, COMMAND_QUERY_MAX_CHARS).join("");
}

function optionId(base: string, id: string): string {
  return `${base}-option-${encodeURIComponent(id)}`;
}

function canChoose(item: CommandSearchItem): boolean {
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
  group: CommandSearchGroup; base: string; activeId: string | null; onActive: Activate; onChoose: Choose;
}) {
  const labelId = `${base}-group-${group.id}`;
  return <div role="group" aria-labelledby={labelId} className="min-w-0 py-1">
    <div id={labelId} className="px-3 py-2 text-caption font-semibold text-text-muted">{group.label}</div>
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
        <span className="min-w-0 break-words text-body font-medium">{item.label}</span>
        {item.matchup ? <span className="text-caption text-text-muted">{item.matchup}</span> : null}
      </span>
      {item.description ? <span className="break-words text-caption text-text-muted">{item.description}</span> : null}
    </button>)}
  </div>;
}

function PaletteStatus({ count, enabled, query, status, onRetry, id }: {
  count: number; enabled: number; query: string; status: CommandPaletteProps["guidesStatus"];
  onRetry: () => void; id: string;
}) {
  const result = count ? `${count} results, ${enabled} available.`
    : query.trim() ? "No matching results. Try another word." : "No results available.";
  const guides = status === "loading" ? " Loading guide availability."
    : status === "unavailable" ? " Guide availability is unavailable." : "";
  return <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
    <p id={id} role="status" aria-live="polite" aria-atomic="true" className="text-caption text-text-muted">
      {result}{guides}
    </p>
    {status === "unavailable" ? <button type="button" onClick={onRetry}
      className="min-h-11 rounded-md px-3 text-caption font-semibold text-accent underline
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
      Retry guide availability
    </button> : null}
  </div>;
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
export function CommandPalette({ navigation, settingsTabs, signedIn, initialQuery = "", scope = "all",
  guideItems, guidesStatus, onRetryGuides, onClose, onSelect, returnFocusRef }: CommandPaletteProps) {
  const base = useId(), input = useRef<HTMLInputElement>(null), list = useRef<HTMLDivElement>(null);
  const selected = useRef(false);
  const [query, setQuery] = useState(() => boundedDraft(initialQuery));
  const [activeId, setActiveId] = useState<string | null>(null);
  const catalog = useMemo(() => createCommandCatalog({ navigation, settingsTabs, signedIn }),
    [navigation, settingsTabs, signedIn]);
  const groups = useMemo(() => searchCommands([...catalog, ...guideItems], query,
    scope === "guides" ? GUIDE_GROUPS : undefined), [catalog, guideItems, query, scope]);
  const rows = groups.flatMap(group => group.items), enabled = rows.filter(canChoose);
  const active = enabled.find(item => item.id === activeId) ?? enabled[0];
  const activeDomId = active ? optionId(base, active.id) : undefined;
  useActiveVisibility(list, activeId !== null ? activeDomId ?? null : null);
  const choose = (item: CommandSearchItem) => {
    if (selected.current || !canChoose(item)) return;
    selected.current = true;
    input.current?.focus({ preventScroll: true });
    onSelect(item);
  };
  return <Modal open title={scope === "guides" ? "Find a guide" : "Search SC2 Tools"} onClose={onClose}
    initialFocusRef={input} returnFocusRef={returnFocusRef} size="lg" mobileLayout="center"
    footer={<PaletteFooter onChoose={choose} />}>
    <div className="min-w-0 space-y-3">
      <Input ref={input} type="text" role="combobox" aria-label={scope === "guides" ? "Find a guide" : "Search"}
        aria-controls={`${base}-list`} aria-expanded={true} aria-autocomplete="list"
        aria-activedescendant={activeDomId} aria-describedby={`${base}-status`}
        autoComplete="off" spellCheck={false} maxLength={COMMAND_QUERY_MAX_CHARS * 2}
        className="min-h-12" placeholder={scope === "guides" ? "Build, matchup or map…" : "Find a page or guide…"}
        value={query} onChange={event => { setQuery(boundedDraft(event.target.value)); setActiveId(null); }}
        onKeyDown={event => handlePaletteKey(event, { enabled, activeId, onActive: setActiveId, onChoose: choose })} />
      <PaletteStatus count={rows.length} enabled={enabled.length} query={query} status={guidesStatus}
        onRetry={onRetryGuides} id={`${base}-status`} />
      <div ref={list} id={`${base}-list`} role="listbox" aria-label="Search results"
        className="relative max-h-[45dvh] min-w-0 space-y-1 overflow-y-auto overscroll-contain rounded-md">
        {groups.map(group => <ResultGroup key={group.id} group={group} base={base} activeId={active?.id ?? null}
          onActive={setActiveId} onChoose={choose} />)}
      </div>
    </div>
  </Modal>;
}
