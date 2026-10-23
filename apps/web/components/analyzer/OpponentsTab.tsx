"use client";

import { Fragment, memo, useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  ExternalLink,
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
import { Skeleton } from "@/components/ui/Card";
import { RequestError } from "@/components/ui/RequestError";
import { Toggle } from "@/components/ui/Toggle";
import { useSort, SortableTh } from "@/components/ui/SortableTh";
import { MinGamesPicker } from "@/components/ui/MinGamesPicker";
import { useAllNetMmrOpponents } from "@/lib/netMmrOpponents";
import { NoOpponentsMatch } from "./EmptyStates";
import {
  MmrImpactCells,
  MmrImpactLeaders,
  type MmrImpactLeader,
} from "./OpponentMmrImpact";

const LS_MIN_OPP = "analyzer.opponents.minGames";

type MmrImpactFilter = "all" | "tracked" | "net-gain" | "net-loss";

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
};

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
}: {
  onOpen: (pulseId: string) => void;
}) {
  const { filters, dbRev } = useFilters();
  const [search, setSearch] = useState("");
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
  const [mmrImpactFilter, setMmrImpactFilter] =
    useState<MmrImpactFilter>("all");
  const sort = useSort("lastPlayed", "desc");

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
    pagesFetched,
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
          && matchesMmrImpactFilter(o, mmrImpactFilter),
      ),
    [searchedItems, minGames, mmrImpactFilter],
  );

  const { sortRows } = sort;
  const items = useMemo(
    () => sortRows(filteredItems, (row, col) => (row as any)[col]),
    [filteredItems, sortRows],
  );
  // Rows only the Min games picker is hiding, for the empty state.
  const hiddenByMinGames = searchedItems.filter(
    (o) => (o.games || 0) < minGames && matchesMmrImpactFilter(o, mmrImpactFilter),
  ).length;

  const mergedNameCount = normalised.length - groups.length;
  const channelsFor = usePlayerChannels(normalised);

  useEffect(() => setVisibleCount(200), [search, sort.sortBy, sort.sortDir, minGames, mmrImpactFilter, groupByPlayer]);

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
        onOpen={onOpen}
      />

      <div className="flex flex-wrap items-center gap-3">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="search opponent name or ID…"
          aria-label="Search opponents"
          className="w-full rounded-lg border-2 border-line bg-bg-surface px-3 py-[0.55rem] text-text transition-colors placeholder:text-text-dim focus:border-accent focus:outline-none min-h-[44px]"
        />
        <MinGamesPicker value={minGames} onChange={setMinGames} />
        <label className="flex min-h-[44px] items-center gap-2 rounded-lg border-2 border-line bg-bg-surface px-2.5">
          <span className="whitespace-nowrap text-micro uppercase tracking-wider text-text-dim">
            MMR impact
          </span>
          <select
            value={mmrImpactFilter}
            onChange={(event) =>
              setMmrImpactFilter(event.target.value as MmrImpactFilter)
            }
            aria-label="Filter opponents by MMR impact"
            className="min-h-[32px] bg-transparent text-xs text-text focus:outline-none"
          >
            <option value="all">All opponents</option>
            <option value="tracked">Verified pairs only</option>
            <option value="net-gain">You gained overall</option>
            <option value="net-loss">They gained overall</option>
          </select>
        </label>
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
            {items.length.toLocaleString()} of {groups.length.toLocaleString()}
            {groupByPlayer ? " players" : ""} shown
            {groupByPlayer && mergedNameCount > 0
              ? ` · ${normalised.length.toLocaleString()} names grouped`
              : null}
            {pagesFetched > 1 ? ` · ${pagesFetched} pages` : null}
            {hitMaxPages ? " · narrow your filter for more" : null}
          </span>
          {isMmrImpactLoading || hitMmrImpactMaxPages ? (
            <span className="text-xs text-text-dim">
              {isMmrImpactLoading
                ? "Loading verified MMR impact..."
                : "Some MMR impact rows were omitted; narrow the global filters."}
            </span>
          ) : null}
          <span className="hidden text-xs text-text-dim sm:inline">
            click any column to sort · click a row to open deep dive →
          </span>
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
          <NoOpponentsMatch
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
              </>
            }
          />
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
                  col="pulseCharacterId"
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
                <th className="w-8 px-1 py-1.5 text-right text-text-dim">→</th>
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
                    onToggle={toggleGroup} onOpen={onOpen} channelsFor={channelsFor} />
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

const OpponentRow = memo(function OpponentRow({ row: o, expanded, onToggle, onOpen, channelsFor }: {
  row: OpponentGroup<Opp>; expanded: boolean; onToggle: (id: string) => void;
  onOpen: (id: string) => void; channelsFor: ReturnType<typeof usePlayerChannels>;
}) {
  return (
                  <Fragment>
                    <tr
                      onClick={() => onOpen(o.pulseId)}
                      className="group cursor-pointer border-t border-border hover:bg-accent/10"
                    >
                      <td
                        className="px-2 py-1 text-text group-hover:text-accent"
                        title={groupRowTitle(o)}
                      >
                        <span className="flex min-w-0 items-center gap-1">
                          <span className="truncate">
                            {o.name || (
                              <span className="italic text-text-dim">unnamed</span>
                            )}
                          </span>
                          <RevealedChip
                            name={o.revealedName}
                            displayedName={o.name}
                            approved={!!o.globalIdentity}
                          />
                          <PlayerChannelLinks channels={channelsFor(o) || o.identities.map(channelsFor).find(Boolean)} playerName={o.revealedName || o.name} compact />
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
                        {o.lastPlayed ? fmtAgo(o.lastPlayed) : "—"}
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
}: {
  identity: Opp;
  channels?: PlayerChannels;
  onOpen: (pulseId: string) => void;
}) {
  const revealedName = identity.globalIdentity?.displayName.trim() || identity.revealedName;
  return (
    <tr
      onClick={() => onOpen(identity.pulseId)}
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
          <span className="truncate">
            {identity.name || (
              <span className="italic text-text-dim">unnamed</span>
            )}
          </span>
          <RevealedChip name={revealedName} displayedName={identity.name} approved={!!identity.globalIdentity} />
          <PlayerChannelLinks channels={channels} playerName={revealedName || identity.name} compact />
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
        {identity.lastPlayed ? fmtAgo(identity.lastPlayed) : "—"}
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
  onOpen: (pulseId: string) => void;
}) {
  const name = opponent.name || "unnamed opponent";
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onOpen(opponent.pulseId);
      }}
      aria-label={`Open ${name} opponent details`}
      className="inline-flex h-7 w-7 items-center justify-center rounded text-current hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <span aria-hidden>→</span>
    </button>
  );
}

/**
 * Revealed identity pill. For a barcode opponent the
 * displayed name is unreadable bars, so the revealed pro/main name is
 * the only human-legible identity — surface it inline next to the name.
 * Renders nothing when the opponent isn't revealed, or when the row
 * already displays the revealed name as its main name (a grouped row
 * whose most-known name IS the reveal — repeating it is clutter).
 */
function RevealedChip({
  name,
  displayedName,
  approved = false,
}: {
  name?: string | null;
  displayedName?: string;
  approved?: boolean;
}) {
  const tag = typeof name === "string" ? name.trim() : "";
  if (!tag || tag === (displayedName || "").trim()) return null;
  return (
    <span
      className="inline-flex flex-shrink-0 items-center gap-1 rounded-full bg-accent-cyan/15 px-2 py-0.5 text-micro font-semibold text-accent-cyan"
      title={approved ? `Confirmed as ${tag}` : `Revealed on SC2Pulse as ${tag}`}
    >
      <span className="text-[0.6rem] font-medium uppercase tracking-wider opacity-70">
        aka
      </span>
      <span className="max-w-[10rem] truncate">{tag}</span>
    </span>
  );
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
