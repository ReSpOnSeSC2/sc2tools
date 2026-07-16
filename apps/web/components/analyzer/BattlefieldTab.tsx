"use client";

import { useMemo } from "react";
import { useApi } from "@/lib/clientApi";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { useLocalStoragePositiveInt } from "@/lib/useLocalStorageState";
import { pct1, wrColor } from "@/lib/format";
import { Card, EmptyState, Skeleton, WrBar } from "@/components/ui/Card";
import { useSort, SortableTh } from "@/components/ui/SortableTh";
import { MinGamesPicker } from "@/components/ui/MinGamesPicker";
import { MapArtwork, MapLabel } from "@/components/maps/MapArtwork";

type Row = {
  /** Matchup label ("vs P") or map name. The API returns this as `name`
   *  for both /v1/maps and /v1/matchups, but the UI displays it as the
   *  Matchup or Map column. */
  name: string;
  wins: number;
  losses: number;
  total: number;
  winRate: number;
  recent?: ("win" | "loss")[];
};

type MapRow = Row;
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
  inverse = false,
}: {
  results?: ("win" | "loss")[];
  inverse?: boolean;
}) {
  if (!results || results.length === 0)
    return (
      <span className={`text-micro ${inverse ? "text-white/60" : "text-text-dim"}`}>
        no recent
      </span>
    );
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

function MapPerformanceCard({ map, eager }: { map: MapRow; eager: boolean }) {
  const winRatePercent = Math.max(0, Math.min(100, map.winRate * 100));
  const accessibleLabel = `${map.name}: ${pct1(map.winRate)} win rate, ${map.wins} wins, ${map.losses} losses, ${map.total} games`;

  return (
    <li>
      <article
        tabIndex={0}
        aria-label={accessibleLabel}
        className="group/map relative isolate aspect-[16/10] min-h-52 overflow-hidden rounded-xl border border-border-strong bg-bg-elevated shadow-lg motion-safe:transition-[border-color,box-shadow,transform] motion-safe:duration-300 motion-safe:ease-out hover:-translate-y-0.5 hover:border-accent/70 hover:shadow-halo-accent focus-visible:-translate-y-0.5 focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface focus-visible:[&_img]:scale-[1.06] focus-visible:[&_img]:brightness-110"
      >
        <div className="absolute inset-0">
          <MapArtwork
            mapName={map.name}
            size="card"
            className="border-0"
            eager={eager}
          />
        </div>
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-[radial-gradient(circle_at_76%_16%,transparent_0%,rgba(0,0,0,0.14)_42%,rgba(0,0,0,0.66)_100%)] opacity-90 motion-safe:transition-opacity motion-safe:duration-300 group-hover/map:opacity-75 group-focus-visible/map:opacity-75"
        />
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-gradient-to-t from-black/95 via-black/45 to-black/10"
        />

        <div className="relative flex h-full flex-col justify-between p-4 text-white">
          <div className="flex items-start justify-between gap-3">
            <span className="rounded-full border border-white/20 bg-black/45 px-2.5 py-1 text-micro font-semibold uppercase tracking-wider text-white/80 backdrop-blur-sm">
              {map.total} {map.total === 1 ? "game" : "games"}
            </span>
            <span
              className="rounded-md border border-white/20 bg-black/55 px-2.5 py-1 font-mono text-lg font-bold tabular-nums backdrop-blur-sm"
              style={{ color: wrColor(map.winRate, map.total) }}
            >
              {pct1(map.winRate)}
            </span>
          </div>

          <div>
            <h4 className="text-balance text-lg font-bold leading-tight text-white drop-shadow-md">
              {map.name}
            </h4>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <span className="text-caption font-medium text-white/80">
                <span className="text-success">{map.wins}W</span>
                <span aria-hidden="true"> &middot; </span>
                <span className="text-danger">{map.losses}L</span>
              </span>
              <span className="flex items-center gap-2">
                <span className="text-micro uppercase tracking-wider text-white/55">
                  Recent
                </span>
                <FormSparkline results={map.recent} inverse />
              </span>
            </div>
            <div
              className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/20"
              role="progressbar"
              aria-label={`${map.name} win rate`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(winRatePercent)}
            >
              <span
                className="block h-full rounded-full motion-safe:transition-[width] motion-safe:duration-500"
                style={{
                  width: `${winRatePercent}%`,
                  backgroundColor: wrColor(map.winRate, map.total),
                }}
              />
            </div>
          </div>
        </div>
      </article>
    </li>
  );
}

export function BattlefieldTab() {
  const { filters, dbRev } = useFilters();
  const [minGames, setMinGames] = useLocalStoragePositiveInt(LS_MIN_MAPS, 3);

  const mapsApi = useApi<MapRow[]>(
    `/v1/maps${filtersToQuery(filters)}#${dbRev}`,
  );
  const muApi = useApi<MatchupRow[]>(
    `/v1/matchups${filtersToQuery(filters)}#${dbRev}`,
  );
  const mapMuApi = useApi<MapMatchupRow[]>(
    `/v1/maps/matchups${filtersToQuery(filters)}#${dbRev}`,
  );

  const mapRows = useMemo(
    () => (mapsApi.data || []).filter((m) => (m.total || 0) >= minGames),
    [mapsApi.data, minGames],
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
    groups.sort((a, b) => b.total - a.total);
    return groups;
  }, [mapMuApi.data, minGames]);

  const mapSort = useSort("winRate", "desc");
  const muSort = useSort("total", "desc");

  const sortedMaps = useMemo(
    () =>
      mapSort.sortRows(mapRows, (row, col) =>
        (row as Record<string, unknown>)[col],
      ),
    [mapRows, mapSort],
  );
  const sortedMu = useMemo(
    () =>
      muSort.sortRows(muRows, (row, col) =>
        (row as Record<string, unknown>)[col],
      ),
    [muRows, muSort],
  );

  if (mapsApi.isLoading || muApi.isLoading || mapMuApi.isLoading)
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

      <Card
        title="Win rate by map"
        right={
          (mapsApi.data || []).length > sortedMaps.length ? (
            <span className="text-micro text-text-dim">
              {sortedMaps.length} of {(mapsApi.data || []).length} maps
              shown · {((mapsApi.data || []).length - sortedMaps.length)}{" "}
              hidden by min games ≥ {minGames}
            </span>
          ) : null
        }
      >
        {sortedMaps.length === 0 ? (
          <EmptyState
            title="No maps match"
            sub={
              (mapsApi.data || []).length > 0
                ? `${(mapsApi.data || []).length} map${(mapsApi.data || []).length === 1 ? "" : "s"} hidden by the Min games ≥ ${minGames} filter. Drop it to 1 to see every map.`
                : undefined
            }
          />
        ) : (
          <>
            {/* Artwork-led desktop view; the compact list below keeps the
                same information easy to scan on narrow screens. */}
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <p className="max-w-xl text-caption text-text-dim">
                Compare performance at a glance. Every card uses the same live
                replay totals as the detailed table.
              </p>
              <div
                className="flex items-center gap-2"
                role="group"
                aria-label="Map sorting controls"
              >
                <label className="flex items-center gap-2 text-micro font-semibold uppercase tracking-wider text-text-dim">
                  Sort
                  <select
                    aria-label="Sort maps by"
                    value={mapSort.sortBy}
                    onChange={(event) =>
                      mapSort.setSortExplicit(event.target.value, mapSort.sortDir)
                    }
                    className="h-8 rounded-md border border-border-strong bg-bg-elevated px-2 text-caption font-medium normal-case tracking-normal text-text outline-none transition-colors hover:border-accent/70 focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/40"
                  >
                    <option value="name">Map</option>
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
                  className="h-8 rounded-md border border-border-strong bg-bg-elevated px-2.5 text-caption font-medium text-text transition-colors hover:border-accent/70 hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  {mapSort.sortBy === "name"
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
              className="hidden grid-cols-1 gap-4 md:grid lg:grid-cols-2 2xl:grid-cols-3"
              aria-label="Map performance gallery"
            >
              {sortedMaps.map((map, index) => (
                <MapPerformanceCard
                  key={map.name}
                  map={map}
                  eager={index < 2}
                />
              ))}
            </ul>

            {/* Mobile — stacked list. */}
            <ul className="divide-y divide-border md:hidden">
              {sortedMaps.map((m) => (
                <li key={m.name} className="flex flex-col gap-1.5 px-1 py-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <MapLabel
                      name={m.name}
                      size="sm"
                      className="min-w-0 flex-1"
                      textClassName="text-sm font-medium text-text"
                    />
                    <span
                      className="shrink-0 font-mono text-sm tabular-nums"
                      style={{ color: wrColor(m.winRate, m.total) }}
                    >
                      {pct1(m.winRate)}
                    </span>
                  </div>
                  <div className="text-micro text-text-dim">
                    <span className="text-success">{m.wins}W</span> ·{" "}
                    <span className="text-danger">{m.losses}L</span> ·{" "}
                    {m.total} games
                  </div>
                  <WrBar wins={m.wins} losses={m.losses} />
                </li>
              ))}
            </ul>

            {/* Exact sortable values remain available without making the
                gallery compete with a second always-visible view. */}
            <details className="group/table mt-5 hidden border-t border-border pt-3 md:block">
              <summary className="flex cursor-pointer list-none items-center justify-between rounded-md px-2 py-2 text-caption font-semibold text-text-muted transition-colors hover:bg-bg-elevated hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                <span>Detailed sortable table</span>
                <span
                  aria-hidden="true"
                  className="text-text-dim motion-safe:transition-transform group-open/table:rotate-180"
                >
                  &#8964;
                </span>
              </summary>
              <div className="mt-2 overflow-x-auto rounded-lg border border-border">
                <table className="w-full table-fixed text-sm">
                <colgroup>
                  <col />
                  <col style={{ width: "3.5rem" }} />
                  <col style={{ width: "3.5rem" }} />
                  <col style={{ width: "4.5rem" }} />
                  <col style={{ width: "4.5rem" }} />
                </colgroup>
                <thead className="bg-bg-elevated">
                  <tr>
                    <SortableTh col="name" label="Map" {...mapSort} />
                    <SortableTh col="wins" label="W" {...mapSort} align="right" />
                    <SortableTh col="losses" label="L" {...mapSort} align="right" />
                    <SortableTh col="total" label="Games" {...mapSort} align="right" />
                    <SortableTh col="winRate" label="WR" {...mapSort} align="right" />
                  </tr>
                </thead>
                <tbody>
                  {sortedMaps.map((m) => (
                    <tr key={m.name} className="border-t border-border">
                      <td className="px-3 py-1.5">
                        <MapLabel
                          name={m.name}
                          size="xs"
                          className="w-full"
                          textClassName="font-medium text-text"
                        />
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
                    </tr>
                  ))}
                </tbody>
                </table>
              </div>
            </details>
          </>
        )}
      </Card>

      <Card
        title="Win rate by map by matchup"
        right={
          mapMatchupGroups.length > 0 ? (
            <span className="text-micro text-text-dim">
              matchup cells with ≥ {minGames} games
            </span>
          ) : null
        }
      >
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
          <ul className="space-y-4">
            {mapMatchupGroups.map((g) => (
              <li key={g.map} className="space-y-2">
                <div className="flex items-center justify-between gap-3 border-b border-border pb-2">
                  <MapLabel
                    name={g.map}
                    size="sm"
                    className="min-w-0 flex-1"
                    textClassName="text-sm font-semibold text-text"
                  />
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
                    <li
                      key={c.matchup}
                      className="flex flex-col gap-1"
                    >
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
        )}
      </Card>
    </div>
  );
}

