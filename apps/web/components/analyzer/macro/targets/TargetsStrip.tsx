"use client";

import Link from "next/link";
import { useFilters } from "@/lib/filterContext";
import { LEAGUES, TARGET_METRICS, matchupFromFilters, percentileText, targetRow } from "@/lib/leagueTargets";
import { useTargetsData } from "./useTargetsData";

const LINK_CLASS = "rounded-sm text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

/**
 * Today's compact Targets strip: your league and matchup, then each
 * directional metric's percentile and the step to the next league's median,
 * linking to the full card on the Macro tab. Renders nothing until there is
 * something to say.
 */
export function TargetsStrip() {
  const { filters } = useFilters();
  const data = useTargetsData(matchupFromFilters(filters), false);
  const t = data.targets.data;
  if (!t || !data.matchup || t.sample.n === 0) return null;
  if (!data.bands) {
    return (
      <p className="rounded-xl border border-border bg-bg-surface px-3 py-2 text-caption text-text-muted" data-testid="today-targets">
        Targets: no MMR yet to place you in a league. <Link href="/app/macro#targets" className={LINK_CLASS}>Choose your league</Link>
      </p>
    );
  }
  const league = LEAGUES[data.bands.current];
  const nextLeague = data.bands.next !== null ? LEAGUES[data.bands.next] : null;
  const parts = TARGET_METRICS.filter((spec) => spec.direction === "higher").map((spec) => {
    const row = targetRow(spec, t.medians[spec.key], data.currentTable, data.nextTable);
    if (!row.percentile) return null;
    const step = row.gap !== null && row.gap > 0 && nextLeague ? ` → ${nextLeague} +${spec.key === "spq" ? row.gap.toFixed(1).replace(/\.0$/, "") : Math.ceil(row.gap)}` : "";
    return `${spec.unit} ${percentileText(row.percentile)}${step}`;
  }).filter(Boolean);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-border bg-bg-surface px-3 py-2 text-caption" data-testid="today-targets">
      <span className="font-medium text-text">Targets · {league} {data.matchup}</span>
      {parts.length > 0
        ? parts.map((part) => <span key={part} className="tabular-nums text-text-muted">{part}</span>)
        : <span className="text-text-muted">{data.tablesLoading ? "Loading league tables…" : `Not enough ${league} ${data.matchup} games yet`}</span>}
      <Link href="/app/macro#targets" className={`ml-auto ${LINK_CLASS}`}>Open targets</Link>
    </div>
  );
}
