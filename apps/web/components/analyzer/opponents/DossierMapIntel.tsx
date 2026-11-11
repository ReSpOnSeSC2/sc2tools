"use client";

import { useId, useState } from "react";
import dynamic from "next/dynamic";
import { ChevronDown, ChevronRight } from "lucide-react";

const MapIntelPanel = dynamic(() => import("@/components/maps/MapIntelPanel").then((mod) => mod.MapIntelPanel), {
  ssr: false,
  loading: () => <p role="status" className="text-caption text-text-muted">Loading map intel…</p>,
});

/**
 * "Where they proxy / fight on this map" — one opponent's map positions on a
 * dossier map row. The panel (and its request) loads only when expanded.
 */
export function DossierMapIntel({ map, pulseId, mergeLinked, filterQuery, dbRev }: {
  map: string;
  pulseId: string;
  mergeLinked: boolean;
  filterQuery: string;
  dbRev: number;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <div className="mt-1">
      <button type="button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((value) => !value)}
        className="inline-flex min-h-11 items-center gap-1 rounded px-2 text-caption font-medium text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
        {open ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
        Where they proxy / fight on this map
      </button>
      {open ? (
        <div id={panelId} className="mt-2 rounded-lg border border-border p-3">
          <MapIntelPanel map={map} filterQuery={filterQuery} dbRev={dbRev}
            opponent={{ pulseId, mergeLinked }} layers={["opp-proxies", "battle", "death-zone"]} />
        </div>
      ) : null}
    </div>
  );
}
