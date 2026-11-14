"use client";

import Link from "next/link";
import { BALANCE_MATCHUPS, type BalanceMatchup } from "@/lib/balance/bundle";
import { BALANCE_RACE_NAMES, cohortOptions, getBalanceCohort, type BalanceEvidence } from "@/lib/balance/evidence";
import { EvidenceLoading, EvidenceNotice } from "./EvidenceState";
import { claimPath, MATCHUP_SIDES, matchupTitle } from "./selection";
import { useEvidence } from "./useEvidence";

const PERCENT = new Intl.NumberFormat("en", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 2 });
const COUNT = new Intl.NumberFormat("en");

type Scope = { matchup: BalanceMatchup; cohort?: never } | { cohort: string; matchup?: never };

function EvidenceRows({ bundle, scope }: { bundle: BalanceEvidence; scope: Scope }) {
  const cohorts = cohortOptions(bundle).filter(cohort => !scope.cohort || scope.cohort === cohort.value);
  return (scope.matchup ? [scope.matchup] : BALANCE_MATCHUPS).flatMap(matchup => cohorts.map(({ value, label }) => {
    const [race, opponent] = MATCHUP_SIDES[matchup];
    const stats = getBalanceCohort(bundle, value, race, opponent);
    const title = scope.matchup ? label : matchupTitle(matchup);
    const href = scope.matchup ? `/balance/league/${value}` : `/balance/${matchup.toLowerCase()}`;
    return (
      <article key={`${value}-${matchup}`} className="space-y-3 rounded-xl border border-line bg-bg-surface p-4">
        <h3 className="font-display text-h3 font-bold text-text"><Link className="inline-flex min-h-11 items-center rounded-sm underline focus-visible:ring-2 focus-visible:ring-accent" href={href} prefetch={false}>{title}</Link></h3>
        {stats?.winRate != null && stats.interval ? (
          <>
            <dl className="grid grid-cols-2 gap-2 text-caption text-text-muted">
              <div><dt>{BALANCE_RACE_NAMES[race]} win rate</dt><dd className="text-h3 font-bold tabular-nums text-text">{PERCENT.format(stats.winRate)}</dd></div>
              <div><dt>Same-tier games</dt><dd className="text-h3 font-bold tabular-nums text-text">{COUNT.format(stats.games)}</dd></div>
              <div className="col-span-2"><dt>{stats.confidence}% Wilson interval</dt><dd className="font-semibold tabular-nums text-text">{PERCENT.format(stats.interval.low)}–{PERCENT.format(stats.interval.high)}</dd></div>
            </dl>
            <Link
              href={claimPath(bundle, { matchup, race, cohort: value })}
              prefetch={false}
              aria-label={`View ${matchupTitle(matchup)} receipt for ${label}`}
              className="inline-flex min-h-11 items-center rounded-sm text-caption font-semibold text-accent underline focus-visible:ring-2 focus-visible:ring-accent"
            >
              View receipt
            </Link>
          </>
        ) : <p className="text-caption text-text-muted">No same-tier games in this snapshot.</p>}
      </article>
    );
  }));
}

export function EvidenceBreakdown({ scope }: { scope: Scope }) {
  const { value, retry } = useEvidence(undefined);
  if (value.kind === "loading") return <EvidenceLoading />;
  if (value.kind === "unavailable") return <EvidenceNotice retry={retry}>The latest ladder evidence is unavailable.</EvidenceNotice>;
  const { bundle } = value;
  return (
    <section className="space-y-4" aria-labelledby="breakdown-heading">
      <div className="space-y-1">
        <h2 id="breakdown-heading" className="font-display text-h2 font-bold text-text">{scope.matchup ? "By league and tier" : "Same-tier matchups"}</h2>
        <p className="text-body text-text-muted">Season {bundle.season} · <time dateTime={bundle.asOf}>{bundle.asOf}</time> UTC</p>
        <p className="max-w-prose text-caption text-text-muted">Same-tier games tracked by SC2Pulse in the Americas, Europe, and Korea across all maps and game lengths. Whole-league results pool the games from each division.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"><EvidenceRows bundle={bundle} scope={scope} /></div>
    </section>
  );
}
