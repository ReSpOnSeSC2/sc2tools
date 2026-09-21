"use client";

import { useId, useMemo, useState } from "react";
import { ArrowUpRight, ChevronDown, Info } from "lucide-react";
import { Icon } from "@/components/ui/Icon";

export type UnitSummaryRow = {
  token: string;
  mean: number;
  median: number;
  p25: number;
  p75: number;
  min: number;
  max: number;
  gamesPresent: number;
  sampleGameIds: string[];
};

export type UnitSummary = {
  metric: "peak_alive";
  source: "unit_timeline";
  observedGames: number;
  missingGames: number;
  emptyArmyGames: number;
  units: UnitSummaryRow[];
};

export function unitLabel(token: string) {
  return token.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z])([A-Z][a-z])/g, "$1 $2");
}

const number = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 1 });
const average = (value: number) => value.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const focus = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg";

/** Every statistic is supplied by the server over the same observed-game cohort.
 * Do not reconstruct averages from the legacy, conditional signature medians. */
export function UnitCompositionTable({ summary, onOpenGames }: {
  summary: UnitSummary;
  onOpenGames?: (gameIds: string[], token: string) => void;
}) {
  const id = useId();
  const [sort, setSort] = useState("count");
  const [showAll, setShowAll] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const rows = useMemo(() => [...summary.units].sort((a, b) => {
    if (sort === "name") return a.token.localeCompare(b.token);
    const diff = sort === "frequency" ? b.gamesPresent - a.gamesPresent : b.mean - a.mean;
    return diff || a.token.localeCompare(b.token);
  }), [summary.units, sort]);
  const shown = showAll ? rows : rows.slice(0, 8);
  const maxMean = Math.max(1, ...rows.map((row) => row.mean));
  const reached = summary.observedGames + summary.missingGames;

  return (
    <section aria-labelledby={`${id}-title`} className="min-w-0 space-y-4" data-testid="unit-composition-summary">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-xl space-y-1">
          <h3 id={`${id}-title`} className="text-base font-semibold tracking-tight text-text">Units fielded</h3>
          <p className="text-caption leading-relaxed text-text-muted">Each unit’s highest observed count per game, averaged across this phase.</p>
        </div>
        <span className="inline-flex items-center gap-2 rounded-full border border-border bg-bg-elevated px-3 py-1.5 text-micro font-medium text-text-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
          Sampled alive counts
        </span>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-y border-border py-3">
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-caption text-text-muted">
          <span><strong className="font-semibold tabular-nums text-text">{summary.observedGames}</strong> of {reached} games with data</span>
          <span><strong className="font-semibold tabular-nums text-text">{rows.length}</strong> unit types</span>
          {summary.observedGames > 0 && summary.observedGames < 5 ? <span className="text-warning">Small sample</span> : null}
        </div>
        {rows.length > 1 ? (
          <label className="flex items-center gap-2 text-micro text-text-muted">
            Sort by
            <select value={sort} onChange={(event) => setSort(event.target.value)} className={`min-h-11 rounded-md border border-border bg-bg-surface px-2 text-caption text-text ${focus}`}>
              <option value="count">Average count</option>
              <option value="frequency">Frequency</option>
              <option value="name">Unit name</option>
            </select>
          </label>
        ) : null}
      </div>

      {summary.missingGames > 0 ? <p className="text-caption text-text-muted">{summary.missingGames} game{summary.missingGames === 1 ? " has" : "s have"} no usable samples in this phase and {summary.missingGames === 1 ? "is" : "are"} excluded from the averages.</p> : null}

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-7 text-center">
          <p className="text-body font-medium text-text">{summary.observedGames > 0 ? "No army units observed" : "No unit samples in this phase"}</p>
          <p className="mt-1 text-caption text-text-muted">{summary.observedGames > 0 ? "The recorded samples contain no eligible army or support units." : "Averages will appear when replays contain unit samples for this phase."}</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <div aria-hidden="true" className="grid grid-cols-[minmax(0,1fr)_4rem_3.5rem] gap-3 border-b border-border bg-bg-elevated px-3 py-2 text-micro font-medium text-text-muted sm:grid-cols-[minmax(0,1.5fr)_minmax(5rem,1fr)_5.5rem_5rem] sm:px-4">
            <span>Unit</span><span className="text-right">Avg. peak alive</span><span className="hidden text-right sm:block">Middle 50%</span><span className="text-right">Seen in</span>
          </div>
          <ul className="divide-y divide-border">
            {shown.map((row) => {
              const open = expanded === row.token;
              const frequency = summary.observedGames > 0 ? 100 * row.gamesPresent / summary.observedGames : 0;
              return (
                <li key={row.token} data-testid="unit-summary-row" data-token={row.token}>
                  <button type="button" aria-expanded={open} aria-controls={`${id}-${row.token}`} onClick={() => setExpanded(open ? null : row.token)} className={`grid min-h-16 w-full grid-cols-[minmax(0,1fr)_4rem_3.5rem] items-center gap-3 bg-bg-surface px-3 py-3 text-left transition-colors hover:bg-bg-elevated sm:grid-cols-[minmax(0,1.5fr)_minmax(5rem,1fr)_5.5rem_5rem] sm:px-4 ${focus}`}>
                    <span className="flex min-w-0 items-center gap-2.5">
                      <span className="hidden shrink-0 rounded-md border border-border bg-bg p-1 min-[360px]:inline-flex"><Icon name={row.token} kind="unit" size={28} decorative /></span>
                      <span className="min-w-0"><span className="block break-words text-caption font-semibold text-text">{unitLabel(row.token)}</span><span className="mt-0.5 flex items-center gap-1 text-micro text-text-dim">Details <ChevronDown aria-hidden className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} /></span></span>
                    </span>
                    <span className="min-w-0 text-right"><span className="sr-only">Average peak alive: </span><span className="text-base font-semibold tabular-nums text-text">{average(row.mean)}</span><span className="mt-1.5 block h-1 w-full overflow-hidden rounded-full bg-bg-elevated" aria-hidden><span className="block h-full rounded-full bg-accent/70" style={{ width: `${Math.max(0, Math.min(100, row.mean / maxMean * 100))}%` }} /></span></span>
                    <span className="hidden text-right text-caption tabular-nums text-text-muted sm:block"><span className="sr-only">Middle 50%: </span>{number(row.p25)}–{number(row.p75)}</span>
                    <span className="text-right"><span className="sr-only">Seen in </span><span className="block text-caption font-medium tabular-nums text-text">{number(frequency)}%</span><span className="block text-micro tabular-nums text-text-dim">{row.gamesPresent}/{summary.observedGames}<span className="sr-only"> games</span></span></span>
                  </button>
                  {open ? (
                    <div id={`${id}-${row.token}`} className="space-y-3 border-t border-border bg-bg-elevated/60 px-4 py-4">
                      <dl className="grid grid-cols-3 gap-3 text-caption">
                        <div><dt className="text-micro text-text-muted">Median peak</dt><dd className="mt-1 font-semibold tabular-nums text-text">{number(row.median)}</dd></div>
                        <div><dt className="text-micro text-text-muted">Middle 50%</dt><dd className="mt-1 font-semibold tabular-nums text-text">{number(row.p25)}–{number(row.p75)}</dd></div>
                        <div><dt className="text-micro text-text-muted">Full range</dt><dd className="mt-1 font-semibold tabular-nums text-text">{number(row.min)}–{number(row.max)}</dd></div>
                      </dl>
                      <p className="text-micro leading-relaxed text-text-muted">All {summary.observedGames} observed games contribute to these counts, including {summary.observedGames - row.gamesPresent} where this unit was absent.</p>
                      {onOpenGames && row.sampleGameIds.length > 0 ? <button type="button" onClick={() => onOpenGames(row.sampleGameIds, row.token)} className={`inline-flex min-h-11 items-center gap-1 text-caption font-medium text-accent hover:underline ${focus}`}>View {row.sampleGameIds.length < row.gamesPresent ? `${row.sampleGameIds.length} sample game${row.sampleGameIds.length === 1 ? "" : "s"}` : `${row.sampleGameIds.length} game${row.sampleGameIds.length === 1 ? "" : "s"}`} with {unitLabel(row.token)}<ArrowUpRight className="h-3.5 w-3.5" aria-hidden /></button> : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {rows.length > 8 ? <button type="button" onClick={() => setShowAll(!showAll)} className={`min-h-11 w-full border-t border-border bg-bg-elevated text-caption font-medium text-text-muted hover:text-text ${focus}`}>{showAll ? "Show top 8 units" : `Show all ${rows.length} unit types`}</button> : null}
        </div>
      )}

      <details className="group rounded-lg border border-border bg-bg-surface px-3 py-1 text-caption text-text-muted">
        <summary className={`flex min-h-11 cursor-pointer list-none items-center gap-2 rounded ${focus}`}><Info className="h-3.5 w-3.5 shrink-0" aria-hidden /><span>How to read these numbers</span><ChevronDown className="ml-auto h-3.5 w-3.5 group-open:rotate-180" aria-hidden /></summary>
        <div className="space-y-2 pb-3 pl-5 text-caption leading-relaxed">
          <p><strong className="font-medium text-text">Average peak alive:</strong> take each unit’s highest recorded alive count within each game’s phase, then average those counts. Observed games without that unit count as zero. Missing data does not.</p>
          <p><strong className="font-medium text-text">Variation:</strong> the median is the middle count after sorting, averaging the two middle counts for an even number of games. The middle 50% spans the 25th–75th percentiles; it describes variation between games, not confidence in an estimate. Values are displayed to one decimal place where needed.</p>
          <p><strong className="font-medium text-text">Scope:</strong> army and support units only. Workers, supply units, structures, and temporary summons are excluded. {summary.emptyArmyGames} observed game{summary.emptyArmyGames === 1 ? " had" : "s had"} no eligible units in this phase.</p>
          <p><strong className="font-medium text-text">Alive versus produced:</strong> replacements and losses make lifetime production different. Production totals are unavailable from this data. Peaks for different units can occur at different times, so these rows are not one simultaneous army and must not be added into an army total.</p>
          <p>Samples can miss short-lived units between recorded moments. Older replays may need reprocessing to correct unit forms around morphs.</p>
        </div>
      </details>
    </section>
  );
}
