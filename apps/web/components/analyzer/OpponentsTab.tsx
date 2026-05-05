"use client";

import { useMemo, useState } from "react";
import { useApi } from "@/lib/clientApi";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { fmtAgo, pct1, wrColor } from "@/lib/format";
import { Skeleton, EmptyState } from "@/components/ui/Card";
import { useSort, SortableTh } from "@/components/ui/SortableTh";

type Opp = {
  pulseId: string;
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

type OpponentsResponse = {
  items: Opp[];
};

/**
 * Opponents tab — full filters, search, sort, drilldown.
 * Mirrors `OpponentsTab` from the legacy analyzer SPA.
 */
export function OpponentsTab({
  onOpen,
}: {
  onOpen: (pulseId: string) => void;
}) {
  const { filters, dbRev } = useFilters();
  const [search, setSearch] = useState("");
  const [minGames, setMinGames] = useState(1);
  const sort = useSort("lastPlayed", "desc");

  const params = useMemo(
    () => ({ ...filters, search, min_games: minGames, limit: 1000 }),
    [filters, search, minGames],
  );
  const path = `/v1/opponents${filtersToQuery(params)}`;
  const { data, isLoading } = useApi<OpponentsResponse | Opp[]>(
    `${path}#${dbRev}`,
  );

  const rawItems: Opp[] = useMemo(() => {
    if (!data) return [];
    const arr = Array.isArray(data) ? data : data.items || [];
    return arr.map((o) => ({
      ...o,
      name: o.name || o.displayNameSample || "",
      games: o.games ?? o.gameCount ?? o.wins + o.losses,
      winRate:
        o.winRate ??
        (o.wins + o.losses > 0 ? o.wins / (o.wins + o.losses) : 0),
      lastPlayed: o.lastPlayed || o.lastSeen || null,
    }));
  }, [data]);

  // Client-side min-games filter. The API doesn't honour `min_games`
  // on /v1/opponents, so without this the input did nothing.
  const filteredItems = useMemo(
    () => rawItems.filter((o) => (o.games || 0) >= minGames),
    [rawItems, minGames],
  );

  const items = useMemo(
    () => sort.sortRows(filteredItems, (row, col) => (row as any)[col]),
    [filteredItems, sort],
  );

  if (isLoading) return <Skeleton rows={8} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="search opponent name or ID…"
          className="input w-72"
        />
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-text-dim">
            Min games
          </span>
          <input
            type="number"
            min={1}
            value={minGames}
            onChange={(e) => setMinGames(Number(e.target.value) || 1)}
            className="input w-20"
          />
        </div>
        <span className="text-xs text-text-dim">
          click any column to sort · click a row to open deep dive →
        </span>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-bg-elevated">
            <tr>
              <SortableTh col="name" label="Opponent" {...sort} />
              <SortableTh col="pulseId" label="Pulse ID" {...sort} width="8rem" />
              <SortableTh col="wins" label="W" {...sort} align="right" width="5rem" />
              <SortableTh col="losses" label="L" {...sort} align="right" width="5rem" />
              <SortableTh col="games" label="Games" {...sort} align="right" width="5rem" />
              <SortableTh col="winRate" label="Win rate" {...sort} align="right" width="6rem" />
              <SortableTh col="lastPlayed" label="Last" {...sort} align="right" width="8rem" />
              <th className="w-10 px-3 py-2 text-right text-text-dim">→</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
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
                  <td
                    className="truncate px-3 py-1.5 font-mono text-xs text-text-dim"
                    title={o.pulseId}
                  >
                    {o.pulseId}
                  </td>
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
