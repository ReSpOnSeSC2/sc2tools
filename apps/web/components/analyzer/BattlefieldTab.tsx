"use client";

import { useMemo, useState } from "react";
import { useApi } from "@/lib/clientApi";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { useLocalStoragePositiveInt } from "@/lib/useLocalStorageState";
import { pct1, wrColor } from "@/lib/format";
import { Card, EmptyState, Skeleton, WrBar } from "@/components/ui/Card";
import { useSort, SortableTh } from "@/components/ui/SortableTh";
import { MinGamesPicker } from "@/components/ui/MinGamesPicker";
import { MapLabel } from "@/components/maps/MapArtwork";
import { MapPreviewDialog } from "@/components/maps/MapPreviewDialog";

type Row = {
  /** Matchup label ("vs P"). */
  name: string;
  wins: number;
  losses: number;
  total: number;
  winRate: number;
  recent?: ("win" | "loss")[];
};

type MatchupRow = Row;

/** One (map, matchup) cell from /v1/maps/matchups. */
type MapMatchupRow = {
  map: string;
  matchup: string;
  wins: number;
  losses: number;
  total: number;
  winRate: number;
};

/** A map with its per-matchup breakdown, grouped client-side. */
type MapMatchupGroup = {
  map: string;
  wins: number;
  losses: number;
  total: number;
  winRate: number;
  cells: MapMatchupRow[];
};

const LS_MIN_MAPS = "analyzer.battlefield.maps.minGames";

function FormSparkline({
  results,
}: {
  results?: ("win" | "loss")[];
}) {
  if (!results || results.length === 0)
    return <span className="text-micro text-text-dim">no recent</span>;
  const summary = results.map((result) => (result === "win" ? "win" : "loss")).join(", ");
  return (
    <div
      className="flex items-center gap-[3px]"
      role="img"
      aria-label={`Recent form, oldest to newest: ${summary}`}
    >
      {results.map((r, i) => (
        <span
          key={i}
          aria-hidden="true"
          style={{
            width: 8,
            height: 8,
            borderRadius: 2,
            background: r === "win" ? "#3ec07a" : "#ff6b6b",
            display: "inline-block",
          }}
        />
      ))}
    </div>
  );
}

export function BattlefieldTab() {
  const { filters, dbRev } = useFilters();
  const [minGames, setMinGames] = useLocalStoragePositiveInt(LS_MIN_MAPS, 3);
  const [previewMap, setPreviewMap] = useState<string | null>(null);

  const muApi = useApi<MatchupRow[]>(
    `/v1/matchups${filtersToQuery(filters)}#${dbRev}`,
  );
  const mapMuApi = useApi<MapMatchupRow[]>(
    `/v1/maps/matchups${filtersToQuery(filters)}#${dbRev}`,
  );

  const muRows = useMemo(
    () => (muApi.data || []).filter((m) => (m.total || 0) >= minGames),
    [muApi.data, minGames],
  );

  // Group the flat (map, matchup) cells by map. A cell must clear the
  // Min games threshold to be shown; a map appears only if at least one
  // of its matchup cells qualifies. Map-level totals sum every cell
  // (shown or not) so the header reflects the map's full record.
  const mapMatchupGroups = useMemo<MapMatchupGroup[]>(() => {
    const byMap = new Map<string, MapMatchupGroup>();
    for (const r of mapMuApi.data || []) {
      let g = byMap.get(r.map);
      if (!g) {
        g = { map: r.map, wins: 0, losses: 0, total: 0, winRate: 0, cells: [] };
        byMap.set(r.map, g);
      }
      g.wins += r.wins || 0;
      g.losses += r.losses || 0;
      g.total += r.total || 0;
      if ((r.total || 0) >= minGames) g.cells.push(r);
    }
    const groups: MapMatchupGroup[] = [];
    for (const g of byMap.values()) {
      if (g.cells.length === 0) continue;
      g.winRate = g.total ? g.wins / g.total : 0;
      g.cells.sort((a, b) => b.total - a.total);
      groups.push(g);
    }
    // Stable alphabetical input gives equal numeric values a deterministic
    // map-name tie-break when the selected sort is applied below.
    groups.sort((a, b) => a.map.localeCompare(b.map));
    return groups;
  }, [mapMuApi.data, minGames]);

  const mapSort = useSort("winRate", "desc");
  const muSort = useSort("total", "desc");

  const sortedMapMatchupGroups = useMemo(
    () =>
      mapSort.sortRows(mapMatchupGroups, (group, col) =>
        col === "map"
          ? group.map.toLocaleLowerCase()
          : (group as unknown as Record<string, unknown>)[col],
      ),
    [mapMatchupGroups, mapSort],
  );
  const sortedMu = useMemo(
    () =>
      muSort.sortRows(muRows, (row, col) =>
        (row as Record<string, unknown>)[col],
      ),
    [muRows, muSort],
  );

  if (muApi.isLoading || mapMuApi.isLoading)
    return <Skeleton rows={6} />;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-end">
        <MinGamesPicker value={minGames} onChange={setMinGames} />
      </div>

      <Card title="Matchups">
        {sortedMu.length === 0 ? (
          <EmptyState title="No matchups match" />
        ) : (
          <>
            {/* Mobile — stacked rows. */}
            <ul className="divide-y divide-border md:hidden">
              {sortedMu.map((m) => (
                <li key={m.name} className="flex flex-col gap-1.5 px-1 py-2.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-medium text-text">
                      {m.name}
                    </span>
                    <span
                      className="font-mono text-sm tabular-nums"
                      style={{ color: wrColor(m.winRate, m.total) }}
                    >
                      {pct1(m.winRate)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3 text-micro text-text-dim">
                    <span>
                      <span className="text-success">{m.wins}W</span> ·{" "}
                      <span className="text-danger">{m.losses}L</span> ·{" "}
                      {m.total} games
                    </span>
                    <FormSparkline results={m.recent} />
                  </div>
                  <WrBar wins={m.wins} losses={m.losses} />
                </li>
              ))}
            </ul>

            {/* Desktop — table. ``table-fixed`` + explicit colgroup
                so the W/L/Games/WR columns pack tightly and don't grab
                equal shares of leftover space. */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full table-fixed text-sm">
                <colgroup>
                  <col />
                  <col style={{ width: "3.5rem" }} />
                  <col style={{ width: "3.5rem" }} />
                  <col style={{ width: "4.5rem" }} />
                  <col style={{ width: "4.5rem" }} />
                  <col style={{ width: "7rem" }} />
                </colgroup>
                <thead className="bg-bg-elevated">
                  <tr>
                    <SortableTh col="name" label="Matchup" {...muSort} />
                    <SortableTh col="wins" label="W" {...muSort} align="right" />
                    <SortableTh col="losses" label="L" {...muSort} align="right" />
                    <SortableTh col="total" label="Games" {...muSort} align="right" />
                    <SortableTh col="winRate" label="WR" {...muSort} align="right" />
                    <th className="px-3 py-2 text-right text-micro uppercase text-text-dim">
                      Recent
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sortedMu.map((m) => (
                    <tr key={m.name} className="border-t border-border">
                      <td className="truncate px-3 py-1.5 font-medium" title={m.name}>
                        {m.name}
                      </td>
                      <td className="px-2 py-1.5 text-right text-success">{m.wins}</td>
                      <td className="px-2 py-1.5 text-right text-danger">{m.losses}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{m.total}</td>
                      <td
                        className="px-2 py-1.5 text-right tabular-nums"
                        style={{ color: wrColor(m.winRate, m.total) }}
                      >
                        {pct1(m.winRate)}
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        <FormSparkline results={m.recent} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>

      <Card title="Win rate by map by matchup">
        {mapMatchupGroups.length === 0 ? (
          <EmptyState
            title="No map matchups match"
            sub={
              (mapMuApi.data || []).length > 0
                ? `Every map-matchup cell is hidden by the Min games ≥ ${minGames} filter. Drop it to 1 to see them all.`
                : undefined
            }
          />
        ) : (
          <>
            <div className="mb-4 flex flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-caption text-text-dim">
                Each map shows its overall record. Matchup rows require at
                least {minGames} games.
              </p>
              <div
                className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:flex-nowrap"
                role="group"
                aria-label="Map sorting controls"
              >
                <label className="flex min-w-0 flex-1 items-center gap-2 text-micro font-semibold uppercase tracking-wider text-text-dim sm:flex-none">
                  Sort
                  <select
                    aria-label="Sort maps by"
                    value={mapSort.sortBy}
                    onChange={(event) =>
                      mapSort.setSortExplicit(event.target.value, mapSort.sortDir)
                    }
                    className="h-9 min-w-0 flex-1 rounded-md border border-border-strong bg-bg-elevated px-2 text-caption font-medium normal-case tracking-normal text-text outline-none transition-colors hover:border-accent/70 focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/40 sm:flex-none"
                  >
                    <option value="map">Map</option>
                    <option value="winRate">Win rate</option>
                    <option value="total">Games</option>
                    <option value="wins">Wins</option>
                    <option value="losses">Losses</option>
                  </select>
                </label>
                <button
                  type="button"
                  aria-label={`Sort direction: ${
                    mapSort.sortDir === "asc" ? "ascending" : "descending"
                  }. Activate to reverse.`}
                  onClick={() =>
                    mapSort.setSortExplicit(
                      mapSort.sortBy,
                      mapSort.sortDir === "asc" ? "desc" : "asc",
                    )
                  }
                  className="h-9 shrink-0 whitespace-nowrap rounded-md border border-border-strong bg-bg-elevated px-2.5 text-caption font-medium text-text transition-colors hover:border-accent/70 hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  {mapSort.sortBy === "map"
                    ? mapSort.sortDir === "asc"
                      ? "A to Z"
                      : "Z to A"
                    : mapSort.sortDir === "asc"
                      ? "Low to high"
                      : "High to low"}
                </button>
              </div>
            </div>

            <ul
              className="space-y-4"
              aria-label="Map performance by matchup"
            >
              {sortedMapMatchupGroups.map((g) => (
                <li key={g.map} className="space-y-2">
                  <div className="flex items-center justify-between gap-3 border-b border-border pb-2">
                    <button
                      type="button"
                      aria-label={`Open larger preview of ${g.map}`}
                      aria-haspopup="dialog"
                      onClick={() => setPreviewMap(g.map)}
                      className="group/map -m-1 inline-flex min-h-11 min-w-0 max-w-full cursor-zoom-in items-center rounded-lg p-1 text-left transition-colors hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    >
                      <MapLabel
                        name={g.map}
                        size="sm"
                        className="min-w-0"
                        textClassName="text-sm font-semibold text-text group-hover/map:text-accent"
                      />
                    </button>
                    <span className="shrink-0 text-micro text-text-dim">
                      <span className="text-success">{g.wins}W</span> ·{" "}
                      <span className="text-danger">{g.losses}L</span> ·{" "}
                      <span
                        className="font-mono tabular-nums"
                        style={{ color: wrColor(g.winRate, g.total) }}
                      >
                        {pct1(g.winRate)}
                      </span>
                    </span>
                  </div>
                  <ul className="space-y-2 pl-1">
                    {g.cells.map((c) => (
                      <li key={c.matchup} className="flex flex-col gap-1">
                        <div className="flex items-baseline justify-between gap-2 text-micro">
                          <span className="font-medium text-text-dim">
                            {c.matchup}
                          </span>
                          <span className="flex items-baseline gap-2">
                            <span className="text-text-dim">
                              <span className="text-success">{c.wins}W</span> ·{" "}
                              <span className="text-danger">{c.losses}L</span> ·{" "}
                              {c.total}
                            </span>
                            <span
                              className="w-12 text-right font-mono tabular-nums"
                              style={{ color: wrColor(c.winRate, c.total) }}
                            >
                              {pct1(c.winRate)}
                            </span>
                          </span>
                        </div>
                        <WrBar wins={c.wins} losses={c.losses} />
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>

      <MapPreviewDialog
        mapName={previewMap}
        onClose={() => setPreviewMap(null)}
      />
    </div>
  );
}

