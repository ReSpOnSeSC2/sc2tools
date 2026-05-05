"use client";

import { useMemo, useState } from "react";
import { useApi, API_BASE } from "@/lib/clientApi";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { fmtAgo, pct1, wrColor } from "@/lib/format";
import { Card, EmptyState, Skeleton, WrBar } from "@/components/ui/Card";
import { useSort, SortableTh } from "@/components/ui/SortableTh";
import { MapIntelViewer } from "./MapIntelViewer";

export type MapEntry = {
  name: string;
  total: number;
  wins: number;
  losses: number;
  winRate: number;
  lastPlayed?: string | null;
  hasSpatial?: boolean;
  bounds?: { minX: number; minY: number; maxX: number; maxY: number } | null;
};

/**
 * Map intel tab — list of maps the user has played, with W/L/WR for
 * each one (parity with the legacy SPA `maps` table) plus a heatmap
 * viewer when a map is picked. Maps without spatial extracts still
 * appear in the list; the viewer just shows an empty layer.
 */
export function MapIntelTab() {
  const { filters, dbRev } = useFilters();
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [hideSmall, setHideSmall] = useState(false);
  const sort = useSort("total", "desc");

  const { data, isLoading, error } = useApi<MapEntry[]>(
    `/v1/spatial/maps${filtersToQuery(filters)}#${dbRev}`,
  );

  const rows = useMemo(() => {
    let r = (data || []).slice();
    const q = search.trim().toLowerCase();
    if (q) r = r.filter((m) => m.name.toLowerCase().includes(q));
    if (hideSmall) r = r.filter((m) => m.total >= 3);
    return sort.sortRows(r, (row, col) => (row as Record<string, unknown>)[col]);
  }, [data, search, hideSmall, sort]);

  if (isLoading) return <Skeleton rows={6} />;
  if (error) {
    return (
      <Card>
        <EmptyState title="Couldn't load maps" sub={error.message} />
      </Card>
    );
  }
  if (!data || data.length === 0) {
    return (
      <Card>
        <EmptyState
          title="No maps yet"
          sub="Once your agent uploads at least one analysed replay, your maps will appear here."
        />
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <input
          className="input w-72"
          placeholder="search map…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="flex items-center gap-1.5 text-xs text-text-muted">
          <input
            type="checkbox"
            checked={hideSmall}
            onChange={(e) => setHideSmall(e.target.checked)}
          />
          hide maps with &lt; 3 games
        </label>
        <span className="text-xs text-text-dim">
          {rows.length} of {data.length} maps
        </span>
      </div>

      <Card>
        {rows.length === 0 ? (
          <EmptyState title="No maps match those filters" />
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-bg-elevated">
              <tr>
                <SortableTh col="name" label="Map" {...sort} />
                <SortableTh col="wins" label="W" {...sort} align="right" />
                <SortableTh col="losses" label="L" {...sort} align="right" />
                <SortableTh col="total" label="Games" {...sort} align="right" />
                <SortableTh col="winRate" label="WR" {...sort} align="right" />
                <th className="w-32 px-3 py-2 text-left text-[11px] uppercase text-text-dim">
                  Trend
                </th>
                <SortableTh
                  col="lastPlayed"
                  label="Last played"
                  {...sort}
                  align="right"
                />
                <th className="w-20 px-3 py-2 text-right text-[11px] uppercase text-text-dim">
                  Heatmap
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <MapRow
                  key={m.name}
                  m={m}
                  selected={selected === m.name}
                  onSelect={() => setSelected(m.name)}
                />
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {selected ? (
        <MapIntelViewer
          mapName={selected}
          summary={data.find((m) => m.name === selected) || null}
        />
      ) : null}
    </div>
  );
}

function MapRow({
  m,
  selected,
  onSelect,
}: {
  m: MapEntry;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <tr
      className={[
        "cursor-pointer border-t border-border hover:bg-accent/10",
        selected ? "bg-accent/10" : "",
      ].join(" ")}
      onClick={onSelect}
    >
      <td className="px-3 py-1.5 text-text">
        <div className="flex items-center gap-3">
          <img
            src={`${API_BASE}/v1/map-image?map=${encodeURIComponent(m.name)}`}
            alt=""
            className="h-9 w-12 flex-none rounded border border-border bg-bg-elevated object-cover"
            loading="lazy"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.visibility = "hidden";
            }}
          />
          <span className="truncate font-medium">{m.name}</span>
        </div>
      </td>
      <td className="px-3 py-1.5 text-right text-success tabular-nums">
        {m.wins}
      </td>
      <td className="px-3 py-1.5 text-right text-danger tabular-nums">
        {m.losses}
      </td>
      <td className="px-3 py-1.5 text-right tabular-nums">{m.total}</td>
      <td
        className="px-3 py-1.5 text-right tabular-nums"
        style={{ color: wrColor(m.winRate, m.total) }}
      >
        {pct1(m.winRate)}
      </td>
      <td className="px-3 py-1.5">
        <WrBar wins={m.wins} losses={m.losses} />
      </td>
      <td className="px-3 py-1.5 text-right text-xs text-text-dim">
        {fmtAgo(m.lastPlayed)}
      </td>
      <td className="px-3 py-1.5 text-right">
        {m.hasSpatial ? (
          <span className="rounded bg-accent/15 px-2 py-0.5 text-[11px] text-accent">
            ready
          </span>
        ) : (
          <span className="text-[11px] text-text-dim">—</span>
        )}
      </td>
    </tr>
  );
}
