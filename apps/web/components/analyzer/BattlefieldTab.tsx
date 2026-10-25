"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useApi } from "@/lib/clientApi";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { useLocalStoragePositiveInt } from "@/lib/useLocalStorageState";
import { pct1, wrColor } from "@/lib/format";
import { Card, WrBar } from "@/components/ui/Card";
import { QueryState } from "@/components/ui/QueryState";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { useSort, usePersistentSort, SortableTh } from "@/components/ui/SortableTh";
import { MinGamesPicker } from "@/components/ui/MinGamesPicker";
import { MapLabel } from "@/components/maps/MapArtwork";
import { MapPreviewDialog } from "@/components/maps/MapPreviewDialog";
import { NoFilterMatches } from "./EmptyStates";
import { useSeasons } from "@/lib/useSeasons";
import { currentMapPoolKey } from "@/lib/currentMapPool";
import { useCurrentMapPool } from "@/lib/useCurrentMapPool";
import { useMapFocus } from "@/lib/useMapFocus";
import { MapVetoPlanner } from "./maps/MapVetoPlanner";
import { MapGamesModal } from "./maps/MapGamesModal";
import type { MapGamesDrill } from "./maps/MapVetoTable";
import { Toggle } from "@/components/ui/Toggle";
import { opponentRace, poolMapRows } from "@/lib/mapVeto";
import { sumStrength, type StrengthFields } from "@/lib/strengthAdjusted";
import { StrengthCell, StrengthGuide, WinRateRange } from "./StrengthAdjusted";

type Row = StrengthFields & {
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
type MapMatchupRow = StrengthFields & {
  map: string;
  matchup: string;
  wins: number;
  losses: number;
  total: number;
  winRate: number | null;
};

/** A map with its per-matchup breakdown, grouped client-side. */
type MapMatchupGroup = StrengthFields & {
  map: string;
  maps: string[];
  wins: number;
  losses: number;
  total: number;
  winRate: number | null;
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
  const ordered = [...results].reverse();
  const summary = ordered.map((result) => (result === "win" ? "win" : "loss")).join(", ");
  return (
    <div
      className="flex items-center gap-[3px]"
      role="img"
      aria-label={`Recent form, oldest to newest: ${summary}`}
    >
      {ordered.map((r, i) => (
        <span
          key={i}
          aria-hidden="true"
          style={{
            width: 8,
            height: 8,
            borderRadius: 2,
            background: r === "win" ? "rgb(var(--success))" : "rgb(var(--danger))",
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
  const [drill, setDrill] = useState<MapGamesDrill | null>(null);
  const [poolPreference, setPoolPreference] = useState<boolean | null>(null);
  const catalog = useSeasons(); const pool = useCurrentMapPool(catalog.data);
  const poolOnly = poolPreference ?? pool.fresh;
  const focus = useMapFocus(), handledFocus = useRef<string | null>(null), scrolledFocus = useRef<string | null>(null);

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
    const names = new Map<string, string>();
    for (const row of mapMuApi.data ?? []) if (!names.has(currentMapPoolKey(row.map))) names.set(currentMapPoolKey(row.map), row.map);
    const groups = poolMapRows([...names.values()], mapMuApi.data ?? []).map((row) => {
      const source = (mapMuApi.data ?? []).filter(cell => currentMapPoolKey(cell.map) === currentMapPoolKey(row.gameMap));
      return { map: row.gameMap, maps: row.gameMaps, ...sumStrength(source), winRateRange: row.all.ci,
      wins: row.all.wins, losses: row.all.losses, total: row.all.total, winRate: row.all.winRate,
      cells: Object.entries(row.cells).map(([race, cell]) => ({ map: row.gameMap, matchup: race === "unknown" ? "vs Unknown" : `vs ${race}`, wins: cell.wins, losses: cell.losses, total: cell.total, winRate: cell.winRate,
        ...sumStrength(source.filter(entry => opponentRace(entry.matchup) === race)), winRateRange: cell.ci,
      })).filter((cell) => cell.total >= minGames).sort((a, b) => b.total - a.total),
    }; }).filter((group) => group.cells.length > 0);
    // Stable alphabetical input gives equal numeric values a deterministic
    // map-name tie-break when the selected sort is applied below.
    groups.sort((a, b) => a.map.localeCompare(b.map));
    return groups;
  }, [mapMuApi.data, minGames]);

  const mapSort = usePersistentSort("analyzer.maps.sort", "winRate", "desc");
  const muSort = useSort("total", "desc");

  const sortedMapMatchupGroups = useMemo(
    () =>
      mapSort.sortRows(mapMatchupGroups.filter((group) => !poolOnly || pool.maps.some((map) => currentMapPoolKey(map) === currentMapPoolKey(group.map))), (group, col) =>
        col === "map"
          ? group.map.toLocaleLowerCase()
          : (group as unknown as Record<string, unknown>)[col],
      ),
    [mapMatchupGroups, mapSort, poolOnly, pool.maps],
  );
  const sortedMu = useMemo(
    () =>
      muSort.sortRows(muRows, (row, col) =>
        (row as Record<string, unknown>)[col],
      ),
    [muRows, muSort],
  );

  // Rows the Min games picker is hiding, for the empty states' "Lower
  // Min games to 1" offer.
  const hiddenMatchups = (muApi.data?.length ?? 0) - muRows.length;
  const hiddenMapCells =
    new Set((mapMuApi.data ?? []).map((row) => `${currentMapPoolKey(row.map)}:${row.matchup}`)).size -
    mapMatchupGroups.reduce((n, g) => n + g.cells.length, 0);

  useEffect(() => {
    if (!focus) { handledFocus.current = null; scrolledFocus.current = null; return; }
    if (handledFocus.current === focus || !mapMuApi.data) return;
    const row = mapMuApi.data.find((entry) => currentMapPoolKey(entry.map) === currentMapPoolKey(focus));
    if (!row) return;
    handledFocus.current = focus; setMinGames(1);
    if (!pool.maps.some((map) => currentMapPoolKey(map) === currentMapPoolKey(row.map))) setPoolPreference(false);
    setDrill({ map: row.map, maps: [...new Set(mapMuApi.data.filter((entry) => currentMapPoolKey(entry.map) === currentMapPoolKey(row.map)).map((entry) => entry.map))] });
  }, [focus, mapMuApi.data, setMinGames, pool.maps]);
  useEffect(() => {
    if (!focus || scrolledFocus.current === focus) return;
    const row = document.getElementById(`map-${currentMapPoolKey(focus)}`);
    if (row) { row.scrollIntoView?.({ block: "center" }); scrolledFocus.current = focus; }
  }, [focus, sortedMapMatchupGroups]);

  return (
    <div className="space-y-5">
      <MapVetoPlanner openGames={setDrill} />
      <div className="flex items-center justify-end">
        <MinGamesPicker value={minGames} onChange={setMinGames} />
      </div>

      <Card title="Matchups">
        <div className="mb-3 space-y-2"><StrengthGuide /><button type="button" aria-label="Sort matchups by vs expected" aria-pressed={muSort.sortBy === "winsAboveExpected"} className="min-h-11 rounded-lg border border-border px-3 text-caption" onClick={() => muSort.setSortExplicit("winsAboveExpected", muSort.sortBy === "winsAboveExpected" && muSort.sortDir === "desc" ? "asc" : "desc")}>Vs expected {muSort.sortBy === "winsAboveExpected" ? muSort.sortDir === "desc" ? "↓" : "↑" : ""}</button></div>
        <QueryState
          q={muApi}
          skeleton={<SkeletonRows rows={4} label="Loading matchups" />}
          filtered
          isEmpty={() => sortedMu.length === 0}
          empty={
            <NoFilterMatches
              title="No matchups match these filters"
              minGames={minGames}
              hiddenByMinGames={hiddenMatchups}
              onLowerMinGames={() => setMinGames(1)}
            />
          }
        >
          {() => (
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
                    <WinRateRange row={m} total={m.total} />
                    <StrengthCell row={m} />
                  </li>
                ))}
              </ul>

              {/* Desktop — table. ``table-fixed`` + explicit colgroup
                  so the W/L/Games/WR columns pack tightly and don't grab
                  equal shares of leftover space. */}
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full min-w-[40rem] table-fixed text-sm">
                  <colgroup>
                    <col />
                    <col style={{ width: "3.5rem" }} />
                    <col style={{ width: "3.5rem" }} />
                    <col style={{ width: "4.5rem" }} />
                    <col style={{ width: "4.5rem" }} />
                    <col style={{ width: "7rem" }} />
                    <col style={{ width: "8rem" }} />
                  </colgroup>
                  <thead className="bg-bg-elevated">
                    <tr>
                      <SortableTh col="name" label="Matchup" {...muSort} />
                      <SortableTh col="wins" label="W" {...muSort} align="right" />
                      <SortableTh col="losses" label="L" {...muSort} align="right" />
                      <SortableTh col="total" label="Games" {...muSort} align="right" />
                      <SortableTh col="winRate" label="WR" {...muSort} align="right" />
                      <SortableTh col="winsAboveExpected" label="Vs expected" {...muSort} align="right" />
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
                          <WinRateRange row={m} total={m.total} />
                        </td>
                        <td className="px-2 py-1.5 text-right"><StrengthCell row={m} /></td>
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
        </QueryState>
      </Card>

      <Card title="Win rate by map by matchup">
        <div className="mb-3"><StrengthGuide /></div>
        <QueryState
          q={mapMuApi}
          skeleton={<SkeletonRows rows={4} label="Loading map matchups" />}
          filtered
          isEmpty={() => sortedMapMatchupGroups.length === 0}
          empty={
            <NoFilterMatches
              title="No map matchups match these filters"
              minGames={minGames}
              hiddenByMinGames={hiddenMapCells}
              onLowerMinGames={() => setMinGames(1)}
              extraAction={poolOnly ? <button type="button" onClick={() => setPoolPreference(false)} className="min-h-11 px-3 text-accent underline">Show all maps</button> : undefined}
            />
          }
        >
          {() => (
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
                      <option value="winsAboveExpected">Vs expected</option>
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
              <div className="mb-4 space-y-2"><label className="flex min-h-11 items-center gap-3 text-caption font-medium text-text"><Toggle checked={poolOnly} onChange={setPoolPreference} label="Current ladder pool only" /><span>Current ladder pool only</span></label>{!pool.fresh ? <p className="text-micro text-warning">Pool data may be out of date; showing all maps by default.</p> : null}</div>

              <ul
                className="space-y-4"
                aria-label="Map performance by matchup"
              >
                {sortedMapMatchupGroups.map((g) => (
                  <li key={g.map} id={`map-${currentMapPoolKey(g.map)}`} className={`space-y-2 scroll-mt-32 ${focus && currentMapPoolKey(focus) === currentMapPoolKey(g.map) ? "rounded-lg ring-2 ring-accent" : ""}`}>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border pb-2">
                      <button
                        type="button"
                        aria-label={`View games on ${g.map}`}
                        aria-haspopup="dialog"
                        onClick={() => setDrill({ map: g.map, maps: g.maps })}
                        className="group/map -m-1 inline-flex min-h-11 w-full min-w-0 max-w-full items-center rounded-lg p-1 text-left transition-colors hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:w-auto sm:flex-1"
                      >
                        <MapLabel
                          name={g.map}
                          size="sm"
                          className="min-w-0"
                          textClassName="text-sm font-semibold text-text group-hover/map:text-accent"
                        />
                      </button>
                      <button type="button" aria-label={`Open larger preview of ${g.map}`} aria-haspopup="dialog" onClick={() => setPreviewMap(g.map)} className="min-h-11 shrink-0 rounded px-2 text-micro text-accent hover:underline">Preview map</button>
                      <span className="ml-auto shrink-0 text-micro text-text-dim">
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
                    <div className="mb-2 flex flex-wrap items-center justify-end gap-2"><WinRateRange row={g} total={g.total} /><StrengthCell row={g} /></div>
                    <ul className="space-y-2 pl-1">
                      {g.cells.map((c) => (
                        <li key={c.matchup} className="flex flex-col gap-1">
                          <div className="flex items-baseline justify-between gap-2 text-micro">
                            <button type="button" onClick={() => setDrill({ map: g.map, maps: g.maps, opponent: c.matchup.replace(/^vs\s*/i, "") })} className="min-h-11 rounded px-1 font-medium text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" aria-label={`View ${c.matchup} games on ${g.map}`}>
                              {c.matchup}
                            </button>
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
                          <div className="flex flex-wrap items-center justify-between gap-2"><StrengthCell row={c} /><WinRateRange row={c} total={c.total} /></div>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </>
          )}
        </QueryState>
      </Card>

      <MapPreviewDialog
        mapName={previewMap}
        onClose={() => setPreviewMap(null)}
      />
      {drill ? <MapGamesModal drill={drill} onClose={() => setDrill(null)} /> : null}
    </div>
  );
}

