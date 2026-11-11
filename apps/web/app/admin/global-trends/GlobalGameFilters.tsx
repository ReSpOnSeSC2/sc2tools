"use client";

import { useId } from "react";
import { FilterBar } from "@/components/analyzer/FilterBar";
import { Card } from "@/components/ui/Card";
import { Select } from "@/components/ui/Select";
import { applyFilterPatch, useFilters } from "@/lib/filterContext";
import { RACES, mmrRangeError, type TrendFilterOptions } from "./globalTrendsState";

export const INPUT = "min-h-11 w-full rounded-lg border-2 border-line bg-bg-surface px-3 text-sm text-text focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/40";

export function GlobalGameFilters({ options, min, max, onMin, onMax }: {
  options: TrendFilterOptions;
  min: string;
  max: string;
  onMin: (value: string) => void;
  onMax: (value: string) => void;
}) {
  const { filters, setFilters } = useFilters();
  const id = useId();
  const error = mmrRangeError(min, max);
  const fields = [
    { label: "Map", key: "map", values: options.maps },
    { label: "Player build", key: "build", values: options.builds },
    { label: "Opponent strategy", key: "opp_strategy", values: options.strategies },
  ] as const;

  return (
    <Card aria-label="Game filters" className="p-4 sm:p-5" padded={false}>
      <h2 className="mb-3 text-lg font-semibold">Game filters</h2>
      <FilterBar globalTrends />
      <div className="mt-4 grid grid-cols-1 gap-3 border-t border-border pt-4 sm:grid-cols-2 xl:grid-cols-3">
        <label className="space-y-1 text-caption text-text-muted">
          <span>Opponent race</span>
          <Select className="min-h-11" value={filters.opp_race || ""} onChange={(e) => setFilters({ ...filters, opp_race: e.target.value || undefined })}>
            <option value="">All opponent races</option>
            {RACES.filter((race) => race.value !== "U").map((race) => <option key={race.value} value={race.value}>{race.label}</option>)}
          </Select>
        </label>
        {fields.map((field) => (
          <label key={field.key} className="space-y-1 text-caption text-text-muted">
            <span>{field.label}</span>
            <input className={INPUT} list={`${id}-${field.key}`} value={filters[field.key] || ""} onChange={(e) => {
              const value = e.target.value || undefined;
              setFilters(applyFilterPatch(filters, field.key === "map" ? { map: value, map_exact: undefined, map_exact_label: undefined } : { [field.key]: value }));
            }} />
            <datalist id={`${id}-${field.key}`}>{field.values.map((value) => <option key={value} value={value} />)}</datalist>
          </label>
        ))}
        <label className="space-y-1 text-caption text-text-muted">
          <span>Opponent MMR · minimum</span>
          <input className={INPUT} type="number" min="0" max="10000" step="1" value={min} onChange={(e) => onMin(e.target.value)} aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined} />
        </label>
        <label className="space-y-1 text-caption text-text-muted">
          <span>Opponent MMR · maximum</span>
          <input className={INPUT} type="number" min="0" max="10000" step="1" value={max} onChange={(e) => onMax(e.target.value)} aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined} />
        </label>
      </div>
      {error ? <p id={`${id}-error`} role="alert" className="mt-2 text-sm text-danger">{error}</p> : null}
    </Card>
  );
}
