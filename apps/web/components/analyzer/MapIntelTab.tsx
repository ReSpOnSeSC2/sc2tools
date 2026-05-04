"use client";

import { useState } from "react";
import { useApi } from "@/lib/clientApi";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";
import { MapIntelViewer } from "./MapIntelViewer";

type MapEntry = {
  name: string;
  total: number;
};

type MapsResp = MapEntry[];

export function MapIntelTab() {
  const { filters, dbRev } = useFilters();
  const [selected, setSelected] = useState<string | null>(null);
  const { data, isLoading } = useApi<MapsResp>(
    `/v1/spatial/maps${filtersToQuery(filters)}#${dbRev}`,
  );

  if (isLoading) return <Skeleton rows={4} />;
  const maps = data || [];
  if (maps.length === 0) {
    return (
      <Card>
        <EmptyState
          title="No map data yet"
          sub="Need at least one analysed replay with parsed positions"
        />
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs uppercase tracking-wider text-text-dim">
          Map
        </span>
        {maps.map((m) => (
          <button
            key={m.name}
            type="button"
            onClick={() => setSelected(m.name)}
            className={`rounded px-2 py-1 text-xs ${
              selected === m.name
                ? "bg-accent/20 text-accent"
                : "bg-bg-elevated text-text-muted hover:text-text"
            }`}
          >
            {m.name}{" "}
            <span className="text-text-dim tabular-nums">({m.total})</span>
          </button>
        ))}
      </div>
      {selected ? (
        <MapIntelViewer mapName={selected} />
      ) : (
        <Card>
          <EmptyState title="Pick a map to see proxy / battle / death-zone heatmaps" />
        </Card>
      )}
    </div>
  );
}
