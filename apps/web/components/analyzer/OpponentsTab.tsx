"use client";

import { useMemo, useState } from "react";
import { ExternalLink } from "lucide-react";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { useApiPaginated } from "@/lib/useApiPaginated";
import { fmtAgo, pct1, wrColor } from "@/lib/format";
import { pickPulseLabel, sc2pulseCharacterUrl } from "@/lib/sc2pulse";
import { Skeleton, EmptyState } from "@/components/ui/Card";
import { useSort, SortableTh } from "@/components/ui/SortableTh";

type Opp = {
  pulseId: string;
  pulseCharacterId?: string | null;
  toonHandle?: string | null;
  name?: string;
  displayNameSample?: string;
  wins: number;
  losses: number;
  games: number;
  gameCount?: number;
  winRate: number;
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
 */
export function OpponentsTab({
  onOpen,
}: {
  onOpen: (pulseId: string) => void;
}) {
  const { filters, dbRev } = useFilters();
  const [search, setSearch] = useState("");
  // The input is a controlled string so the user can backspace through
  // the existing value on mobile (and desktop) without it snapping back
  // to "1" mid-edit. The numeric `minGames` derives from it.
  const [minGamesText, setMinGamesText] = useState("1");
  const minGames = Math.max(1, Number.parseInt(minGamesText, 10) || 1);
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

  const normalised: Opp[] = useMemo(() => {
    return (rawItems || []).map((o) => ({
      ...o,
      name: o.name || o.displayNameSample || "",
      games: o.games ?? o.gameCount ?? o.wins + o.losses,
      winRate:
        o.winRate
        ?? (o.wins + o.losses > 0 ? o.wins / (o.wins + o.losses) : 0),
      lastPlayed: o.lastPlayed || o.lastSeen || null,
    }));
  }, [rawItems]);

  // Client-side search across name + ids. The backend `search` query
  // param is a no-op for the legacy endpoint, so filter here.
  const searchedItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return normalised;
    return normalised.filter((o) => {
      const name = (o.name || "").toLowerCase();
      const pulse = (o.pulseId || "").toLowerCase();
      const toon = (o.toonHandle || "").toLowerCase();
      const cid = (o.pulseCharacterId || "").toString().toLowerCase();
      return (
        name.includes(q)
        || pulse.includes(q)
        || toon.includes(q)
        || cid.includes(q)
      );
    });
  }, [normalised, search]);

  const filteredItems = useMemo(
    () => searchedItems.filter((o) => (o.games || 0) >= minGames),
    [searchedItems, minGames],
  );

  const items = useMemo(
    () => sort.sortRows(filteredItems, (row, col) => (row as any)[col]),
    [filteredItems, sort],
  );

  const showSkeleton = isLoading && rawItems.length === 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="search opponent name or ID…"
          aria-label="Search opponents"
          className="input min-h-[44px] w-full sm:w-72"
        />
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-text-dim">
            Min games
          </span>
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={minGamesText}
            onChange={(e) => {
              const next = e.target.value.replace(/\D/g, "");
              setMinGamesText(next);
            }}
            onBlur={() => {
              if (!minGamesText || Number.parseInt(minGamesText, 10) < 1) {
                setMinGamesText("1");
              }
            }}
            aria-label="Minimum games"
            className="input min-h-[44px] w-20"
          />
        </div>
        <div className="ml-auto flex w-full flex-col items-end gap-1 sm:w-auto">
          <span className="text-xs text-text-dim">
            {items.length.toLocaleString()} of {normalised.length.toLocaleString()} shown
            {pagesFetched > 1 ? ` · ${pagesFetched} pages` : null}
            {hitMaxPages ? " · narrow your filter for more" : null}
          </span>
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

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-bg-elevated">
            <tr>
              <SortableTh col="name" label="Opponent" {...sort} />
              <SortableTh
                col="pulseCharacterId"
                label="Pulse ID"
                {...sort}
                width="9rem"
              />
              <SortableTh col="wins" label="W" {...sort} align="right" width="5rem" />
              <SortableTh col="losses" label="L" {...sort} align="right" width="5rem" />
              <SortableTh col="games" label="Games" {...sort} align="right" width="5rem" />
              <SortableTh col="winRate" label="Win rate" {...sort} align="right" width="6rem" />
              <SortableTh col="lastPlayed" label="Last" {...sort} align="right" width="8rem" />
              <th className="w-10 px-3 py-2 text-right text-text-dim">→</th>
            </tr>
          </thead>
          <tbody>
            {showSkeleton ? (
              <tr>
                <td colSpan={8} className="px-3 py-3">
                  <Skeleton rows={8} />
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={8}>
                  <EmptyState title="No opponents match these filters" />
                </td>
              </tr>
            ) : (
              items.map((o) => (
                <tr
                  key={o.pulseId}
                  onClick={() => onOpen(o.pulseId)}
                  className="group cursor-pointer border-t border-border hover:bg-accent/10"
                >
                  <td
                    className="truncate px-3 py-1.5 text-text group-hover:text-accent"
                    title={o.name || ""}
                  >
                    {o.name || (
                      <span className="italic text-text-dim">unnamed</span>
                    )}
                  </td>
                  <PulseIdCell opp={o} />

                  <td className="px-3 py-1.5 text-right tabular-nums text-success">
                    {o.wins}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-danger">
                    {o.losses}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-text-muted">
                    {o.games}
                  </td>
                  <td
                    className="px-3 py-1.5 text-right tabular-nums"
                    style={{ color: wrColor(o.winRate, o.games) }}
                  >
                    {pct1(o.winRate)}
                  </td>
                  <td className="px-3 py-1.5 text-right text-xs text-text-dim">
                    {o.lastPlayed ? fmtAgo(o.lastPlayed) : "—"}
                  </td>
                  <td className="px-3 py-1.5 text-right text-text-dim group-hover:text-accent">
                    →
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
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
      <td className="px-3 py-1.5 text-xs text-text-dim">—</td>
    );
  }
  if (label.isPulseCharacterId) {
    return (
      <td
        className="truncate px-3 py-1.5 font-mono text-xs"
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
      className="truncate px-3 py-1.5 font-mono text-xs text-text-dim"
      title={`${label.value} · sc2pulse character id not resolved yet`}
    >
      {label.value}
      <span className="ml-1 text-[10px] uppercase tracking-wider text-text-dim/70">
        toon
      </span>
    </td>
  );
}
