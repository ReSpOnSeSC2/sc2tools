"use client";

import { X } from "lucide-react";
import { RACES, selectionLabel, type Population } from "./globalTrendsState";
import { formatNumber } from "@/lib/i18n/format";

export function PopulationChips({ population, onRemove }: {
  population: Population;
  onRemove: (patch: Partial<Population>) => void;
}) {
  const items: { label: string; patch: Partial<Population> }[] = [];
  for (const race of RACES) {
    if (population.excludedRaces.includes(race.value)) items.push({ label: `Excluding ${race.label}`,
      patch: { excludedRaces: population.excludedRaces.filter(value => value !== race.value) } });
  }
  if (population.mmrMin || population.mmrMax) {
    const min = population.mmrMin ? formatNumber(Number(population.mmrMin)) : "";
    const max = population.mmrMax ? formatNumber(Number(population.mmrMax)) : "";
    const range = min && max ? `${min}–${max}` : min ? `${min}+` : `≤${max}`;
    items.push({ label: `Player MMR ${range}`, patch: { mmrMin: "", mmrMax: "" } });
  }
  if (!population.includeUnrated) items.push({ label: "Rated players only", patch: { includeUnrated: true } });
  if (population.selection === "include" || population.playerIds.length) {
    items.push({ label: selectionLabel(population), patch: { selection: "all", playerIds: [] } });
  }
  if (!items.length) return null;
  return <ul aria-label="Active player filters" className="flex flex-wrap items-center gap-2">
    {items.map(item => <li key={item.label}><button type="button" aria-label={`Remove filter ${item.label}`}
      className="inline-flex min-h-11 items-center gap-2 rounded-full border border-accent/40 bg-accent/10 px-3 text-caption text-text hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:min-h-8"
      onClick={() => onRemove(item.patch)}>{item.label}<X className="h-3.5 w-3.5" aria-hidden /></button></li>)}
  </ul>;
}
