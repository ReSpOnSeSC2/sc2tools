"use client";

import { useEffect, useMemo, useState } from "react";
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
import { pct1, wrColor } from "@/lib/format";
import { Card, EmptyState, Skeleton, WrBar } from "@/components/ui/Card";
import { useSort, SortableTh } from "@/components/ui/SortableTh";

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

const LS_MIN_MAPS = "analyzer.battlefield.maps.minGames";
const MIN_STEPS = [1, 3, 5, 10, 20];

function readLs<T>(key: string, fb: T): T {
  if (typeof window === "undefined") return fb;
  try {
    const v = window.localStorage.getItem(key);
    return v == null ? fb : (JSON.parse(v) as T);
  } catch {
    return fb;
  }
}

function writeLs(key: string, v: unknown) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* non-fatal */
  }
}

function MinGames({
  value,
  onChange,
}: {
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[11px] uppercase tracking-wider text-text-dim">
        Min games
      </span>
      <div className="inline-flex overflow-hidden rounded border border-border">
        {MIN_STEPS.map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => onChange(n)}
            className={`px-3 py-1.5 text-xs tabular-nums transition sm:px-2 sm:py-1 ${
              value === n
                ? "bg-accent/20 text-accent"
                : "text-text-muted hover:bg-bg-elevated"
            }`}
          >
            {n}
          </button>
        ))}
      </div>
    </div>
  );
}

function FormSparkline({ results }: { results?: ("win" | "loss")[] }) {
  if (!results || results.length === 0)
    return <span className="text-[11px] text-text-dim">no recent</span>;
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
  const [minGames, setMinGames] = useState<number>(() =>
    readLs(LS_MIN_MAPS, 3),
  );
  useEffect(() => writeLs(LS_MIN_MAPS, minGames), [minGames]);

  const mapsApi = useApi<MapRow[]>(
    `/v1/maps${filtersToQuery(filters)}#${dbRev}`,
  );
  const muApi = useApi<MatchupRow[]>(
    `/v1/matchups${filtersToQuery(filters)}#${dbRev}`,
  );

  const mapRows = useMemo(
    () => (mapsApi.data || []).filter((m) => (m.total || 0) >= minGames),
    [mapsApi.data, minGames],
  );
  const muRows = useMemo(
    () => (muApi.data || []).filter((m) => (m.total || 0) >= minGames),
    [muApi.data, minGames],
  );

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

  if (mapsApi.isLoading || muApi.isLoading) return <Skeleton rows={6} />;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-end">
        <MinGames value={minGames} onChange={setMinGames} />
      </div>

      <MapDiagnostic />

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
                  <div className="flex items-center justify-between gap-3 text-[11px] text-text-dim">
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

            {/* Desktop — table. */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-bg-elevated">
                  <tr>
                    <SortableTh col="name" label="Matchup" {...muSort} />
                    <SortableTh col="wins" label="W" {...muSort} align="right" />
                    <SortableTh col="losses" label="L" {...muSort} align="right" />
                    <SortableTh col="total" label="Games" {...muSort} align="right" />
                    <SortableTh col="winRate" label="WR" {...muSort} align="right" />
                    <th className="px-3 py-2 text-right text-[11px] uppercase text-text-dim">
                      Recent
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sortedMu.map((m) => (
                    <tr key={m.name} className="border-t border-border">
                      <td className="px-3 py-1.5 font-medium">{m.name}</td>
                      <td className="px-3 py-1.5 text-right text-success">{m.wins}</td>
                      <td className="px-3 py-1.5 text-right text-danger">{m.losses}</td>
                      <td className="px-3 py-1.5 text-right">{m.total}</td>
                      <td
                        className="px-3 py-1.5 text-right tabular-nums"
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
            <span className="text-[11px] text-text-dim">
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
                  <div className="text-[11px] text-text-dim">
                    <span className="text-success">{m.wins}W</span> ·{" "}
                    <span className="text-danger">{m.losses}L</span> ·{" "}
                    {m.total} games
                  </div>
                  <WrBar wins={m.wins} losses={m.losses} />
                </li>
              ))}
            </ul>

            {/* Desktop — table. */}
            <div className="mt-4 hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
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
                      <td className="px-3 py-1.5">{m.name}</td>
                      <td className="px-3 py-1.5 text-right text-success">{m.wins}</td>
                      <td className="px-3 py-1.5 text-right text-danger">{m.losses}</td>
                      <td className="px-3 py-1.5 text-right">{m.total}</td>
                      <td
                        className="px-3 py-1.5 text-right tabular-nums"
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
    </div>
  );
}

type MapDiagnosticItem = {
  map: string;
  count: number;
  firstSeen?: string | null;
  lastSeen?: string | null;
};

function MapDiagnostic() {
  const { dbRev } = useFilters();
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useApi<{ items: MapDiagnosticItem[] }>(
    open ? `/v1/maps/diagnostic#${dbRev}` : null,
  );
  const items = data?.items || [];
  const total = items.reduce((acc, m) => acc + m.count, 0);

  return (
    <details
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      className="rounded-lg border border-border bg-bg-surface p-3 text-sm"
    >
      <summary className="cursor-pointer select-none text-text-muted">
        Map diagnostic{" "}
        <span className="text-text-dim">
          (every distinct map value the agent uploaded — useful when the
          panel above looks wrong)
        </span>
      </summary>
      {!open ? null : isLoading ? (
        <p className="mt-2 text-xs text-text-dim">Loading…</p>
      ) : items.length === 0 ? (
        <p className="mt-2 text-xs text-text-dim">No games yet.</p>
      ) : (
        <>
          <p className="mt-2 text-xs text-text-dim">
            {items.length} distinct map{items.length === 1 ? "" : "s"} across{" "}
            {total} games.{" "}
            {items.length === 1
              ? "Every replay you've uploaded has this exact map name. If you've actually played on more than one map, the agent isn't picking up sc2reader's map_name correctly — try restarting the agent or re-running it on a fresh replay."
              : "Looks healthy."}
          </p>
          <ul className="mt-2 divide-y divide-border text-xs">
            {items.map((m) => (
              <li
                key={m.map}
                className="flex flex-wrap items-center justify-between gap-2 py-1.5"
              >
                <code className="font-mono text-text">{m.map}</code>
                <span className="tabular-nums text-text-muted">
                  {m.count} games
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </details>
  );
}
