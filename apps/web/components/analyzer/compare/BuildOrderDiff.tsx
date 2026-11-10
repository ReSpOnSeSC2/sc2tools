"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card, Skeleton } from "@/components/ui/Card";
import { RequestError } from "@/components/ui/RequestError";
import { alignBuildOrders, deltaTone, formatDelta, type DeltaTone } from "@/lib/gameCompare";
import { formatClock } from "@/lib/replayHud";
import type { CompareSide } from "./useCompareSide";

/** Rows shown before "Show all". The opening is where builds diverge. */
const INITIAL_ROWS = 40;

const TONE_CLASS: Record<DeltaTone, string> = {
  even: "text-text-muted",
  later: "text-danger",
  earlier: "text-success",
  none: "text-text-dim",
};
const TONE_WORD: Record<DeltaTone, string> = { even: "about the same time", later: "later in game A", earlier: "earlier in game A", none: "" };

function columnNote(label: "A" | "B", side: CompareSide): string | null {
  if (side.buildState === "missing") return `Game ${label} has no build order, so its column is empty.`;
  return null;
}

/**
 * Both build orders aligned by step and occurrence — the 2nd Gateway
 * against the 2nd Gateway — with Δ = A − B coloured by meaning: red when
 * game A was later, green when earlier, muted within five seconds.
 * Steps one game never made show a dash on the other side.
 */
export function BuildOrderDiff({ a, b }: { a: CompareSide; b: CompareSide }) {
  const [all, setAll] = useState(false);
  const rows = useMemo(() => alignBuildOrders(a.steps, b.steps), [a.steps, b.steps]);
  const shown = all ? rows : rows.slice(0, INITIAL_ROWS);
  const loading = a.buildState === "loading" || b.buildState === "loading";
  const notes = [columnNote("A", a), columnNote("B", b)].filter(Boolean) as string[];
  return (
    <Card title="Build-order diff" data-testid="compare-build-diff">
      <div className="space-y-3">
        {([["A", a], ["B", b]] as const).map(([label, side]) => side.buildState === "error"
          ? <RequestError key={label} title={`Couldn't load game ${label}'s build order`} error={side.buildError} onRetry={side.retryBuild} />
          : null)}
        {notes.map((note) => <p key={note} className="text-caption text-text-muted">{note}</p>)}
        {loading && !rows.length ? <Skeleton rows={4} /> : null}
        {rows.length ? (
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- The named overflow region must accept keyboard scrolling.
          <div role="region" aria-label="Build-order diff table" tabIndex={0} className="max-w-full overflow-x-auto rounded-lg border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
            <table className="w-full min-w-[20rem] border-collapse text-caption">
              <caption className="sr-only">Build steps of game A and game B aligned by step and occurrence, with the time difference A minus B.</caption>
              <thead className="bg-bg-elevated">
                <tr>
                  <th scope="col" className="px-3 py-2 text-left font-semibold text-text">Step</th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold text-text">A</th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold text-text">B</th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold text-text">Δ A − B</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {shown.map((row) => {
                  const tone = deltaTone(row.delta);
                  return (
                    <tr key={row.id} data-testid="compare-build-row">
                      <th scope="row" className="max-w-[12rem] truncate px-3 py-1.5 text-left font-normal text-text">
                        {row.label}{row.occurrence > 1 ? <span className="text-text-dim"> #{row.occurrence}</span> : null}
                      </th>
                      <td className="px-3 py-1.5 text-right tabular-nums text-text-muted">{row.aTime === null ? "—" : formatClock(row.aTime)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-text-muted">{row.bTime === null ? "—" : formatClock(row.bTime)}</td>
                      <td className={`px-3 py-1.5 text-right font-semibold tabular-nums ${TONE_CLASS[tone]}`}>
                        {row.delta === null ? (row.aTime === null ? "B only" : "A only") : formatDelta(row.delta)}
                        {TONE_WORD[tone] ? <span className="sr-only">, {TONE_WORD[tone]}</span> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : !loading && !notes.length && a.buildState !== "error" && b.buildState !== "error" ? (
          <p className="text-caption text-text-muted">Neither build order has steps to compare.</p>
        ) : null}
        {rows.length > INITIAL_ROWS ? (
          <Button variant="ghost" size="sm" className="min-h-11" aria-expanded={all} onClick={() => setAll((value) => !value)}>
            {all ? `Show the first ${INITIAL_ROWS} steps` : `Show all ${rows.length} steps`}
          </Button>
        ) : null}
      </div>
    </Card>
  );
}
