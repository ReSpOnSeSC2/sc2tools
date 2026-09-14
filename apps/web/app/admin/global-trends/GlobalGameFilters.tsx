"use client";

import { useEffect, useId, useState } from "react";
import { FilterBar } from "@/components/analyzer/FilterBar";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { useFilters } from "@/lib/filterContext";
import { ALL_GAME_FILTERS, RACES, mmrRangeError, type TrendFilterOptions } from "./globalTrendsState";

export const INPUT = "min-h-11 w-full rounded-lg border-2 border-line bg-bg-surface px-3 py-2 text-sm text-text placeholder:text-text-dim focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30";

export function GlobalGameFilters({ options }: { options: TrendFilterOptions }) {
  const { filters, setFilters } = useFilters();
  const [min, setMin] = useState("");
  const [max, setMax] = useState("");
  const [map, setMap] = useState("");
  const [build, setBuild] = useState("");
  const [strategy, setStrategy] = useState("");
  const id = useId();
  useEffect(() => {
    setMin(filters.mmr_min == null ? "" : String(filters.mmr_min));
    setMax(filters.mmr_max == null ? "" : String(filters.mmr_max));
    setMap(filters.map || "");
    setBuild(filters.build || "");
    setStrategy(filters.opp_strategy || "");
  }, [filters.mmr_min, filters.mmr_max, filters.map, filters.build, filters.opp_strategy]);
  const error = mmrRangeError(min, max);
  const changed = min !== (filters.mmr_min == null ? "" : String(filters.mmr_min))
    || max !== (filters.mmr_max == null ? "" : String(filters.mmr_max))
    || map !== (filters.map || "") || build !== (filters.build || "") || strategy !== (filters.opp_strategy || "");

  return (
    <section aria-label="Game filters" className="rounded-xl border-2 border-line bg-bg-surface p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">Game filters</h2>
          <p className="text-caption text-text-muted">These filters apply to every trend below.</p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => {
          setFilters({ ...ALL_GAME_FILTERS });
          setMin(""); setMax(""); setMap(""); setBuild(""); setStrategy("");
        }}>Reset game filters</Button>
      </div>
      <FilterBar />
      <form className="mt-4 border-t border-border pt-4" onSubmit={(e) => {
        e.preventDefault();
        if (error) return;
        setFilters({ ...filters, map: map || undefined, build: build || undefined,
          opp_strategy: strategy || undefined, mmr_min: min === "" ? undefined : Number(min),
          mmr_max: max === "" ? undefined : Number(max) });
      }}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <label className="space-y-1 text-caption text-text-muted">
            <span>Opponent race</span>
            <Select className="min-h-11" value={filters.opp_race || ""} onChange={(e) => setFilters({ ...filters, opp_race: e.target.value || undefined })}>
              <option value="">All opponent races</option>
              {RACES.filter((r) => r.value !== "U").map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </Select>
          </label>
          {([
            { label: "Map", value: map, set: setMap, values: options.maps, key: "map" },
            { label: "Player build", value: build, set: setBuild, values: options.builds, key: "build" },
            { label: "Opponent strategy", value: strategy, set: setStrategy, values: options.strategies, key: "strategy" },
          ]).map((field) => (
            <label key={field.key} className="space-y-1 text-caption text-text-muted">
              <span>{field.label}</span>
              <input className={INPUT} list={`${id}-${field.key}`} value={field.value} placeholder={`All ${field.key === "strategy" ? "strategies" : `${field.key}s`}`} onChange={(e) => field.set(e.target.value)} />
              <datalist id={`${id}-${field.key}`}>{field.values.map((v) => <option key={v} value={v} />)}</datalist>
            </label>
          ))}
          <label className="space-y-1 text-caption text-text-muted">
            <span>Opponent MMR · minimum</span>
            <input className={INPUT} type="number" min="0" max="10000" step="1" placeholder="No minimum" value={min} onChange={(e) => setMin(e.target.value)} aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined} />
          </label>
          <label className="space-y-1 text-caption text-text-muted">
            <span>Opponent MMR · maximum</span>
            <input className={INPUT} type="number" min="0" max="10000" step="1" placeholder="No maximum" value={max} onChange={(e) => setMax(e.target.value)} aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined} />
          </label>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-caption text-text-muted">Opponent MMR uses the rating recorded for the game. Player MMR is filtered above.</p>
          <Button type="submit" variant="secondary" size="sm" disabled={!!error || !changed}>Apply detailed filters</Button>
        </div>
        {error && <p id={`${id}-error`} role="alert" className="mt-2 text-sm text-danger">{error}</p>}
      </form>
    </section>
  );
}
