import { formatDate, formatNumber } from "@/lib/i18n/format";
import { formatUsd } from "@/lib/infrastructureCosts";
import type { Coverage } from "@/lib/donationCoverage";

/**
 * "$41 of $78 covered" for the newest month, as an accessible progress
 * bar. Static (no animation), and server-rendered: the figures come from
 * the owner's checked-in ledger, not a payment provider.
 *
 * Example:
 *   const coverage = getCoverage(summary.totalUsd);
 *   {coverage ? <CoverageMeter coverage={coverage} /> : null}
 */
export function CoverageMeter({ coverage, compact = false }: { coverage: Coverage; compact?: boolean }) {
  const received = formatUsd(coverage.receivedUsd);
  const goal = formatUsd(coverage.goalUsd);
  const summary = coverage.covered ? `${received} received, ${goal} covered` : `${received} of ${goal} covered`;
  const updated = formatDate(new Date(`${coverage.updatedAt}T00:00:00Z`), { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  const people = coverage.supporterCount === 1 ? "1 supporter" : `${formatNumber(coverage.supporterCount)} supporters`;
  return (
    <div className={`w-full ${compact ? "space-y-2" : "space-y-3"}`} data-testid="coverage-meter">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-body font-semibold text-text">
          {coverage.monthLabel}: <span className="tabular-nums">{summary}</span>
        </p>
        <p className="text-caption tabular-nums text-text-muted">{coverage.percent}%</p>
      </div>
      <div
        role="progressbar"
        aria-label={`${coverage.monthLabel} running costs covered by donations`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={coverage.percent}
        aria-valuetext={`${summary} (${coverage.percent}%)`}
        className="h-3 w-full overflow-hidden rounded-full border border-border bg-bg-elevated"
      >
        <div className="h-full rounded-full bg-accent-cyan" style={{ width: `${coverage.percent}%` }} />
      </div>
      <p className="text-caption text-text-muted">
        {people} this month. Last updated <time dateTime={coverage.updatedAt}>{updated}</time>
        {compact ? "." : ". Totals are entered by hand from donation receipts, so they can lag a few days behind."}
      </p>
    </div>
  );
}
