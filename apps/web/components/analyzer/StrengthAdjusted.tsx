import Link from "next/link";
import type { SortState } from "@/components/ui/SortableTh";
import { signedWins, strengthDescription, type StrengthFields } from "@/lib/strengthAdjusted";

export function StrengthCell({ row }: { row: StrengthFields }) {
  const value = row.winsAboveExpected;
  const known = typeof value === "number" && Number.isFinite(value) && (row.ratedGames ?? 0) > 0;
  const description = strengthDescription(row);
  return <span role="img" className="inline-flex flex-wrap items-center gap-1.5 text-micro tabular-nums" title={description} aria-label={description}>
    <span data-strength-chip className={`whitespace-nowrap rounded-full border px-2 py-0.5 font-semibold ${!known || Math.abs(value!) < .05 ? "border-border text-text-muted" : value! > 0 ? "border-success/30 bg-success/10 text-text" : "border-danger/30 bg-danger/10 text-text"}`}>{known ? signedWins(value!) : "—"}</span>
    <span className="text-text-muted">{row.ratedGames == null ? "coverage unavailable" : `${row.ratedGames} rated`}</span>
  </span>;
}

export function WinRateRange({ row, total }: { row: StrengthFields; total: number }) {
  const range = row.winRateRange;
  const valid = range && Number.isFinite(range.low) && Number.isFinite(range.high) && range.low >= 0 && range.high <= 1 && range.low <= range.high;
  return <span className="mt-1 flex flex-wrap items-center justify-end gap-1">
    {valid && <span className="relative inline-block h-1 w-12 rounded-full bg-text/5" role="img" aria-label={`95% Wilson range ${(range.low * 100).toFixed(1)} to ${(range.high * 100).toFixed(1)} percent`} title="95% Wilson interval: uncertainty from the number of games, not opponent-strength adjustment.">
      <span className="absolute top-0 h-1 rounded-full bg-text/25" style={{ left: `${range.low * 100}%`, width: `${(range.high - range.low) * 100}%` }} />
    </span>}
    {total > 0 && total < 10 && <span className="whitespace-nowrap text-micro text-text-muted">thin sample</span>}
  </span>;
}

export function StrengthGuide() {
  return <p className="text-micro leading-relaxed text-text-muted">Vs expected shows rated wins minus expected wins, given who you played. Decided ranked 1v1 games need both replay-time ratings. Hover a chip for arithmetic and coverage. <Link href="/help/vs-expected" className="text-accent underline underline-offset-2">How it works</Link></p>;
}

export function StrengthHeader({ sort }: { sort: SortState }) {
  const active = sort.sortBy === "winsAboveExpected";
  return <th aria-sort={active ? sort.sortDir === "asc" ? "ascending" : "descending" : "none"} className="px-2 py-1 text-right">
    <span className="flex items-center justify-end gap-1">
      <button type="button" className={`min-h-11 text-micro uppercase tracking-wider focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${active ? "text-text" : "text-text-muted"}`} onClick={() => sort.setSort("winsAboveExpected")}>Vs expected{active && <span aria-hidden> {sort.sortDir === "asc" ? "↑" : "↓"}</span>}</button>
      <Link href="/help/vs-expected" aria-label="About vs expected" title="How strength-adjusted wins and performance ratings work" className="inline-flex min-h-11 min-w-11 items-center justify-center rounded text-caption text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">?</Link>
    </span>
  </th>;
}
