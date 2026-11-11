"use client";

import { Button } from "@/components/ui/Button";
import { DEFAULT_REPORT_FILTERS, isFiltered, raceWord, type ReportFilters as Filters, type ReportMatchupFilter } from "@/lib/instant/reportFilters";

type Option<T> = readonly [T, string];

function FilterRow<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: readonly Option<T>[]; onChange: (value: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1.5">
      <span aria-hidden className="w-full text-caption font-semibold text-text-muted sm:w-20">{label}</span>
      {options.map(([key, text]) => <Button key={key} type="button" size="sm" variant={key === value ? "secondary" : "ghost"}
        className="min-h-11 px-3" aria-pressed={key === value} onClick={() => onChange(key)}>{text}</Button>)}
    </div>
  );
}

const RESULTS = [["all", "All results"], ["win", "Wins"], ["loss", "Losses"]] as const;
const RECENCY = [["all", "All dates"], ["10", "Last 10"], ["25", "Last 25"], ["90d", "Last 90 days"]] as const;

export function ReportFilters({ value, races, showing, total, onChange }: {
  value: Filters;
  races: readonly Exclude<ReportMatchupFilter, "all">[];
  showing: number;
  total: number;
  onChange: (value: Filters) => void;
}) {
  const matchups: Option<ReportMatchupFilter>[] = [["all", "All matchups"], ...races.map((race): Option<ReportMatchupFilter> => [race, "vs " + raceWord(race)])];
  return (
    <div className="space-y-2 rounded-xl border border-border bg-bg-surface p-3">
      <FilterRow label="Matchup" value={value.matchup} options={matchups} onChange={(matchup) => onChange({ ...value, matchup })} />
      <FilterRow label="Result" value={value.result} options={RESULTS} onChange={(result) => onChange({ ...value, result })} />
      <FilterRow label="Recency" value={value.recency} options={RECENCY} onChange={(recency) => onChange({ ...value, recency })} />
      <div className="flex flex-wrap items-center gap-x-2 text-caption text-text-muted">
        <p role="status">{showing ? "Showing " + showing + " of " + total + " games" : "No games match these filters"}</p>
        {isFiltered(value) ? <Button variant="ghost" size="sm" className="min-h-11"
          onClick={() => onChange({ ...DEFAULT_REPORT_FILTERS })}>Clear filters</Button> : null}
      </div>
    </div>
  );
}
