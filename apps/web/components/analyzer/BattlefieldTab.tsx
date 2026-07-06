"use client";

import { useMemo } from "react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import { useApi } from "@/lib/clientApi";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { useLocalStoragePositiveInt } from "@/lib/useLocalStorageState";
import { pct1, wrColor } from "@/lib/format";
import { Card, EmptyState, Skeleton, WrBar } from "@/components/ui/Card";
import { useSort, SortableTh } from "@/components/ui/SortableTh";
import { MinGamesPicker } from "@/components/ui/MinGamesPicker";

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

function FormSparkline({ results }: { results?: ("win" | "loss")[] }) {
  if (!results || results.length === 0)
    return <span className="text-micro text-text-dim">no recent</span>;
  return (
    <div className="flex items-center gap-[3px]">
      {results.map((r, i) => (
        <span
          key={i}
          title={r}
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
            {/* Bar chart hides on small screens — it doesn't read well at
                phone widths and the mobile list below shows the same data. */}
            <div className="hidden h-72 sm:block">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={sortedMaps.map((m) => ({
                    ...m,
                    winRatePct: Math.round(m.winRate * 100),
                  }))}
                  layout="vertical"
                  margin={{ left: 80 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#1f2533" />
                  <XAxis
                    type="number"
                    domain={[0, 100]}
                    stroke="#6b7280"
                    fontSize={11}
                    unit="%"
                  />
                  <YAxis
                    dataKey="name"
                    type="category"
                    stroke="#6b7280"
                    fontSize={11}
                    width={140}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "#11141b",
                      border: "1px solid #1f2533",
                      borderRadius: 8,
                    }}
                  />
                  <Bar dataKey="winRatePct" fill="#7c8cff" />
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Mobile — stacked list. */}
            <ul className="divide-y divide-border md:hidden">
              {sortedMaps.map((m) => (
                <li key={m.name} className="flex flex-col gap-1.5 px-1 py-2.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-medium text-text">
                      {m.name}
                    </span>
                    <span
                      className="font-mono text-sm tabular-nums"
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

            {/* Desktop — table. ``table-fixed`` + explicit colgroup
                packs the W/L/Games/WR columns tight against the name
                column. */}
            <div className="mt-4 hidden md:block overflow-x-auto">
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
                      <td className="truncate px-3 py-1.5" title={m.name}>
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
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
                <div className="flex items-baseline justify-between gap-2 border-b border-border pb-1.5">
                  <span
                    className="truncate text-sm font-semibold text-text"
                    title={g.map}
                  >
                    {g.map}
                  </span>
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

