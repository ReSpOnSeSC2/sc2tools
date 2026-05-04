"use client";

import { useState } from "react";
import { useApi, API_BASE } from "@/lib/clientApi";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";

type Heatmap = {
  width: number;
  height: number;
  cells: { x: number; y: number; weight: number }[];
};

type ProxyResp = Heatmap;
type BattleResp = Heatmap;
type DeathResp = Heatmap;
type BuildingsResp = { items: { x: number; y: number; type: string }[] };

const LAYERS = ["proxy", "battle", "death-zone", "buildings"] as const;
type Layer = (typeof LAYERS)[number];

export function MapIntelViewer({ mapName }: { mapName: string }) {
  const { filters, dbRev } = useFilters();
  const [layer, setLayer] = useState<Layer>("proxy");
  const params = filtersToQuery({ ...filters, map: mapName });
  const cacheKey = `${dbRev}-${mapName}`;

  const proxy = useApi<ProxyResp>(
    layer === "proxy" ? `/v1/spatial/proxy${params}#${cacheKey}` : null,
  );
  const battle = useApi<BattleResp>(
    layer === "battle" ? `/v1/spatial/battle${params}#${cacheKey}` : null,
  );
  const death = useApi<DeathResp>(
    layer === "death-zone" ? `/v1/spatial/death-zone${params}#${cacheKey}` : null,
  );
  const buildings = useApi<BuildingsResp>(
    layer === "buildings" ? `/v1/spatial/buildings${params}#${cacheKey}` : null,
  );

  const heat: Heatmap | null =
    layer === "proxy"
      ? proxy.data || null
      : layer === "battle"
        ? battle.data || null
        : layer === "death-zone"
          ? death.data || null
          : null;

  const isLoading =
    proxy.isLoading || battle.isLoading || death.isLoading || buildings.isLoading;

  return (
    <Card title={`${mapName} · ${layer}`}>
      <div className="mb-3 inline-flex overflow-hidden rounded border border-border">
        {LAYERS.map((l) => (
          <button
            key={l}
            type="button"
            onClick={() => setLayer(l)}
            className={`px-2 py-1 text-xs ${
              layer === l
                ? "bg-accent/20 text-accent"
                : "text-text-muted hover:bg-bg-elevated"
            }`}
          >
            {l}
          </button>
        ))}
      </div>

      {isLoading ? (
        <Skeleton rows={3} />
      ) : (
        <div className="relative aspect-[4/3] w-full overflow-hidden rounded border border-border bg-bg-elevated">
          <img
            src={`${API_BASE}/v1/map-image?map=${encodeURIComponent(mapName)}`}
            alt={`${mapName} minimap`}
            className="absolute inset-0 h-full w-full object-cover opacity-60"
          />
          {heat && heat.cells.length > 0 && (
            <HeatmapOverlay heat={heat} />
          )}
          {layer === "buildings" &&
            buildings.data &&
            buildings.data.items.length > 0 && (
              <BuildingsOverlay items={buildings.data.items} />
            )}
          {((layer !== "buildings" && (!heat || heat.cells.length === 0)) ||
            (layer === "buildings" &&
              (!buildings.data || buildings.data.items.length === 0))) && (
            <div className="absolute inset-0 flex items-center justify-center">
              <EmptyState title="No samples for this layer" />
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function HeatmapOverlay({ heat }: { heat: Heatmap }) {
  const max = Math.max(...heat.cells.map((c) => c.weight), 1);
  return (
    <svg
      viewBox={`0 0 ${heat.width} ${heat.height}`}
      preserveAspectRatio="none"
      className="absolute inset-0 h-full w-full"
    >
      {heat.cells.map((c, i) => {
        const a = Math.min(1, c.weight / max);
        return (
          <circle
            key={i}
            cx={c.x}
            cy={c.y}
            r={Math.max(2, heat.width * 0.012)}
            fill="#ff6b6b"
            fillOpacity={a * 0.8}
          />
        );
      })}
    </svg>
  );
}

function BuildingsOverlay({
  items,
}: {
  items: { x: number; y: number; type: string }[];
}) {
  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      className="absolute inset-0 h-full w-full"
    >
      {items.map((b, i) => (
        <rect
          key={i}
          x={b.x - 0.6}
          y={b.y - 0.6}
          width={1.2}
          height={1.2}
          fill="#7c8cff"
          fillOpacity={0.7}
        >
          <title>{b.type}</title>
        </rect>
      ))}
    </svg>
  );
}
