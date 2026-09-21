"use client";

import { useId, useMemo, useState } from "react";
import { ArrowUpRight, ChevronDown, Info } from "lucide-react";
import { Icon } from "@/components/ui/Icon";
import Link from "next/link";
import { gameReplayHref } from "@/lib/replayLink";
import { UnitGameComparison } from "./UnitGameComparison";

export type UnitExample = { gameId: string; count: number; timeSec: number };
export type UnitComparison = {
  gameId: string;
  status: "observed" | "missing" | "not_reached" | "not_in_cohort";
  baselineGames: number;
  sampleTimeSec?: number;
  units: Array<{ token: string; count: number; median: number | null; p25: number | null; p75: number | null; delta: number | null }>;
};

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
  whenPresent?: { median: number; p25: number; p75: number };
  examples?: { typical?: UnitExample; high?: UnitExample; absent?: UnitExample };
};

export type UnitSummary = {
  metric: "peak_alive" | "snapshot_alive";
  source: "unit_timeline";
  observedGames: number;
  missingGames: number;
  emptyArmyGames: number;
  units: UnitSummaryRow[];
  comparison?: UnitComparison;
};

export function compositionTime(seconds: number) {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

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
  const [sort, setSort] = useState("frequency");
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
  const snapshot = summary.metric === "snapshot_alive";
  const period = snapshot ? "at this checkpoint" : "in this phase";
  const common = [...summary.units].sort((a, b) => b.gamesPresent - a.gamesPresent || a.token.localeCompare(b.token)).slice(0, 3);

  return (
    <section aria-labelledby={`${id}-title`} className="min-w-0 space-y-4" data-testid="unit-composition-summary">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-xl space-y-1">
          <h3 id={`${id}-title`} className="text-base font-semibold tracking-tight text-text">Units fielded</h3>
          <p className="text-caption leading-relaxed text-text-muted">{snapshot ? "Units alive near the same game time, averaged across games with a recent sample." : "Each unit’s highest observed count per game, averaged across this phase."}</p>
          {!snapshot ? <p className="text-micro leading-relaxed text-text-muted">Unit peaks can occur at different moments. These counts do not form one simultaneous army.</p> : null}
        </div>
        <span className="inline-flex items-center gap-2 rounded-full border border-border bg-bg-elevated px-3 py-1.5 text-micro font-medium text-text-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
          Sampled alive counts
        </span>
      </div>

      {summary.comparison ? <UnitGameComparison comparison={summary.comparison} snapshot={snapshot} /> : null}

      {common.length && summary.observedGames > 0 ? <p className="rounded-lg border border-border bg-bg-elevated/60 px-3 py-3 text-caption leading-relaxed text-text-muted"><span className="font-medium text-text">Most common: </span>{common.map((row) => `${unitLabel(row.token)} (${number(row.gamesPresent / summary.observedGames * 100)}%)`).join(" · ")}<span className="block mt-1 text-micro">Share of games with data where each unit was present.</span></p> : null}

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

      {summary.missingGames > 0 ? <p className="text-caption text-text-muted">{summary.missingGames} game{summary.missingGames === 1 ? " has" : "s have"} no usable samples {period} and {summary.missingGames === 1 ? "is" : "are"} excluded from the averages.</p> : null}

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-7 text-center">
          <p className="text-body font-medium text-text">{summary.observedGames > 0 ? "No army units observed" : `No unit samples ${period}`}</p>
          <p className="mt-1 text-caption text-text-muted">{summary.observedGames > 0 ? "The recorded samples contain no eligible army or support units." : `Averages will appear when replays contain usable unit samples ${period}.`}</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <div aria-hidden="true" className="grid grid-cols-[minmax(0,1fr)_4rem_3.5rem] gap-3 border-b border-border bg-bg-elevated px-3 py-2 text-micro font-medium text-text-muted sm:grid-cols-[minmax(0,1.5fr)_minmax(5rem,1fr)_5.5rem_5rem] sm:px-4">
            <span>Unit</span><span className="text-right">{snapshot ? "Avg. alive" : "Avg. peak alive"}</span><span className="hidden text-right sm:block">Middle 50%</span><span className="text-right">Seen in</span>
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
                    <span className="min-w-0 text-right"><span className="sr-only">{snapshot ? "Average alive: " : "Average peak alive: "}</span><span className="text-base font-semibold tabular-nums text-text">{average(row.mean)}</span><span className="mt-1.5 block h-1 w-full overflow-hidden rounded-full bg-bg-elevated" aria-hidden><span className="block h-full rounded-full bg-accent/70" style={{ width: `${Math.max(0, Math.min(100, row.mean / maxMean * 100))}%` }} /></span></span>
                    <span className="hidden text-right text-caption tabular-nums text-text-muted sm:block"><span className="sr-only">Middle 50%: </span>{number(row.p25)}–{number(row.p75)}</span>
                    <span className="text-right"><span className="sr-only">Seen in </span><span className="block text-caption font-medium tabular-nums text-text">{number(frequency)}%</span><span className="block text-micro tabular-nums text-text-dim">{row.gamesPresent}/{summary.observedGames}<span className="sr-only"> games</span></span></span>
                  </button>
                  {open ? (
                    <div id={`${id}-${row.token}`} className="space-y-3 border-t border-border bg-bg-elevated/60 px-4 py-4">
                      <dl className="grid grid-cols-3 gap-3 text-caption">
                        <div><dt className="text-micro text-text-muted">{snapshot ? "Median alive" : "Median peak"}</dt><dd className="mt-1 font-semibold tabular-nums text-text">{number(row.median)}</dd></div>
                        <div><dt className="text-micro text-text-muted">Middle 50%</dt><dd className="mt-1 font-semibold tabular-nums text-text">{number(row.p25)}–{number(row.p75)}</dd></div>
                        <div><dt className="text-micro text-text-muted">Full range</dt><dd className="mt-1 font-semibold tabular-nums text-text">{number(row.min)}–{number(row.max)}</dd></div>
                      </dl>
                      <p className="text-micro leading-relaxed text-text-muted">All {summary.observedGames} observed games contribute to these counts, including {summary.observedGames - row.gamesPresent} where this unit was absent.</p>
                      {row.whenPresent ? <p className="rounded-md border border-border bg-bg-surface p-3 text-caption leading-relaxed text-text-muted"><strong className="font-medium text-text">When present:</strong> median {number(row.whenPresent.median)}, middle 50% {number(row.whenPresent.p25)}–{number(row.whenPresent.p75)} across {row.gamesPresent} game{row.gamesPresent === 1 ? "" : "s"}. This excludes games without {unitLabel(row.token)}.</p> : null}
                      {row.examples ? <div className="space-y-2"><p className="text-micro font-medium text-text-muted">Replay examples · measured for this unit</p><div className="grid gap-2 sm:grid-cols-3">{(["typical", "high", "absent"] as const).map((kind) => {
                        const example = row.examples?.[kind];
                        if (!example) return null;
                        return <Link key={kind} href={gameReplayHref(example.gameId, example.timeSec)} className={`flex min-h-14 items-center justify-between gap-2 rounded-md border border-border bg-bg-surface px-3 py-2 text-caption text-text hover:border-accent ${focus}`} aria-label={`Open ${kind} ${unitLabel(row.token)} example: ${example.count} at ${compositionTime(example.timeSec)}`}><span><span className="block font-medium">{kind === "typical" ? "Typical when present" : kind === "high" ? "Highest count" : "Absent"}</span><span className="text-micro text-text-muted">{number(example.count)} · {compositionTime(example.timeSec)}</span></span><ArrowUpRight className="h-3.5 w-3.5 shrink-0" aria-hidden /></Link>;
                      })}</div></div> : null}
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
          <p><strong className="font-medium text-text">{snapshot ? "Average alive:" : "Average peak alive:"}</strong> {snapshot ? "Use each game’s latest sample at or before the checkpoint, no more than 30 seconds earlier, then average those alive counts. Games ending before the checkpoint are excluded." : "Take each unit’s highest recorded alive count within each game’s phase, then average those counts."} Observed games without that unit count as zero. Missing data does not.</p>
          <p><strong className="font-medium text-text">Variation:</strong> the median is the middle count after sorting, averaging the two middle counts for an even number of games. The middle 50% spans the 25th–75th percentiles; it describes variation between games, not confidence in an estimate. Values are displayed to one decimal place where needed.</p>
          <p><strong className="font-medium text-text">Scope:</strong> army and support units only. Workers, supply units, structures, and temporary summons are excluded. {summary.emptyArmyGames} observed game{summary.emptyArmyGames === 1 ? " had" : "s had"} no eligible units {period}.</p>
          <p><strong className="font-medium text-text">Alive versus produced:</strong> replacements and losses make lifetime production different. Production totals are unavailable from this data.{!snapshot ? " Peaks for different units can occur at different times, so these rows are not one simultaneous army and must not be added into an army total." : " These averages describe multiple games, not an exact army from any one replay."}</p>
          <p><strong className="font-medium text-text">Examples:</strong> typical is closest to the median among games with the unit; highest count is the largest observed count; absent is a measured zero. Each link opens that game at its actual sample time. A typical unit example need not have a typical overall army.</p>
          <p>Samples can miss short-lived units between recorded moments. Older replays may need reprocessing to correct unit forms around morphs.</p>
        </div>
      </details>
    </section>
  );
}
