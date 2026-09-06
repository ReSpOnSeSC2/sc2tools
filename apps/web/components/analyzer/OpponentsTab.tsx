"use client";

import { Fragment, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  ExternalLink,
  TrendingDown,
  TrendingUp,
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
  type OpponentGroup,
  type PulseLinksResponse,
} from "@/lib/opponentGroups";
import { Skeleton, EmptyState } from "@/components/ui/Card";
import { Toggle } from "@/components/ui/Toggle";
import { useSort, SortableTh } from "@/components/ui/SortableTh";
import { MinGamesPicker } from "@/components/ui/MinGamesPicker";
import { useAllNetMmrOpponents, type NetMmrOpponentRow } from "@/lib/netMmrOpponents";

const LS_MIN_OPP = "analyzer.opponents.minGames";

type MmrImpactFilter = "all" | "tracked" | "net-gain" | "net-loss";

type Opp = {
  pulseId: string;
  pulseCharacterId?: string | null;
  toonHandle?: string | null;
  name?: string;
  displayNameSample?: string;
  // SC2Pulse "revealed" identity behind a barcode — the pro/main name
  // the community linked on sc2pulse.nephest.com. Absent for opponents
  // who aren't revealed.
  revealedName?: string | null;
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
  const { items: rawItems, isLoading, error, pagesFetched, hitMaxPages } =
    useApiPaginated<Opp>(path, dbRev);

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
  const { data: pulseLinks } = useApi<PulseLinksResponse>(
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
      ),
    [normalised, groupByPlayer, pulseLinks],
  );

  // Client-side search across every identity in a group (names,
  // aliases, revealed name, pulse ids, toon handles). The backend
  // `search` query param is a no-op for the legacy endpoint, so
  // filter here.
  const searchedItems = useMemo(() => {
    const q = search.trim();
    if (!q) return groups;
    return groups.filter((g) => groupMatchesSearch(g, q));
  }, [groups, search]);

  const filteredItems = useMemo(
    () =>
      searchedItems.filter(
        (o) =>
          (o.games || 0) >= minGames
          && matchesMmrImpactFilter(o, mmrImpactFilter),
      ),
    [searchedItems, minGames, mmrImpactFilter],
  );

  const items = useMemo(
    () => sort.sortRows(filteredItems, (row, col) => (row as any)[col]),
    [filteredItems, sort],
  );

  const mergedNameCount = normalised.length - groups.length;
  const channelsFor = usePlayerChannels(normalised);

  const toggleGroup = (pulseId: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(pulseId)) next.delete(pulseId);
      else next.add(pulseId);
      return next;
    });
  };

  const showSkeleton = isLoading && rawItems.length === 0;

  return (
    <div className="space-y-4">
      <MmrImpactLeaders
        mostWon={mmrImpactSummary?.mostMmrGainedFrom}
        mostLost={mmrImpactSummary?.mostMmrLostTo}
        loading={isMmrImpactLoading}
        unavailable={!!mmrImpactError}
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
          title="Merge names SC2Pulse links to the same player into one row"
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
          <span className="text-xs text-text-dim">
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

      {error ? (
        <div className="rounded-md border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
          Could not load opponents — {error.message}
        </div>
      ) : null}

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
          <tbody>
            {showSkeleton ? (
              <tr>
                <td colSpan={12} className="px-3 py-3">
                  <Skeleton rows={8} />
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={12}>
                  <EmptyState title="No opponents match these filters" />
                </td>
              </tr>
            ) : (
              items.map((o) => (
                <Fragment key={o.pulseId}>
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
                        />
                        <PlayerChannelLinks channels={channelsFor(o) || o.identities.map(channelsFor).find(Boolean)} playerName={o.revealedName || o.name} compact />
                        {o.groupSize > 1 ? (
                          <AliasChip
                            group={o}
                            expanded={expandedGroups.has(o.pulseId)}
                            onToggle={() => toggleGroup(o.pulseId)}
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
                  {o.groupSize > 1 && expandedGroups.has(o.pulseId)
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
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MmrImpactLeaders({
  mostWon,
  mostLost,
  loading,
  unavailable,
  onOpen,
}: {
  mostWon: NetMmrOpponentRow | null | undefined;
  mostLost: NetMmrOpponentRow | null | undefined;
  loading: boolean;
  unavailable: boolean;
  onOpen: (pulseId: string) => void;
}) {
  return (
    <section aria-labelledby="opponent-mmr-impact-heading">
      <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h3
            id="opponent-mmr-impact-heading"
            className="text-sm font-semibold text-text"
          >
            Opponent MMR impact
          </h3>
          <p className="text-xs text-text-dim">
            Verified game-time MMR from consecutive ranked 1v1 replay pairs.
          </p>
        </div>
        <span className="text-micro uppercase tracking-wider text-text-dim">
          Respects global filters
        </span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {loading ? (
          <>
            <div className="h-24 animate-pulse rounded-xl border-2 border-line bg-bg-surface" />
            <div className="h-24 animate-pulse rounded-xl border-2 border-line bg-bg-surface" />
          </>
        ) : unavailable ? (
          <div
            role="alert"
            className="rounded-xl border-2 border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning sm:col-span-2"
          >
            Opponent history loaded, but verified MMR impact is temporarily unavailable.
          </div>
        ) : mostWon || mostLost ? (
          <>
            <MmrLeaderCard
              kind="won"
              opponent={mostWon}
              onOpen={onOpen}
            />
            <MmrLeaderCard
              kind="lost"
              opponent={mostLost}
              onOpen={onOpen}
            />
          </>
        ) : (
          <div className="rounded-xl border-2 border-line bg-bg-surface px-4 py-3 text-sm text-text-muted sm:col-span-2">
            No verified opponent MMR pairs match the current filters yet.
          </div>
        )}
      </div>
    </section>
  );
}

function MmrLeaderCard({
  kind,
  opponent,
  onOpen,
}: {
  kind: "won" | "lost";
  opponent: NetMmrOpponentRow | null | undefined;
  onOpen: (pulseId: string) => void;
}) {
  const won = kind === "won";
  const value = opponent?.netMmr || 0;
  const Icon = won ? TrendingUp : TrendingDown;
  if (!opponent) {
    return (
      <div className="rounded-xl border-2 border-line bg-bg-surface px-4 py-3 text-sm text-text-dim">
        No net MMR {won ? "gains" : "losses"} in this range.
      </div>
    );
  }
  const name = opponent.name || opponent.displayName || "unnamed opponent";
  const openId = opponent.pulseId || opponent.toonHandle || null;
  const content = (
    <>
      <span
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${
          won ? "bg-success/15 text-success" : "bg-danger/15 text-danger"
        }`}
      >
        <Icon className="h-5 w-5" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-micro uppercase tracking-wider text-text-dim">
          {won ? "Most net MMR won from" : "Most net MMR lost to"}
        </span>
        <span className="block truncate font-semibold text-text group-hover:text-accent">
          {name}
        </span>
        <span className="block text-xs tabular-nums text-text-dim">
          {opponent.pairs} verified{" "}
          {opponent.pairs === 1 ? "pair" : "pairs"}
        </span>
      </span>
      <span
        className={`text-lg font-bold tabular-nums ${won ? "text-success" : "text-danger"}`}
      >
        {formatSignedMmr(value)}
      </span>
    </>
  );
  const cardClass =
    "group flex min-h-[92px] items-center gap-3 rounded-xl border-2 border-line bg-bg-surface px-4 py-3 text-left shadow-hard";
  if (!openId) return <div className={cardClass}>{content}</div>;
  return (
    <button
      type="button"
      onClick={() => onOpen(openId)}
      className={`${cardClass} transition hover:-translate-y-0.5 hover:border-accent/60 hover:bg-accent/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent`}
      aria-label={`Open ${name}, ${won ? "most net MMR won" : "most net MMR lost"}`}
    >
      {content}
    </button>
  );
}

function MmrImpactCells({ opponent }: { opponent: Opp }) {
  const pairs = opponent.mmrPairs || 0;
  const tracked = pairs > 0 && typeof opponent.netMmr === "number";
  if (!tracked) {
    return (
      <>
        <td className="px-2 py-1 text-right text-text-dim">{"\u2014"}</td>
        <td className="px-2 py-1 text-right text-text-dim">{"\u2014"}</td>
        <td className="px-2 py-1 text-right text-text-dim">{"\u2014"}</td>
      </>
    );
  }
  const net = opponent.netMmr || 0;
  return (
    <>
      <td
        className={`px-2 py-1 text-right leading-tight tabular-nums ${
          net > 0 ? "text-success" : net < 0 ? "text-danger" : "text-text-muted"
        }`}
        title={`${pairs} verified ${pairs === 1 ? "pair" : "pairs"}; average ${formatSignedDecimal(opponent.mmrAvgDelta)} MMR per pair`}
      >
        <span className="font-semibold">{formatSignedMmr(net)}</span>
        <span className="block text-micro font-normal leading-tight text-text-dim">
          {pairs.toLocaleString()} {pairs === 1 ? "pair" : "pairs"}
        </span>
      </td>
      <td className="px-2 py-1 text-right font-medium tabular-nums text-success">
        +{Math.round(opponent.mmrWon || 0).toLocaleString()}
      </td>
      <td className="px-2 py-1 text-right font-medium tabular-nums text-danger">
        -{Math.round(opponent.mmrLost || 0).toLocaleString()}
      </td>
    </>
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

function formatSignedMmr(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "\u2014";
  const rounded = Math.round(value);
  return `${rounded > 0 ? "+" : ""}${rounded.toLocaleString()}`;
}

function formatSignedDecimal(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "\u2014";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}`;
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
      title={`Same player on SC2Pulse · also plays as ${group.aliasNames.join(", ")}`}
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
          <PlayerChannelLinks channels={channels} playerName={identity.revealedName || identity.name} compact />
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
 * SC2Pulse "revealed" identity pill. For a barcode opponent the
 * displayed name is unreadable bars, so the revealed pro/main name is
 * the only human-legible identity — surface it inline next to the name.
 * Renders nothing when the opponent isn't revealed, or when the row
 * already displays the revealed name as its main name (a grouped row
 * whose most-known name IS the reveal — repeating it is clutter).
 */
function RevealedChip({
  name,
  displayedName,
}: {
  name?: string | null;
  displayedName?: string;
}) {
  const tag = typeof name === "string" ? name.trim() : "";
  if (!tag || tag === (displayedName || "").trim()) return null;
  return (
    <span
      className="inline-flex flex-shrink-0 items-center gap-1 rounded-full bg-accent-cyan/15 px-2 py-0.5 text-micro font-semibold text-accent-cyan"
      title={`Revealed on SC2Pulse as ${tag}`}
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
