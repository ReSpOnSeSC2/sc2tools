"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { gameReplayHref } from "@/lib/replayLink";
import { compositionTime, unitLabel, type UnitComparison } from "./UnitCompositionTable";

const number = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 1 });

export function UnitGameComparison({ comparison, snapshot }: { comparison: UnitComparison; snapshot: boolean }) {
  const [showAll, setShowAll] = useState(false);
  const { status, baselineGames, units } = comparison;
  const rows = [...units].sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0) || b.count - a.count || a.token.localeCompare(b.token));
  const unavailable = status === "not_reached"
    ? "This game ended before this checkpoint or did not reach this phase."
    : status === "not_in_cohort"
      ? "This game is no longer in the current selection. Choose another game."
      : "This game has no usable unit samples for this view. A missing sample is not a zero army.";

  return <section aria-label="Selected game comparison" className="overflow-hidden rounded-lg border border-accent/30 bg-accent/5">
    <div className="space-y-1 p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-caption font-semibold text-text">Selected game vs. this build</h4>
        <Link href={gameReplayHref(comparison.gameId, snapshot ? comparison.sampleTimeSec : undefined)} className="inline-flex min-h-11 items-center gap-1 text-caption font-medium text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">{snapshot && comparison.sampleTimeSec != null ? `Open at ${compositionTime(comparison.sampleTimeSec)}` : "Open game"}<ArrowUpRight className="h-3.5 w-3.5" aria-hidden /></Link>
      </div>
      {status !== "observed" ? <p role="status" className="text-caption leading-relaxed text-text-muted">{unavailable}</p> : <>
        <p className="text-caption leading-relaxed text-text-muted">{baselineGames > 0 ? `Compared with ${baselineGames} other game${baselineGames === 1 ? "" : "s"} with data. The selected game is excluded from the baseline.` : "There are no other measured games in this selection. Counts are shown without a baseline."}</p>
        {baselineGames > 0 ? <p className="text-micro leading-relaxed text-text-muted">Typical range = middle 50% of other games, including zero counts. Differences describe army choices, not execution quality.{baselineGames < 5 ? " Small comparison sample." : ""}</p> : null}
      </>}
    </div>
    {status === "observed" ? <>
      {rows.length === 0 ? <p className="px-4 pb-4 text-caption text-text-muted">No eligible army or support units observed in this comparison.</p> : <ul className="divide-y divide-border border-t border-border">
        {(showAll ? rows : rows.slice(0, 6)).map((row) => {
          const relation = row.p25 == null || row.p75 == null ? null : row.count < row.p25 ? "Below range" : row.count > row.p75 ? "Above range" : "Within range";
          return <li key={row.token} className="grid gap-2 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] sm:items-center sm:px-4" data-testid="unit-comparison-row">
            <div className="min-w-0"><p className="break-words text-caption font-semibold text-text">{unitLabel(row.token)}</p>{relation ? <p className="text-micro text-text-muted">{relation}</p> : null}</div>
            <dl className="grid grid-cols-3 gap-2 text-caption tabular-nums">
              <div><dt className="text-micro text-text-muted">This game</dt><dd className="mt-1 font-semibold text-text">{number(row.count)}</dd></div>
              <div><dt className="text-micro text-text-muted">Typical range</dt><dd className="mt-1 text-text">{row.p25 == null || row.p75 == null ? "—" : `${number(row.p25)}–${number(row.p75)}`}{row.median != null ? <span className="mt-0.5 block text-micro text-text-muted">Median {number(row.median)}</span> : null}</dd></div>
              <div><dt className="text-micro text-text-muted">Vs. median</dt><dd className="mt-1 text-text">{row.delta == null ? "—" : `${row.delta > 0 ? "+" : ""}${number(row.delta)}`}</dd></div>
            </dl>
          </li>;
        })}
      </ul>}
      {rows.length > 6 ? <button type="button" onClick={() => setShowAll(!showAll)} className="min-h-11 w-full border-t border-border text-caption font-medium text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">{showAll ? "Show 6 largest differences" : `Compare all ${rows.length} unit types`}</button> : null}
    </> : null}
  </section>;
}
