"use client";

import { useEffect } from "react";

// Toggle / picker that opts the cohort into per-map splitting. When
// turned on, the parent page passes the selected mapId to the
// cohort query; if that narrowing pushes the cohort below the
// k-anon floor the API falls back one tier (the picker shows a
// banner in that case).

export interface MapSplitToggleProps {
  enabled: boolean;
  mapId: string | undefined;
  availableMaps: string[];
  onChange: (next: { enabled: boolean; mapId: string | undefined }) => void;
}

export function MapSplitToggle({
  enabled,
  mapId,
  availableMaps,
  onChange,
}: MapSplitToggleProps) {
  useEffect(() => {
    if (enabled && !mapId && availableMaps.length > 0) {
      onChange({ enabled: true, mapId: availableMaps[0] });
    }
  }, [enabled, mapId, availableMaps, onChange]);

  return (
    <div className="rounded-lg border border-border bg-bg-elevated p-3">
      <label className="flex items-center gap-2 text-caption font-medium text-text">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onChange({ enabled: e.target.checked, mapId: e.target.checked ? mapId : undefined })}
          className="h-4 w-4 rounded border-border bg-bg-surface text-accent focus-visible:ring-2 focus-visible:ring-accent"
        />
        Split by map
      </label>
      {enabled ? (
        availableMaps.length === 0 ? (
          <p className="mt-2 text-[11px] text-text-dim">
            No map data on the current cohort.
          </p>
        ) : (
          <select
            className="input mt-2 text-caption"
            value={mapId || ""}
            onChange={(e) => onChange({ enabled: true, mapId: e.target.value })}
          >
            {availableMaps.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        )
      ) : null}
    </div>
  );
}
