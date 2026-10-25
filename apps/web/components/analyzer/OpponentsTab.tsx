"use client";

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  Search,
  X,
} from "lucide-react";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { useApi } from "@/lib/clientApi";
import { useApiPaginated } from "@/lib/useApiPaginated";
import { usePlayerChannels } from "./usePlayerChannels";
import { useLocalStoragePositiveInt, useLocalStorageState } from "@/lib/useLocalStorageState";
import {
  groupMatchesSearch,
  groupOpponentsByPlayer,
  type OpponentGroup,
  type PulseLinksResponse,
} from "@/lib/opponentGroups";
import { useRivals, rivalKeys } from "@/lib/useRivals";
import { useOpponentScoutingPreference } from "@/lib/useOpponentScoutingPreference";
import { GroupingPreference } from "./opponents/GroupingPreference";
import { useRivalSummary } from "@/lib/useRivalSummary";
import { rivalSummaryGroups } from "@/lib/rivalSummaryGroups";
import { StarredRivalCards } from "./opponents/StarredRivalCards";
import { csvFilename, downloadCsv, toCsv } from "@/lib/csvExport";
import { opponentColumns, opponentRace, OPPONENT_CSV_COLUMNS, type OpponentColumns } from "@/lib/opponentPresentation";
import { RivalStar } from "./opponents/RivalStar";
import { RivalriesStrip } from "./opponents/RivalriesStrip";
import { OpponentHistory, OpponentColumnPicker } from "./opponents/OpponentHistory";
import { Button } from "@/components/ui/Button";
import { RequestError } from "@/components/ui/RequestError";
import { Toggle } from "@/components/ui/Toggle";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { opponentDossierHref } from "./tabs";
import { visibleOpponentId } from "./opponentListSort";
import { useOpponentListNavigation, type MmrImpactFilter, type OpponentListLocation, type OpponentListSnapshot, type OpponentListControls } from "./useOpponentListNavigation";
import { MinGamesPicker } from "@/components/ui/MinGamesPicker";
import { useAllNetMmrOpponents } from "@/lib/netMmrOpponents";
import { NoGamesYet, NoOpponentsMatch } from "./EmptyStates";
import {
  MmrImpactLeaders,
  type MmrImpactLeader,
} from "./OpponentMmrImpact";

import { type Opp, type OpenOpponent, type OpponentExportAction, notePreview } from "./opponents/types";

const LS_MIN_OPP = "analyzer.opponents.minGames";

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
  onExportAction,
  controls,
}: {
  onOpen?: (pulseId: string) => void;
  location?: OpponentListLocation;
  onResultCount?: (count: number) => void;
  onExportAction?: (action: OpponentExportAction | null) => void;
  controls?: OpponentListControls;
}) {
  const { filters, dbRev } = useFilters();
  const { search, setSearch, impact: mmrImpactFilter, setImpact: setMmrImpactFilter, hasNotes, setHasNotes, sort, remember } = useOpponentListNavigation(location, controls);
  const rivals = useRivals();
  const [quick, setQuick] = useState<"all" | "regulars" | "week" | "rivals">("all");
  const [columnOverrides, setColumnOverrides] = useLocalStorageState<Partial<OpponentColumns>>("analyzer.opponents.columns", {}, (value): value is Partial<OpponentColumns> => !!value && typeof value === "object" && !Array.isArray(value) && Object.entries(value).every(([key, visible]) => ["pulseId", "mmr", "netMmr", "mmrWon", "mmrLost"].includes(key) && typeof visible === "boolean"));
  const searchRef = useRef<HTMLInputElement>(null);
  const deferredSearch = useDeferredValue(search);
  const [visibleCount, setVisibleCount] = useState(100);
  const [minGames, setMinGames] = useLocalStoragePositiveInt(LS_MIN_OPP, 1);
  const grouping = useOpponentScoutingPreference();
  const { groupByPlayer, setGroupByPlayer } = grouping;
  const showPlayerGroups = groupByPlayer || quick === "rivals";
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
    "/v1/opponents/pulse-links",
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
        showPlayerGroups ? pulseLinks?.links : null,
        showPlayerGroups,
      ),
    [normalised, showPlayerGroups, pulseLinks],
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
  const summaryGroups = useMemo(() => rivalSummaryGroups(groups, rivals.keys, pulseLinks?.links), [groups, rivals.keys, pulseLinks]);
  const summary = useRivalSummary(summaryGroups, filtersToQuery(params), dbRev, !isLoading && !isLoadingMore && !rivals.loading && !isPulseLinksLoading);
  const groupsWithWeek = useMemo(() => groups.map(group => ({ ...group, weekGames: summary.data?.recentComplete ? group.identities.reduce((sum, identity) => sum + (summary.data?.weekGames[identity.pulseId] || 0), 0) : undefined })), [groups, summary.data]);
  const searchedItems = useMemo(() => {
    const q = deferredSearch.trim();
    if (!q) return groupsWithWeek;
    return groupsWithWeek.filter((g) => groupMatchesSearch(g, q));
  }, [groupsWithWeek, deferredSearch]);

  const filteredItems = useMemo(
    () =>
      searchedItems.filter(
        (o) =>
          (o.games || 0) >= minGames
          && matchesMmrImpactFilter(o, mmrImpactFilter)
          && (!hasNotes || o.identities.some((identity) => Boolean(notePreview(identity))))
          && (quick !== "regulars" || o.games >= 5)
          && (quick !== "week" || (!!o.lastPlayed && Date.parse(o.lastPlayed) <= Date.now() && Date.parse(o.lastPlayed) >= Date.now() - 7 * 86_400_000))
          && (quick !== "rivals" || rivalKeys(o, pulseLinks?.links).some(key => rivals.keys.includes(key))),
      ),
    [searchedItems, minGames, mmrImpactFilter, hasNotes, quick, pulseLinks, rivals.keys],
  );

  const { sortRows } = sort;
  const items = useMemo(
    () => sortRows(filteredItems, (row, col) => col === "pulseId" ? visibleOpponentId(row) : col === "race" ? opponentRace(row.race) : (row as unknown as Record<string, unknown>)[col]),
    [filteredItems, sortRows],
  );
  // Rows only the Min games picker is hiding, for the empty state.
  const hiddenByMinGames = searchedItems.filter(
    (o) => (o.games || 0) < minGames && matchesMmrImpactFilter(o, mmrImpactFilter),
  ).length;

  const mergedNameCount = normalised.length - groups.length;
  const channelsFor = usePlayerChannels(normalised);

  useEffect(() => setVisibleCount(100), [search, sort.sortBy, sort.sortDir, minGames, mmrImpactFilter, groupByPlayer, hasNotes, path, quick]);
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
    setVisibleCount(Math.max(100, Math.min(8000, stored.renderWindow)));
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
  const reset = () => { setSearch(""); setMinGames(1); setMmrImpactFilter("all"); setHasNotes(false); setQuick("all"); setGroupByPlayer(true); setColumnOverrides({}); sort.setSortExplicit("lastPlayed", "desc"); };
  const changed = Boolean(Object.keys(columnOverrides).length || quick !== "all" || search || minGames !== 1 || mmrImpactFilter !== "all" || hasNotes || !groupByPlayer || sort.sortBy !== "lastPlayed" || sort.sortDir !== "desc");

  const toggleGroup = useCallback((pulseId: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(pulseId)) next.delete(pulseId);
      else next.add(pulseId);
      return next;
    });
  }, []);

  const columns = opponentColumns(columnOverrides, mmrImpactItems.some(row => (row.pairs || 0) > 0));
  const exportScope = JSON.stringify([rivals.owner, path, search, minGames, quick, mmrImpactFilter, hasNotes, groupByPlayer, sort.sortBy, sort.sortDir]);
  const currentExport = useRef<string | null>(exportScope); currentExport.current = exportScope;
  useEffect(() => { currentExport.current = exportScope; return () => { currentExport.current = null; }; }, [exportScope]);
  const exportRows = useCallback(() => {
    if (currentExport.current !== exportScope) return;
    const exportedAt = new Date();
    const scope = `Opponents · ${showPlayerGroups ? "grouped players" : "accounts"} · ${path} · search ${search || "(none)"} · min games ${minGames} · ${quick} · MMR ${mmrImpactFilter} · notes ${hasNotes} · ${sort.sortBy} ${sort.sortDir}`;
    downloadCsv(csvFilename("opponents", exportedAt), toCsv({ columns: OPPONENT_CSV_COLUMNS, rows: items, scope, exportedAt }));
  }, [exportScope, showPlayerGroups, path, search, minGames, quick, mmrImpactFilter, hasNotes, sort.sortBy, sort.sortDir, items]);
  const exportDisabled = !rivals.owner || !items.length || isLoading || isLoadingMore || hitMaxPages || !!error || search !== deferredSearch;
  useEffect(() => {
    onExportAction?.({ count: items.length, disabled: exportDisabled, download: exportRows });
    return () => onExportAction?.(null);
  }, [items.length, exportDisabled, exportRows, onExportAction]);
  const star = (row: OpponentGroup<Opp>) => {
    const candidates = rivalKeys(row, pulseLinks?.links);
    return <RivalStar name={row.name || "unnamed opponent"} starred={candidates.some(key => rivals.keys.includes(key))} disabled={rivals.loading || rivals.saving || rivals.unavailable || !!isPulseLinksLoading} onToggle={() => { void rivals.toggle(candidates); }} />;
  };

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

      <RivalriesStrip rows={items} onOpen={open} incomplete={isLoading || isLoadingMore || hitMaxPages || !!error} recentAvailable={summary.data?.recentComplete === true} />
      <div className="flex flex-wrap items-center gap-2" aria-label="Quick opponent views">
        <Button variant={quick === "all" ? "primary" : "secondary"} aria-pressed={quick === "all"} onClick={() => setQuick("all")}>All opponents</Button>
        <Button variant={quick === "regulars" ? "primary" : "secondary"} aria-pressed={quick === "regulars"} onClick={() => setQuick(quick === "regulars" ? "all" : "regulars")}>Regulars: 5+ games</Button>
        <Button variant={quick === "week" ? "primary" : "secondary"} aria-pressed={quick === "week"} onClick={() => setQuick(quick === "week" ? "all" : "week")}>Played this week</Button>
        <Button variant="secondary" onClick={() => { setQuick("all"); sort.setSortExplicit("losses", "desc"); }}>Lost to most</Button>
        <Button variant={quick === "rivals" ? "primary" : "secondary"} aria-pressed={quick === "rivals"} onClick={() => setQuick(quick === "rivals" ? "all" : "rivals")}>Rivals ({rivals.keys.length})</Button>
        <OpponentColumnPicker columns={columns} onChange={(key, checked) => setColumnOverrides({ ...columnOverrides, [key]: checked })} onReset={() => setColumnOverrides({})} />
        {!onExportAction ? <Button variant="secondary" disabled={exportDisabled} title={`Export all ${items.length.toLocaleString()} matching ${groupByPlayer ? "players" : "accounts"}, including rows outside the render window`} onClick={exportRows}>Export CSV</Button> : null}
      </div>
      {rivals.error || rivals.unavailable ? <div role="alert" className="flex flex-wrap items-center gap-2 text-caption text-warning"><p>{rivals.error || "Rival preferences are temporarily unavailable."}</p>{rivals.unavailable ? <Button variant="ghost" size="sm" onClick={rivals.retry}>Retry rival preferences</Button> : null}</div> : null}
      {summary.error ? <p role="status" className="flex flex-wrap items-center gap-2 text-caption text-text-muted">Recent rival details are unavailable.<Button variant="ghost" size="sm" onClick={summary.retry}>Retry rival details</Button></p> : null}
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
        <GroupingPreference preference={grouping} />
        <div className="ml-auto flex w-full flex-col items-end gap-1 sm:w-auto">
          <span aria-live="polite" className="text-xs text-text-dim">
            {isRefreshing ? "Updating… · " : isLoadingMore ? `Loading more opponents… (${rawItems.length.toLocaleString()} so far) · ` : ""}
            {items.length.toLocaleString()} {showPlayerGroups ? "players" : "accounts"}
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
      ) : !showSkeleton && rawItems.length === 0 && summary.data?.hasAnyGames === false ? <NoGamesYet /> : quick === "rivals" ? (
        <StarredRivalCards rows={items} summary={summary.data} keyFor={row => rivalKeys(row, pulseLinks?.links).find(key => rivals.keys.includes(key))} onOpen={open} star={star} channelsFor={channelsFor} totalStars={rivals.keys.length} />
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
        <OpponentHistory items={items} expanded={expandedGroups} visibleCount={visibleCount} onMore={() => setVisibleCount(count => count + 100)} sort={sort} columns={columns} onToggle={toggleGroup} onOpen={open} onPrefetch={prefetch} channelsFor={channelsFor} star={star} loading={showSkeleton} busy={search !== deferredSearch} />
      )}
    </div>
  );
}

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
