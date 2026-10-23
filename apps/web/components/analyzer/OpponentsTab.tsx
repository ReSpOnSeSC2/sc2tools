"use client";

import { Fragment, memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import Link from "next/link";
import {
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  ExternalLink,
  Search,
  StickyNote,
  X,
} from "lucide-react";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { useApi } from "@/lib/clientApi";
import { useApiPaginated } from "@/lib/useApiPaginated";
import { PlayerChannelLinks, type PlayerChannels } from "./PlayerChannelLinks";
import { usePlayerChannels } from "./usePlayerChannels";
import { useLocalStoragePositiveInt, useLocalStorageState } from "@/lib/useLocalStorageState";
import { fmtAgo, fmtMmr, pct1, wrColor } from "@/lib/format";
import { pickPulseLabel, sc2pulseCharacterUrl } from "@/lib/sc2pulse";
import {
  groupMatchesSearch,
  groupOpponentsByPlayer,
  LS_GROUP_BY_PLAYER,
  type GlobalPlayerIdentity,
  type OpponentGroup,
  type PulseLinksResponse,
} from "@/lib/opponentGroups";
import { Button } from "@/components/ui/Button";
import { RevealedChip } from "./RevealedChip";
import { Skeleton } from "@/components/ui/Card";
import { RequestError } from "@/components/ui/RequestError";
import { Toggle } from "@/components/ui/Toggle";
import { SortableTh } from "@/components/ui/SortableTh";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { opponentDossierHref } from "./tabs";
import { visibleOpponentId } from "./opponentListSort";
import { useOpponentListNavigation, type MmrImpactFilter, type OpponentListLocation, type OpponentListSnapshot } from "./useOpponentListNavigation";
import { MinGamesPicker } from "@/components/ui/MinGamesPicker";
import { useAllNetMmrOpponents } from "@/lib/netMmrOpponents";
import { NoOpponentsMatch } from "./EmptyStates";
import {
  MmrImpactCells,
  MmrImpactLeaders,
  type MmrImpactLeader,
} from "./OpponentMmrImpact";

const LS_MIN_OPP = "analyzer.opponents.minGames";
type OpenOpponent = (id: string, fromLink?: boolean) => boolean;

type Opp = {
  pulseId: string;
  pulseCharacterId?: string | null;
  toonHandle?: string | null;
  name?: string;
  displayNameSample?: string;
  // Revealed identity behind a barcode, from Pulse or an approved
  // community submission. The recorded account name stays separate.
  revealedName?: string | null;
  globalIdentity?: GlobalPlayerIdentity | null;
  wins: number;
  losses: number;
  games: number;
  gameCount?: number;
  winRate: number;
  mmr?: number | null;
  netMmr?: number | null;
  mmrWon?: number;
  mmrLost?: number;
  mmrPairs?: number;
  mmrAvgDelta?: number | null;
  lastPlayed: string | null;
  lastSeen?: string | null;
  notesMeta?: { preview: string };
  notes?: string;
};
const notePreview = (opponent: Opp) => opponent.notesMeta?.preview || Array.from((opponent.notes || "").replace(/\s+/g, " ").trim()).slice(0, 140).join("");

/**
 * Opponents tab — full filters, search, sort, drilldown.
 *
 * Fetches the opponents list with cursor pagination so users with
 * thousands of recorded games see every opponent in one table, not
 * just the first 100. Also re-aggregates from the games collection
 * when the global date filter is set, so toggling between "All time"
 * and "Season N" updates wins/losses/games per opponent within the
 * window.
 *
 * "Group same player" (default on) folds rows that SC2Pulse links to
 * the same human — same Battle.net account, or the same community-
 * verified player across accounts — into one row per player: merged
 * W/L/games, the most-known name up front, and every other name they
 * play under one tap away on the "+N names" chip. Grouping degrades
 * gracefully: while the linkage is loading (or if the endpoint is
 * unavailable) every row simply stays its own group.
 */
export function OpponentsTab({
  onOpen,
  location,
  onResultCount,
}: {
  onOpen?: (pulseId: string) => void;
  location?: OpponentListLocation;
  onResultCount?: (count: number) => void;
}) {
  const { filters, dbRev } = useFilters();
  const { search, setSearch, impact: mmrImpactFilter, setImpact: setMmrImpactFilter, hasNotes, setHasNotes, sort, remember } = useOpponentListNavigation(location);
  const searchRef = useRef<HTMLInputElement>(null);
  const deferredSearch = useDeferredValue(search);
  const [visibleCount, setVisibleCount] = useState(200);
  const [minGames, setMinGames] = useLocalStoragePositiveInt(LS_MIN_OPP, 1);
  const [groupByPlayer, setGroupByPlayer] = useLocalStorageState<boolean>(
    LS_GROUP_BY_PLAYER,
    true,
    (raw): raw is boolean => typeof raw === "boolean",
  );
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(
    new Set(),
  );

  // We don't pass `limit` here — the paginator owns page size and
  // chases `nextBefore` until exhaustion (or a safe page cap).
  // `search` is intentionally NOT in the path: the backend ignores it
  // (filter happens client-side below), and including it would re-key
  // the paginator on every keystroke — which resets the items array,
  // re-triggers the loading-skeleton early-return, and unmounts the
  // search input mid-edit. Only re-fetch when the actual server-side
  // filters change.
  const params = useMemo(() => ({ ...filters }), [filters]);
  const path = `/v1/opponents${filtersToQuery(params)}`;
  const {
    items: rawItems,
    isLoading,
    isRefreshing,
    isLoadingMore,
    isStale,
    error,
    hitMaxPages,
    mutate: retryOpponents,
  } = useApiPaginated<Opp>(path, dbRev);

  // The impact endpoint reuses the exact accepted consecutive-replay pairs
  // behind the Net MMR by matchup chart. Fetch every offset page once, then
  // join by pulse id so the Opponents table never invents or approximates a
  // delta from lifetime W/L counters.
  const {
    items: mmrImpactItems,
    summary: mmrImpactSummary,
    isLoading: isMmrImpactLoading,
    error: mmrImpactError,
    hitMaxPages: hitMmrImpactMaxPages,
  } = useAllNetMmrOpponents(filters, dbRev);

  const mmrImpactLookup = useMemo(() => {
    const byPulseId = new Map<string, (typeof mmrImpactItems)[number]>();
    const byToonHandle = new Map<string, (typeof mmrImpactItems)[number]>();
    const byCharacterId = new Map<string, (typeof mmrImpactItems)[number]>();
    for (const row of mmrImpactItems) {
      if (row.pulseId) byPulseId.set(row.pulseId.toLowerCase(), row);
      if (row.toonHandle) byToonHandle.set(row.toonHandle.toLowerCase(), row);
      if (row.pulseCharacterId) {
        byCharacterId.set(String(row.pulseCharacterId), row);
      }
    }
    return { byPulseId, byToonHandle, byCharacterId };
  }, [mmrImpactItems]);

  // SC2Pulse "same player" linkage — characterId → account/pro keys.
  // Identity data, not a windowed stat, so it ignores the date filter
  // and is only fetched while grouping is on. SWR-cached; `partial`
  // means the server is still warming its linkage cache and a later
  // visit will merge more rows.
  const { data: pulseLinks, isLoading: isPulseLinksLoading } = useApi<PulseLinksResponse>(
    groupByPlayer ? "/v1/opponents/pulse-links" : null,
    { revalidateOnFocus: false },
  );

  const normalised: Opp[] = useMemo(() => {
    return (rawItems || []).map((o) => {
      const impact =
        mmrImpactLookup.byPulseId.get(o.pulseId.toLowerCase())
        ?? (o.toonHandle
          ? mmrImpactLookup.byToonHandle.get(o.toonHandle.toLowerCase())
          : undefined)
        ?? (o.pulseCharacterId
          ? mmrImpactLookup.byCharacterId.get(String(o.pulseCharacterId))
          : undefined);
      return {
        ...o,
        name: o.name || o.displayNameSample || "",
        games: o.games ?? o.gameCount ?? o.wins + o.losses,
        winRate:
          o.winRate
          ?? (o.wins + o.losses > 0 ? o.wins / (o.wins + o.losses) : 0),
        netMmr: impact?.netMmr ?? null,
        mmrWon: impact?.mmrWon ?? 0,
        mmrLost: impact?.mmrLost ?? 0,
        mmrPairs: impact?.pairs ?? 0,
        mmrAvgDelta: impact?.avgDelta ?? null,
        lastPlayed: o.lastPlayed || o.lastSeen || null,
      };
    });
  }, [rawItems, mmrImpactLookup]);

  // One entry per player. With grouping off (or links not loaded yet)
  // every row is its own singleton group, so the render path below is
  // uniform either way.
  const groups = useMemo(
    () =>
      groupOpponentsByPlayer(
        normalised,
        groupByPlayer ? pulseLinks?.links : null,
        groupByPlayer,
      ),
    [normalised, groupByPlayer, pulseLinks],
  );

  // The API leaders rank individual accounts. With grouping enabled, rank
  // the same merged totals as the table, before its search/min-games/impact
  // controls: these cards describe the entire globally filtered period.
  const mmrLeaders = useMemo(() => {
    if (!groupByPlayer) {
      return {
        mostWon: mmrImpactSummary?.mostMmrGainedFrom,
        mostLost: mmrImpactSummary?.mostMmrLostTo,
      };
    }
    const tracked = groups
      .filter((group) => (group.mmrPairs || 0) > 0 && typeof group.netMmr === "number")
      .map((group) => ({
        ...group,
        name: group.name || "unnamed opponent",
        netMmr: group.netMmr ?? 0,
        pairs: group.mmrPairs || 0,
      }));
    const byName = (a: MmrImpactLeader, b: MmrImpactLeader) =>
      a.name.localeCompare(b.name) || (a.pulseId || "").localeCompare(b.pulseId || "");
    return {
      mostWon: tracked.filter((group) => group.netMmr > 0).sort((a, b) =>
        b.netMmr - a.netMmr || (b.mmrWon || 0) - (a.mmrWon || 0) || byName(a, b),
      )[0] ?? null,
      mostLost: tracked.filter((group) => group.netMmr < 0).sort((a, b) =>
        a.netMmr - b.netMmr || (b.mmrLost || 0) - (a.mmrLost || 0) || byName(a, b),
      )[0] ?? null,
    };
  }, [groupByPlayer, groups, mmrImpactSummary]);

  // Client-side search across every identity in a group (names,
  // aliases, revealed name, pulse ids, toon handles). The backend
  // `search` query param is a no-op for the legacy endpoint, so
  // filter here.
  const searchedItems = useMemo(() => {
    const q = deferredSearch.trim();
    if (!q) return groups;
    return groups.filter((g) => groupMatchesSearch(g, q));
  }, [groups, deferredSearch]);

  const filteredItems = useMemo(
    () =>
      searchedItems.filter(
        (o) =>
          (o.games || 0) >= minGames
          && matchesMmrImpactFilter(o, mmrImpactFilter)
          && (!hasNotes || o.identities.some((identity) => Boolean(notePreview(identity)))),
      ),
    [searchedItems, minGames, mmrImpactFilter, hasNotes],
  );

  const { sortRows } = sort;
  const items = useMemo(
    () => sortRows(filteredItems, (row, col) => col === "pulseId" ? visibleOpponentId(row) : (row as unknown as Record<string, unknown>)[col]),
    [filteredItems, sortRows],
  );
  // Rows only the Min games picker is hiding, for the empty state.
  const hiddenByMinGames = searchedItems.filter(
    (o) => (o.games || 0) < minGames && matchesMmrImpactFilter(o, mmrImpactFilter),
  ).length;

  const mergedNameCount = normalised.length - groups.length;
  const channelsFor = usePlayerChannels(normalised);

  useEffect(() => setVisibleCount(200), [search, sort.sortBy, sort.sortDir, minGames, mmrImpactFilter, groupByPlayer, hasNotes]);
  useEffect(() => { onResultCount?.(items.length); }, [items.length, onResultCount]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || target?.isContentEditable || target?.closest("input,textarea,select,[contenteditable]:not([contenteditable=false])")) return;
      event.preventDefault(); searchRef.current?.focus();
    };
    window.addEventListener("keydown", shortcut); return () => window.removeEventListener("keydown", shortcut);
  }, []);
  const restore = useRef<OpponentListSnapshot | null>(null);
  useEffect(() => {
    try {
      if (sessionStorage.getItem("opponents:from-list") === "1") {
        const stored = JSON.parse(sessionStorage.getItem("opponents:list-state") || "null");
        const here = `${window.location.pathname}${window.location.search}`;
        if (stored?.listUrl === here && Array.isArray(stored.expandedGroups) && stored.expandedGroups.every((id: unknown) => typeof id === "string") && Number.isFinite(stored.scrollY) && Number.isFinite(stored.renderWindow)) restore.current = stored;
      }
      sessionStorage.removeItem("opponents:from-list");
    } catch { /* List navigation does not depend on session storage. */ }
  }, []);
  useEffect(() => {
    if (isLoading || isLoadingMore || (groupByPlayer && isPulseLinksLoading) || !rawItems.length || !restore.current) return;
    const stored = restore.current; restore.current = null;
    setVisibleCount(Math.max(200, Math.min(8000, stored.renderWindow)));
    setExpandedGroups(new Set(stored.expandedGroups));
    let second = 0;
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => window.scrollTo(0, Math.max(0, stored.scrollY))); });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [isLoading, isLoadingMore, rawItems.length, groupByPlayer, isPulseLinksLoading]);
  const open: OpenOpponent = useCallback((id: string, fromLink = false) => {
    remember({ renderWindow: visibleCount, expandedGroups: [...expandedGroups] });
    if (fromLink && !onOpen) return false;
    if (onOpen) onOpen(id); else location?.navigate(opponentDossierHref(id));
    return true;
  }, [remember, visibleCount, expandedGroups, onOpen, location]);
  const prefetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prefetch = useCallback((id: string | null) => {
    if (prefetchTimer.current) clearTimeout(prefetchTimer.current);
    if (id && location) prefetchTimer.current = setTimeout(() => location.prefetch(opponentDossierHref(id)), 150);
  }, [location]);
  useEffect(() => () => { if (prefetchTimer.current) clearTimeout(prefetchTimer.current); }, []);
  const reset = () => { setSearch(""); setMinGames(1); setMmrImpactFilter("all"); setHasNotes(false); setGroupByPlayer(true); sort.setSortExplicit("lastPlayed", "desc"); };
  const changed = Boolean(search || minGames !== 1 || mmrImpactFilter !== "all" || hasNotes || !groupByPlayer || sort.sortBy !== "lastPlayed" || sort.sortDir !== "desc");

  const toggleGroup = useCallback((pulseId: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(pulseId)) next.delete(pulseId);
      else next.add(pulseId);
      return next;
    });
  }, []);

  const showSkeleton = isLoading && rawItems.length === 0;

  return (
    <div className="space-y-4">
      {isLoadingMore ? <p className="text-caption text-text-muted">MMR leaders (still loading)</p> : null}
      <MmrImpactLeaders
        mostWon={mmrLeaders.mostWon}
        mostLost={mmrLeaders.mostLost}
        loading={isMmrImpactLoading || (groupByPlayer && (isLoading || !!isPulseLinksLoading))}
        unavailable={!!mmrImpactError || (groupByPlayer && !!error)}
        incomplete={groupByPlayer && (hitMaxPages || hitMmrImpactMaxPages)}
        onOpen={open}
      />

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full sm:max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-dim" aria-hidden />
        <Input
          ref={searchRef}
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name or Pulse ID"
          aria-label="Search opponents"
          onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setSearch(""); } }}
          className="min-h-[44px] pl-9 pr-11"
        />
        {search ? <button type="button" aria-label="Clear search" onClick={() => { setSearch(""); searchRef.current?.focus(); }} className="absolute right-0 top-0 flex h-11 w-11 items-center justify-center rounded-md focus-visible:ring-2 focus-visible:ring-accent"><X className="h-4 w-4" aria-hidden /></button> : null}
        </div>
        <MinGamesPicker value={minGames} onChange={setMinGames} />
        <label className="flex min-h-[44px] items-center gap-2">
          <span className="whitespace-nowrap text-micro uppercase tracking-wider text-text-dim">
            MMR impact
          </span>
          <Select
            value={mmrImpactFilter}
            onChange={(event) =>
              setMmrImpactFilter(event.target.value as MmrImpactFilter)
            }
            aria-label="Filter opponents by MMR impact"
            className="min-h-[44px] text-caption"
          >
            <option value="all">All opponents</option>
            <option value="tracked">Verified pairs only</option>
            <option value="net-gain">You gained overall</option>
            <option value="net-loss">They gained overall</option>
          </Select>
        </label>
        <label className="flex min-h-[44px] items-center gap-2 text-caption text-text-muted"><Toggle checked={hasNotes} onChange={setHasNotes} label="Has notes" /><span>Has notes</span></label>
        {changed ? <Button variant="ghost" size="sm" onClick={reset}>Reset</Button> : null}
        <label
          className="flex cursor-pointer items-center gap-2 text-xs text-text-muted"
          title="Merge accounts linked to the same player into one row"
        >
          <Toggle
            checked={groupByPlayer}
            onChange={setGroupByPlayer}
            label="Group same player"
          />
          <span className="text-micro uppercase tracking-wider text-text-dim">
            Group same player
          </span>
        </label>
        <div className="ml-auto flex w-full flex-col items-end gap-1 sm:w-auto">
          <span aria-live="polite" className="text-xs text-text-dim">
            {isRefreshing ? "Updating… · " : isLoadingMore ? `Loading more opponents… (${rawItems.length.toLocaleString()} so far) · ` : ""}
            {items.length.toLocaleString()} {groupByPlayer ? "players" : "accounts"}
            {groupByPlayer && mergedNameCount > 0
              ? ` · ${mergedNameCount.toLocaleString()} accounts merged`
              : null}
            {hitMaxPages ? " · Showing your most recent 8,000 opponents" : null}
          </span>
          {isMmrImpactLoading || hitMmrImpactMaxPages ? (
            <span className="text-xs text-text-dim">
              {isMmrImpactLoading
                ? "Loading verified MMR impact..."
                : "Some MMR impact rows were omitted; narrow the global filters."}
            </span>
          ) : null}
        </div>
      </div>

      {rawItems.length > 0 && error ? <div role="alert" className="flex items-center gap-3 text-caption text-warning">
        <span>{isStale ? "Couldn't refresh after your last game. Showing the list from before." : "Couldn't load every opponent. Showing the rows already loaded."}</span>
        <Button size="sm" variant="secondary" onClick={retryOpponents} loading={isRefreshing}>Try again</Button>
      </div> : null}

      {/* A failed load is never "no opponents match": the list could
          not be read at all. The empty state sits outside the wide
          table so it stays readable on a phone. */}
      {error && rawItems.length === 0 ? (
        <RequestError error={error} onRetry={retryOpponents} title="Opponents" filtered />
      ) : !showSkeleton && items.length === 0 ? (
        <div className="rounded-xl border-2 border-line bg-bg-surface shadow-hard">
          {hasNotes ? <div className="p-6 text-center"><h3 className="font-semibold">No opponents with notes yet. Add one from any dossier.</h3><Button className="mt-3" variant="secondary" onClick={() => setHasNotes(false)}>Show opponents without notes</Button></div> : <NoOpponentsMatch
            minGames={minGames}
            hiddenByMinGames={hiddenByMinGames}
            onLowerMinGames={() => setMinGames(1)}
            extraAction={
              <>
                {search.trim() ? (
                  <Button variant="secondary" size="sm" onClick={() => setSearch("")}>
                    Clear search
                  </Button>
                ) : null}
                {mmrImpactFilter !== "all" ? (
                  <Button variant="secondary" size="sm" onClick={() => setMmrImpactFilter("all")}>
                    Show all MMR impact
                  </Button>
                ) : null}
                {changed ? <Button variant="secondary" size="sm" onClick={reset}>Reset filters</Button> : null}
              </>
            }
          />}
        </div>
      ) : (
        <div className="rounded-xl border-2 border-line bg-bg-surface shadow-hard overflow-x-auto">
          <table
            aria-label="Opponent history"
            className="w-full min-w-[1020px] text-sm"
          >
            <thead className="bg-bg-elevated">
              <tr>
                <SortableTh
                  col="name"
                  label="Opponent"
                  {...sort}
                  compact
                  width="8.5rem"
                />
                <SortableTh
                  col="pulseId"
                  label="Pulse ID"
                  {...sort}
                  compact
                  width="7.5rem"
                />
                <SortableTh
                  col="wins"
                  label="W"
                  title="Wins"
                  {...sort}
                  compact
                  align="right"
                  width="3rem"
                />
                <SortableTh
                  col="losses"
                  label="L"
                  title="Losses"
                  {...sort}
                  compact
                  align="right"
                  width="3rem"
                />
                <SortableTh
                  col="winRate"
                  label="Win rate"
                  {...sort}
                  compact
                  align="right"
                  width="5rem"
                />
                <SortableTh
                  col="games"
                  label="Games"
                  {...sort}
                  compact
                  align="right"
                  width="4rem"
                />
                <SortableTh
                  col="mmr"
                  label="Last MMR"
                  title="MMR from the most recent game you played against this opponent"
                  {...sort}
                  compact
                  align="right"
                  width="5.5rem"
                />
                <SortableTh
                  col="netMmr"
                  label="Net MMR"
                  title="Verified game-time MMR gained or lost across consecutive ranked 1v1 replay pairs"
                  {...sort}
                  compact
                  align="right"
                  width="6rem"
                />
                <SortableTh
                  col="mmrWon"
                  label="MMR won"
                  title="Total positive MMR deltas earned against this opponent"
                  {...sort}
                  compact
                  align="right"
                  width="5.5rem"
                />
                <SortableTh
                  col="mmrLost"
                  label="MMR lost"
                  title="Total MMR lost to this opponent, shown as a positive magnitude"
                  {...sort}
                  compact
                  align="right"
                  width="5.5rem"
                />
                <SortableTh
                  col="lastPlayed"
                  label="Last"
                  {...sort}
                  compact
                  align="right"
                  width="6.5rem"
                />
                <th className="w-8 px-1 py-1.5 text-right text-text-dim"><span className="sr-only">Open dossier</span><span aria-hidden>→</span></th>
              </tr>
            </thead>
            <tbody aria-busy={search !== deferredSearch || undefined} className={search !== deferredSearch ? "opacity-70" : undefined}>
              {showSkeleton ? (
                <tr>
                  <td colSpan={12} className="px-3 py-3">
                    <Skeleton rows={8} />
                  </td>
                </tr>
              ) : (
                items.slice(0, visibleCount).map((o) => (
                  <OpponentRow key={o.pulseId} row={o} expanded={expandedGroups.has(o.pulseId)}
                    onToggle={toggleGroup} onOpen={open} onPrefetch={prefetch} channelsFor={channelsFor} />
                ))
              )}
            </tbody>
          </table>
          {items.length > visibleCount ? <Button variant="secondary" className="m-3"
            onClick={() => setVisibleCount((count) => count + 200)}>
            Show 200 more (of {items.length.toLocaleString()})
          </Button> : null}
        </div>
      )}
    </div>
  );
}

function rowCanOpen(event: MouseEvent<HTMLTableRowElement>) {
  return event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey
    && !(event.target as HTMLElement).closest("a,button,input,select,textarea") && !window.getSelection()?.toString();
}

const OpponentRow = memo(function OpponentRow({ row: o, expanded, onToggle, onOpen, onPrefetch, channelsFor }: {
  row: OpponentGroup<Opp>; expanded: boolean; onToggle: (id: string) => void;
  onOpen: OpenOpponent; channelsFor: ReturnType<typeof usePlayerChannels>;
  onPrefetch: (id: string | null) => void;
}) {
  return (
                  <Fragment>
                    <tr
                      onClick={(event) => { if (rowCanOpen(event)) onOpen(o.pulseId); }}
                      onPointerEnter={() => onPrefetch(o.pulseId)} onPointerLeave={() => onPrefetch(null)}
                      className="group cursor-pointer border-t border-border hover:bg-accent/10"
                    >
                      <td
                        className="px-2 py-1 text-text group-hover:text-accent"
                        title={groupRowTitle(o)}
                      >
                        <span className="flex min-w-0 items-center gap-1">
                          <OpponentLink opponent={o} onOpen={onOpen} className="truncate hover:underline">
                            {o.name || (
                              <span className="italic text-text-dim">unnamed</span>
                            )}
                          </OpponentLink>
                          <RevealedChip
                            name={o.revealedName}
                            displayedName={o.name}
                            confirmed={!!o.globalIdentity}
                          />
                          <PlayerChannelLinks channels={channelsFor(o) || o.identities.map(channelsFor).find(Boolean)} playerName={o.revealedName || o.name} compact />
                          <NotePreview previews={o.identities.map(notePreview).filter(Boolean)} />
                          {o.groupSize > 1 ? (
                            <AliasChip
                              group={o}
                              expanded={expanded}
                              onToggle={() => onToggle(o.pulseId)}
                            />
                          ) : null}
                        </span>
                      </td>
                      <PulseIdCell opp={o} />
                      <td className="px-2 py-1 text-right tabular-nums text-success">
                        {o.wins}
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums text-danger">
                        {o.losses}
                      </td>
                      <td
                        className="px-2 py-1 text-right tabular-nums"
                        style={{ color: wrColor(o.winRate, o.games) }}
                      >
                        {pct1(o.winRate)}
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums text-text-muted">
                        {o.games}
                      </td>
                      <td
                        className="px-2 py-1 text-right tabular-nums text-text-muted"
                        title={
                          typeof o.mmr === "number"
                            ? "MMR from the most recent game you played against this opponent"
                            : "No MMR on record yet"
                        }
                      >
                        {fmtMmr(o.mmr)}
                      </td>
                      <MmrImpactCells opponent={o} />
                      <td className="px-2 py-1 text-right text-xs text-text-dim">
                        {o.lastPlayed ? <time dateTime={o.lastPlayed} title={new Date(o.lastPlayed).toLocaleString()}>{fmtAgo(o.lastPlayed)}</time> : "—"}
                      </td>
                      <td className="px-1 py-1 text-right text-text-dim group-hover:text-accent">
                        <OpponentOpenButton opponent={o} onOpen={onOpen} />
                      </td>
                    </tr>
                    {o.groupSize > 1 && expanded
                      ? o.identities.map((identity) => (
                          <IdentityRow
                            key={identity.pulseId}
                            identity={identity}
                            channels={channelsFor(identity)}
                            onOpen={onOpen}
                            onPrefetch={onPrefetch}
                          />
                        ))
                      : null}
                  </Fragment>
  );
});

function matchesMmrImpactFilter(
  opponent: OpponentGroup<Opp>,
  filter: MmrImpactFilter,
): boolean {
  if (filter === "all") return true;
  const pairs = opponent.mmrPairs || 0;
  if (filter === "tracked") return pairs > 0;
  if (pairs === 0 || typeof opponent.netMmr !== "number") return false;
  return filter === "net-gain" ? opponent.netMmr > 0 : opponent.netMmr < 0;
}

/** Hover title for a (possibly grouped) opponent row. */
function groupRowTitle(o: OpponentGroup<Opp>): string {
  const base = o.revealedName
    ? `${o.name || "unnamed"} · revealed as ${o.revealedName}`
    : o.name || "";
  if (o.aliasNames.length === 0) return base;
  return `${base} · also plays as ${o.aliasNames.join(", ")}`;
}

/**
 * "+N names" disclosure chip on a grouped row. SC2Pulse says these
 * names are the same player; the chip both announces that and expands
 * the per-name breakdown underneath. stopPropagation so toggling
 * never triggers the row's deep-dive navigation.
 */
function AliasChip({
  group,
  expanded,
  onToggle,
}: {
  group: OpponentGroup<Opp>;
  expanded: boolean;
  onToggle: () => void;
}) {
  const extra = group.groupSize - 1;
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-label={`${expanded ? "Hide" : "Show"} the ${group.groupSize} names this player uses`}
      title={`Same player${group.globalIdentity ? " · confirmed identity" : " on SC2Pulse"} · also plays as ${group.aliasNames.join(", ")}`}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className="inline-flex flex-shrink-0 items-center gap-0.5 rounded-full bg-accent/15 px-2 py-0.5 text-micro font-semibold text-accent transition-colors hover:bg-accent/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-bg"
    >
      +{extra} {extra === 1 ? "name" : "names"}
      <Chevron className="h-3 w-3" aria-hidden />
    </button>
  );
}

/**
 * One identity inside an expanded group — the per-name W/L/games
 * breakdown. Clickable like a main row, opening THAT identity's deep
 * dive (each name keeps its own game history and profile).
 */
function IdentityRow({
  identity,
  channels,
  onOpen,
  onPrefetch,
}: {
  identity: Opp;
  channels?: PlayerChannels;
  onOpen: OpenOpponent;
  onPrefetch: (id: string | null) => void;
}) {
  const revealedName = identity.globalIdentity?.displayName.trim() || identity.revealedName;
  return (
    <tr
      onClick={(event) => { if (rowCanOpen(event)) onOpen(identity.pulseId); }}
      onPointerEnter={() => onPrefetch(identity.pulseId)} onPointerLeave={() => onPrefetch(null)}
      className="group cursor-pointer border-t border-border/60 bg-bg-elevated/40 hover:bg-accent/10"
    >
      <td
        className="py-1 pl-5 pr-2 text-text-muted group-hover:text-accent"
        title={identity.name || ""}
      >
        <span className="flex min-w-0 items-center gap-1">
          <CornerDownRight
            className="h-3 w-3 flex-shrink-0 text-text-dim"
            aria-hidden
          />
          <OpponentLink opponent={identity} onOpen={onOpen} className="truncate hover:underline">
            {identity.name || (
              <span className="italic text-text-dim">unnamed</span>
            )}
          </OpponentLink>
          <RevealedChip name={revealedName} displayedName={identity.name} confirmed={!!identity.globalIdentity} />
          <PlayerChannelLinks channels={channels} playerName={revealedName || identity.name} compact />
          <NotePreview previews={[notePreview(identity)].filter(Boolean)} />
        </span>
      </td>
      <PulseIdCell opp={identity} />
      <td className="px-2 py-1 text-right tabular-nums text-success">
        {identity.wins}
      </td>
      <td className="px-2 py-1 text-right tabular-nums text-danger">
        {identity.losses}
      </td>
      <td
        className="px-2 py-1 text-right tabular-nums"
        style={{ color: wrColor(identity.winRate, identity.games) }}
      >
        {pct1(identity.winRate)}
      </td>
      <td className="px-2 py-1 text-right tabular-nums text-text-muted">
        {identity.games}
      </td>
      <td className="px-2 py-1 text-right tabular-nums text-text-muted">
        {fmtMmr(identity.mmr)}
      </td>
      <MmrImpactCells opponent={identity} />
      <td className="px-2 py-1 text-right text-xs text-text-dim">
        {identity.lastPlayed ? <time dateTime={identity.lastPlayed} title={new Date(identity.lastPlayed).toLocaleString()}>{fmtAgo(identity.lastPlayed)}</time> : "—"}
      </td>
      <td className="px-1 py-1 text-right text-text-dim group-hover:text-accent">
        <OpponentOpenButton opponent={identity} onOpen={onOpen} />
      </td>
    </tr>
  );
}

function OpponentOpenButton({
  opponent,
  onOpen,
}: {
  opponent: Pick<Opp, "pulseId" | "name">;
  onOpen: OpenOpponent;
}) {
  const name = opponent.name || "unnamed opponent";
  return (
    <OpponentLink opponent={opponent} onOpen={onOpen}
      aria-label={`Open dossier for ${name}`}
      className="inline-flex h-7 w-7 items-center justify-center rounded text-current hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <span aria-hidden>→</span>
    </OpponentLink>
  );
}

function OpponentLink({ opponent, onOpen, children, ...props }: { opponent: Pick<Opp, "pulseId" | "name">; onOpen: OpenOpponent; children: React.ReactNode } & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "onClick">) {
  return <Link href={opponentDossierHref(opponent.pulseId)} prefetch={false} {...props} onClick={(event) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    event.stopPropagation(); if (onOpen(opponent.pulseId, true)) event.preventDefault();
  }}>{children}</Link>;
}

function NotePreview({ previews }: { previews: string[] }) {
  if (!previews.length) return null;
  return <span className="group/note relative inline-flex shrink-0 items-center gap-1">
    <button type="button" aria-label={`Scouting note: ${previews[0]}`} title={previews[0]} onClick={(event) => event.stopPropagation()} className="flex h-8 w-8 items-center justify-center rounded text-accent focus-visible:ring-2 focus-visible:ring-accent"><StickyNote className="h-3.5 w-3.5" aria-hidden /></button>
    {previews.length > 1 ? <span className="text-micro text-text-dim">+{previews.length - 1} more</span> : null}
    <span role="tooltip" className="pointer-events-none absolute left-0 top-full z-20 hidden w-64 whitespace-normal rounded-lg border border-line bg-bg-elevated p-3 text-caption text-text shadow-hard group-hover/note:block group-focus-within/note:block">{previews[0]}</span>
  </span>;
}

/**
 * The "Pulse ID" cell. When the agent has resolved the opponent's
 * canonical SC2Pulse character id (e.g. "994428"), show it as a link
 * to sc2pulse.nephest.com. Otherwise, show the raw toon_handle in dim
 * mono with a "(toon)" hint so the user can tell at a glance that
 * resolution hasn't happened yet (e.g. SC2Pulse was down during
 * the first ingest, or the opponent isn't ranked yet).
 */
function PulseIdCell({ opp }: { opp: Opp }) {
  const label = pickPulseLabel(opp);
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  if (!label) {
    return (
      <td className="px-2 py-1 text-xs text-text-dim">—</td>
    );
  }
  if (label.isPulseCharacterId) {
    return (
      <td
        className="truncate px-2 py-1 font-mono text-xs"
        title={opp.toonHandle || opp.pulseId}
      >
        <a
          href={sc2pulseCharacterUrl(label.value)}
          target="_blank"
          rel="noopener noreferrer"
          onClick={stop}
          className="inline-flex items-center gap-1 text-accent-cyan hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        >
          {label.value}
          <ExternalLink className="h-3 w-3" aria-hidden />
        </a>
      </td>
    );
  }
  return (
    <td
      className="truncate px-2 py-1 font-mono text-xs text-text-dim"
      title={`${label.value} · sc2pulse character id not resolved yet`}
    >
      {label.value}
      <span className="ml-1 text-micro uppercase tracking-wider text-text-muted">
        toon
      </span>
    </td>
  );
}
