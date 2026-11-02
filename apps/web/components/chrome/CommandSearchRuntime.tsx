"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { Modal } from "@/components/ui/Modal";
import { ThemeDialog } from "@/components/ui/ThemeChoice";
import { LazyReportIssueModal } from "@/components/feedback/LazyReportIssueModal";
import { visibleSettingsTabs, type SettingsTabId } from "@/lib/settingsRegistry";
import { guidesEnabled } from "@/lib/guides/flags";
import { loadCommandGuideMetadata, type CommandGuideMetadata } from "@/lib/commandGuideMetadata";
import { commandGuideQueryMatchup, createCommandGuideCatalog } from "@/lib/commandGuideSearch";
import { readCommandSearchRecentEntries } from "@/lib/commandSearchRecent";
import { commandPrivateHref } from "@/lib/commandSearchActivation";
import type { CommandPrivateTarget } from "@/lib/commandSearchTarget";
import { COMMAND_GO_KEYS } from "@/lib/useCommandSearchShortcuts";
import { COMMAND_QUERY_MAX_CHARS, type CommandSearchItem } from "@/lib/commandSearch";
import { privateCommandQuery, type PrivateCommandChoice } from "@/lib/privateCommandSearch";
import { recentGamesQuery } from "@/lib/recentGamesCommandSearch";
import { usePrivateCommandSearch, type PrivateCommandSelectionDraft } from "@/lib/usePrivateCommandSearch";
import { usePrivateMapSearch } from "@/lib/usePrivateMapSearch";
import { useRecentGamesCommandSearch } from "@/lib/useRecentGamesCommandSearch";
import { useCommunityCommandSearch } from "@/lib/useCommunityCommandSearch";
import { publicSearchHref } from "@/lib/publicSearchQuery";
import type { CommandFrame } from "./CommandSearchProvider";
import type { CommandNavigation } from "./CommandSearchContext";
import { CommandPalette } from "./CommandPalette";

export { commandActivationPolicy } from "@/lib/commandSearchActivation";

type Props = {
  frame: CommandFrame; navigation: readonly CommandNavigation[]; settingsTabs?: readonly SettingsTabId[];
  allowDefaultSettings?: boolean;
  onClose: () => void; onSelect: (item: CommandSearchItem) => boolean | void;
  onQueryEdit: () => object | null;
  onPrivateSelect: (draft: PrivateCommandSelectionDraft, queryEpoch: object) => boolean;
};
type GuideState = { status: "loading" | "ready" | "unavailable"; data: CommandGuideMetadata | null };

function useGuideMetadata() {
  const enabled = guidesEnabled(), [retry, setRetry] = useState(0);
  const [state, setState] = useState<GuideState>({ status: enabled ? "loading" : "ready", data: null });
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController(); let current = true;
    setState({ status: "loading", data: null });
    void loadCommandGuideMetadata({ signal: controller.signal, force: retry > 0 }).then(data => {
      if (current) setState({ status: "ready", data });
    }).catch(() => { if (current) setState({ status: "unavailable", data: null }); });
    return () => { current = false; controller.abort(); };
  }, [enabled, retry]);
  const items = useMemo(() => {
    if (!enabled) return [];
    const rows = createCommandGuideCatalog({ publishedPaths: state.data?.publishedPaths ?? null,
      maps: state.data?.maps ?? [] });
    return state.status === "loading" ? rows.map(row => ({ ...row, description: "Checking guide availability…" })) : rows;
  }, [enabled, state]);
  return { ...state, items, retry: () => setRetry(value => value + 1) };
}

function PaletteRuntime({ frame, navigation, settingsTabs, allowDefaultSettings, onClose, onSelect, onQueryEdit, onPrivateSelect }: Props) {
  const guides = useGuideMetadata(), returnFocusRef = useRef(frame.returnFocus ?? null);
  const [query, setQuery] = useState(() => {
    const initial = frame.scope === "guides"
      ? `${commandGuideQueryMatchup(frame.query ?? "") ? "" : frame.defaultMatchup ?? ""} ${frame.query ?? ""}`.trim()
      : frame.query ?? "";
    return { epoch: frame as object,
      value: Array.from(initial.slice(0, COMMAND_QUERY_MAX_CHARS * 2)).slice(0, COMMAND_QUERY_MAX_CHARS).join("") };
  });
  const owned = { open: true, scope: frame.scope ?? "all", query: query.value,
    ownerKey: frame.owner.key, openingEpoch: frame, routeEpoch: frame.route } as const;
  const privateSearch = usePrivateCommandSearch(owned), games = useRecentGamesCommandSearch(owned), maps = usePrivateMapSearch(owned);
  // Public discovery: signed out means authentication has loaded with no user. Only an explicit edit
  // sends Community's anonymous request, and only a guide query, or a viewer known to be signed out,
  // gets the /search page link, so a signed-in private query never reaches a URL.
  const auth = useAuth(), signedOut = auth.isLoaded && !auth.isSignedIn;
  const community = useCommunityCommandSearch({ open: true, scope: frame.scope ?? "all", query: query.value,
    typed: query.epoch !== frame, signedOut });
  const searchPageHref = guidesEnabled() && (frame.scope === "guides" || signedOut) ? publicSearchHref(query.value) : null;
  const draft = (choice: PrivateCommandChoice) => choice.group === "games" ? games.selectionDraft(choice)
    : choice.group === "maps" && maps.phase !== "idle" ? maps.selectionDraft(choice) : privateSearch.selectionDraft(choice);
  // Recent lists pages and opened dossiers in visit order. A dossier row stores no name: it reads
  // "Opponent dossier" and opens through the same guarded handoff as a private result.
  const recent = useMemo(() => {
    const keys = navigation.map(row => row.key), dossiers = new Map<string, Extract<CommandPrivateTarget, { kind: "opponent" }>>();
    const items = readCommandSearchRecentEntries(frame.owner.key, keys).flatMap((entry): CommandSearchItem[] => {
      if (entry.kind === "page") {
        const row = navigation.find(nav => nav.key === entry.id);
        return row ? [{ id: `recent:${row.key}`, group: "recent", label: row.label, description: row.description, href: row.href }] : [];
      }
      const target = Object.freeze({ kind: "opponent" as const, pulseId: entry.pulseId }), href = commandPrivateHref(target);
      if (!href) return [];
      const id = `recent:opponent:${entry.pulseId}`;
      dossiers.set(id, target);
      return [{ id, group: "recent", label: "Opponent dossier", description: `Pulse ID ${entry.pulseId}`, href }];
    });
    return { keys, items, dossiers };
  }, [frame.owner, navigation]);
  const selectRecent = (item: CommandSearchItem) => {
    const target = recent.dossiers.get(item.id);
    if (!target || !item.href) return onSelect(item);
    const stored = () => readCommandSearchRecentEntries(frame.owner.key, recent.keys)
      .some(entry => entry.kind === "opponent" && entry.pulseId === target.pulseId);
    return onPrivateSelect(Object.freeze({ target, href: item.href, isCurrent: stored }), query.epoch);
  };
  return <CommandPalette navigation={navigation} signedIn={Boolean(frame.owner.key)}
    settingsTabs={settingsTabs ?? (frame.owner.key && allowDefaultSettings ? visibleSettingsTabs() : [])}
    controlledQuery={{ value: query.value, onChange: value => {
      const epoch = onQueryEdit(); if (epoch) setQuery({ value, epoch });
    } }}
    privateSearch={frame.owner.key && frame.scope !== "guides" ? {
      phase: privateSearch.phase, data: privateSearch.data, choices: privateSearch.choices,
      validQuery: privateCommandQuery(query.value) !== null,
      maps: { phase: maps.phase, group: maps.group, partial: maps.partial, timedOut: maps.timedOut, choices: maps.choices },
      games: { phase: games.phase, validQuery: recentGamesQuery(query.value) !== null, hasMore: games.data?.hasMore === true,
        timedOut: games.error?.code === "request_timeout", choices: games.choices },
      onRetry: () => {
        if (privateSearch.phase === "error" || Object.values(privateSearch.data?.groups ?? {})
          .some(group => group.status === "unavailable" && group.reason !== "deferred")) privateSearch.retry();
        if (games.phase === "error") games.retry();
        maps.retry();
      },
      onSelect: choice => {
        const selected = draft(choice);
        return !!selected && onPrivateSelect(selected, query.epoch);
      },
    } : undefined}
    community={signedOut && !frame.owner.key ? { phase: community.phase, items: community.items, hasMore: community.hasMore,
      onRetry: community.retry } : undefined}
    searchPageHref={searchPageHref}
    scope={frame.scope} guideItems={[...recent.items, ...guides.items]}
    guidesStatus={guides.status} onRetryGuides={guides.retry} onClose={onClose} onSelect={selectRecent}
    returnFocusRef={returnFocusRef} />;
}

function Shortcuts({ frame, navigation, onClose }: Props) {
  const returnFocusRef = useRef(frame.returnFocus ?? null);
  return <Modal open title="Keyboard shortcuts" onClose={onClose} returnFocusRef={returnFocusRef}>
    <dl className="space-y-3 text-body">
      <div><dt className="font-semibold">Ctrl K or ⌘ K</dt><dd>Open quick search outside a field.</dd></div>
      <div><dt className="font-semibold">/</dt><dd>Focus this page’s search, or open quick search.</dd></div>
      <div><dt className="font-semibold">?</dt><dd>Open this sheet outside a field. The replay player keeps its own help.</dd></div>
      {Object.entries(COMMAND_GO_KEYS).flatMap(([key, id]) => {
        const entry = navigation.find(row => row.key === id);
        return entry ? [<div key={key}><dt className="font-semibold">g then {key}</dt><dd>Open {entry.label}.</dd></div>] : [];
      })}
    </dl>
    <p className="mt-4 text-caption text-text-muted">In search: ↑↓ move, Enter opens, Escape closes.
      Shortcuts leave editing fields and other dialogs alone.</p>
  </Modal>;
}

/** Imported only by an explicit opening; no catalog or guide request in closed chrome. */
export default function CommandSearchRuntime(props: Props) {
  if (props.frame.mode === "palette") return <PaletteRuntime {...props} />;
  if (props.frame.mode === "report") return <LazyReportIssueModal open prefill={{ type: "problem" }} onClose={props.onClose} />;
  if (props.frame.mode === "theme") return <ThemeDialog open onClose={props.onClose} />;
  return <Shortcuts {...props} />;
}
