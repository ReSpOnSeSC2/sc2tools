import { BALANCE_RACES, type BalanceCohort, type MatchupBalance } from "@/lib/balance/bundle";

const PERCENT = new Intl.NumberFormat("en", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 2 });
const COUNT = new Intl.NumberFormat("en");

function MatchupCounts({ cohort, race, crossTier = false }: { cohort: BalanceCohort; race: string; crossTier?: boolean }) {
  if (cohort.winRate === null || !cohort.interval) {
    return <p className="text-body text-text-muted">No {crossTier ? "cross-tier" : "same-tier"} games in this snapshot.</p>;
  }
  return (
    <dl className="grid grid-cols-2 gap-x-2 gap-y-2 text-caption text-text-muted">
      <div>
        <dt>{race} win rate</dt>
        <dd className="text-h3 font-bold tabular-nums text-text">{PERCENT.format(cohort.winRate)}</dd>
      </div>
      <div>
        <dt>Games</dt>
        <dd className="text-h3 font-bold tabular-nums text-text">{COUNT.format(cohort.games)}</dd>
      </div>
      <div className="col-span-2 flex flex-wrap items-baseline gap-x-2">
        <dt>95% Wilson interval</dt>
        <dd className="font-semibold tabular-nums text-text">{PERCENT.format(cohort.interval.low)}–{PERCENT.format(cohort.interval.high)}</dd>
      </div>
    </dl>
  );
}

function MatchupBar({ fraction }: { fraction: number }) {
  return (
    <div className="relative h-2.5 overflow-hidden rounded-full bg-bg-elevated" aria-hidden="true">
      <div className="h-full bg-accent" style={{ width: `${fraction * 100}%` }} />
      <div className="absolute inset-y-0 left-1/2 w-px bg-text" />
    </div>
  );
}

export function BalanceMatchupCard({ matchup, sameTier, crossTier }: MatchupBalance) {
  const [firstRace, secondRace] = BALANCE_RACES[matchup];
  return (
    <article className="min-w-0 space-y-3 rounded-xl border border-line bg-bg-surface p-4">
      <h3 className="font-display text-h3 font-bold text-text">{firstRace} vs {secondRace}</h3>
      <MatchupCounts cohort={sameTier} race={firstRace} />
      {sameTier.winRate !== null && <MatchupBar fraction={sameTier.winRate} />}
      <details className="border-t border-line">
        <summary className="min-h-11 cursor-pointer rounded-sm py-3 text-caption font-semibold text-accent focus-visible:ring-2 focus-visible:ring-accent">Cross-tier games</summary>
        <MatchupCounts cohort={crossTier} race={firstRace} crossTier />
      </details>
    </article>
  );
}
