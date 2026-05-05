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
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";
import { useSort, SortableTh } from "@/components/ui/SortableTh";

type MapRow = {
  name: string;
  wins: number;
  losses: number;
  total: number;
  winRate: number;
};

type MatchupRow = {
  matchup: string;
  wins: number;
  losses: number;
  total: number;
  winRate: number;
  recent?: ("win" | "loss")[];
};

type MapDiagnosticRow = {
  value: string | null;
  kind: "string" | "empty" | "missing";
  length: number | null;
  count: number;
};

type MapDiagnostic = {
  total: number;
  distinct: number;
  rows: MapDiagnosticRow[];
};

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
            className={`px-2 py-1 text-xs tabular-nums transition ${
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

type DiagSwrShape = {
  data: MapDiagnostic | undefined;
  isLoading: boolean;
  error: unknown;
};

function MapDiagnosticDisclosure({
  open,
  onToggle,
  api,
}: {
  open: boolean;
  onToggle: (next: boolean) => void;
  api: DiagSwrShape;
}) {
  return (
    <details
      open={open}
      onToggle={(e) => onToggle((e.target as HTMLDetailsElement).open)}
      className="rounded border border-border bg-bg-surface px-3 py-2 text-sm text-text-muted"
    >
      <summary className="cursor-pointer select-none">
        Map diagnostic{" "}
        <span className="text-text-dim">
          (every distinct map value the agent uploaded — useful when the panel
          above looks wrong)
        </span>
      </summary>
      <div className="mt-3">
        {!open ? null : api.isLoading ? (
          <Skeleton rows={3} />
        ) : api.error ? (
          <div className="text-danger">Failed to load map diagnostic.</div>
        ) : !api.data || api.data.rows.length === 0 ? (
          <div className="text-text-dim">No games yet.</div>
        ) : (
          <>
            <div className="mb-2 text-xs text-text-dim">
              {api.data.distinct} distinct value
              {api.data.distinct === 1 ? "" : "s"} across {api.data.total}{" "}
              games.
              {api.data.distinct === 1 ? (
                <>
                  {" "}
                  Only one distinct value means every uploaded record is tagged
                  the same — the bug is upstream of this view (in the
                  agent&apos;s replay parser or upload payload), not in the
                  aggregation.
                </>
              ) : null}
            </div>
            <table className="w-full text-sm">
              <thead className="bg-bg-elevated">
                <tr>
                  <th className="px-3 py-2 text-left text-[11px] uppercase text-text-dim">
                    Raw map value
                  </th>
                  <th className="px-3 py-2 text-right text-[11px] uppercase text-text-dim">
                    Length
                  </th>
                  <th className="px-3 py-2 text-right text-[11px] uppercase text-text-dim">
                    Games
                  </th>
                </tr>
              </thead>
              <tbody>
                {api.data.rows.map((row, i) => (
                  <tr key={i} className="border-t border-border">
                    <td className="px-3 py-1.5 font-mono text-xs">
                      {renderRawValue(row)}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {row.length ?? "—"}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {row.count}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </details>
  );
}

function renderRawValue(row: MapDiagnosticRow) {
  if (row.kind === "missing") {
    return <span className="italic text-text-dim">missing field</span>;
  }
  if (row.kind === "empty") {
    return <span className="italic text-text-dim">empty string</span>;
  }
  // JSON.stringify makes whitespace and zero-width chars visible.
  return JSON.stringify(row.value ?? "");
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
  // Diagnostic disclosure is rendered always but only fetched when the
  // user opens it. Gate the SWR key on the open flag so collapsed users
  // don't pay the round-trip.
  const [diagOpen, setDiagOpen] = useState(false);
  const diagApi = useApi<MapDiagnostic>(
    diagOpen ? `/v1/maps/diagnostic#${dbRev}` : null,
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
    () => mapSort.sortRows(mapRows, (row, col) => (row as any)[col]),
    [mapRows, mapSort],
  );
  const sortedMu = useMemo(
    () => muSort.sortRows(muRows, (row, col) => (row as any)[col]),
    [muRows, muSort],
  );

  if (mapsApi.isLoading || muApi.isLoading) return <Skeleton rows={6} />;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-end">
        <MinGames value={minGames} onChange={setMinGames} />
      </div>

      <MapDiagnosticDisclosure
        open={diagOpen}
        onToggle={setDiagOpen}
        api={diagApi}
      />

      <Card title="Matchups">
        {sortedMu.length === 0 ? (
          <EmptyState title="No matchups match" />
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-bg-elevated">
              <tr>
                <SortableTh col="matchup" label="Matchup" {...muSort} />
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
                <tr key={m.matchup} className="border-t border-border">
                  <td className="px-3 py-1.5">{m.matchup}</td>
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
        )}
      </Card>

      <Card title="Win rate by map">
        {sortedMaps.length === 0 ? (
          <EmptyState title="No maps match" />
        ) : (
          <>
            <div className="h-72">
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
            <table className="mt-4 w-full text-sm">
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
          </>
        )}
      </Card>
    </div>
  );
}
