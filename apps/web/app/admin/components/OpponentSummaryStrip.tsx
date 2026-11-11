import { Card } from "@/components/ui/Card";
import { fmtDuration } from "./AdminGameDetail";
import { ResultBadge } from "./ResultBadge";
import { decidedWinRate } from "./adminResult";
import type { OpponentGamesSummary } from "./adminTypes";

/** Fewer decided games than this shows the "Small sample" hint. */
export const SMALL_SAMPLE_DECIDED = 5;

/**
 * Head-to-head over every game against this opponent, whatever the list
 * filter: W–L–T, win rate over decided games only (ties and unrecorded
 * results never count), average length, top maps and the last 10 results.
 */
export function OpponentSummaryStrip({ summary }: { summary: OpponentGamesSummary }) {
  const decided = summary.wins + summary.losses;
  const rate = decidedWinRate(summary.wins, summary.losses);
  const total = decided + summary.ties + summary.unknown;
  return (
    <Card padded>
      <section aria-labelledby="opponent-summary-heading" className="space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="opponent-summary-heading" className="text-h3">Head-to-head</h2>
          <span className="text-caption text-text-muted">{total} {total === 1 ? "game" : "games"}{summary.unknown ? ` · ${summary.unknown} without a recorded result` : ""}</span>
        </div>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div><dt className="text-caption text-text-muted">W–L–T</dt><dd className="text-h3 tabular-nums">{summary.wins}–{summary.losses}–{summary.ties}</dd></div>
          <div><dt className="text-caption text-text-muted">Win rate</dt><dd className="text-h3 tabular-nums">{rate === null ? "—" : `${Math.round(rate * 100)}%`}</dd>
            <dd className="text-micro text-text-dim">{decided} decided {decided === 1 ? "game" : "games"}{decided < SMALL_SAMPLE_DECIDED ? " · Small sample" : ""}</dd></div>
          <div><dt className="text-caption text-text-muted">Average length</dt><dd className="text-h3 tabular-nums">{fmtDuration(summary.avgDurationSec)}</dd></div>
        </dl>
        {summary.maps.length ? (
          <div>
            <h3 className="text-caption font-semibold text-text">Top maps</h3>
            <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-caption text-text-muted">
              {summary.maps.map((row) => <li key={row.map}><span className="text-text">{row.map}</span> {row.wins}–{row.losses}{row.ties ? `–${row.ties}` : ""}</li>)}
            </ul>
          </div>
        ) : null}
        {summary.last10.length ? (
          <div>
            <h3 className="text-caption font-semibold text-text">Last {summary.last10.length}, newest first</h3>
            <ol className="mt-1 flex flex-wrap gap-1.5">{summary.last10.map((cls, at) => <li key={at}><ResultBadge cls={cls} size="sm" /></li>)}</ol>
          </div>
        ) : null}
      </section>
    </Card>
  );
}
