import { BALANCE_RACE_NAMES, SC2PULSE_URL, type BalanceEvidence, type BalanceRace } from "@/lib/balance/evidence";
import type { evaluatePermit } from "@/lib/balance/permit";
import { BalanceCardActions } from "./BalanceCardActions";

type Result = NonNullable<ReturnType<typeof evaluatePermit>>;
const PERCENT = new Intl.NumberFormat("en", { style: "percent", maximumFractionDigits: 2 });
const COUNT = new Intl.NumberFormat("en");
const GAP = new Intl.NumberFormat("en", { maximumFractionDigits: 2 });

function intervalText({ low, high }: { low: number; high: number }) {
  return `${PERCENT.format(low)}–${PERCENT.format(high)}`;
}

type Props = {
  evidence: BalanceEvidence;
  race: BalanceRace;
  opponent: BalanceRace;
  cohort: string;
  wins: number;
  losses: number;
  result: Result;
};

export function PermitCard({ evidence, race, opponent, cohort, wins, losses, result }: Props) {
  const matchup = `${BALANCE_RACE_NAMES[race]} vs ${BALANCE_RACE_NAMES[opponent]}`;
  const yourRecord = `${COUNT.format(wins)}W–${COUNT.format(losses)}L · ${PERCENT.format(result.personalRate)}`;
  const ladderRecord = `${PERCENT.format(result.ladder.winRate)} · ${COUNT.format(result.ladder.games)} games`;
  const ladderGap = `${GAP.format(result.ladderGap * 100)} percentage points`;
  const playerGap = `${GAP.format(result.playerGap * 100)} percentage points`;
  const snapshot = `Season ${evidence.season} · ${evidence.asOf} UTC`;
  const lines = [`${matchup} · ${cohort}`, `Your record: ${yourRecord}`, `Ladder: ${ladderRecord}`, `Ladder 95% interval: ${intervalText(result.ladder.interval)}`, `Gap below 50%: ${ladderGap} ladder · ${playerGap} remaining`, snapshot];

  return (
    <article className="space-y-3 rounded-xl border border-line bg-bg-surface p-4">
      <div>
        <h3 className="font-display text-h2 font-bold text-text">{result.status}</h3>
        <p className="text-body text-text-muted">{matchup} · {cohort}</p>
      </div>
      <dl className="grid gap-3 text-body sm:grid-cols-2">
        <div><dt className="text-caption text-text-muted">Your record</dt><dd className="font-semibold text-text">{yourRecord}</dd><dd className="text-caption text-text-muted">95% interval {intervalText(result.personalInterval)}</dd></div>
        <div><dt className="text-caption text-text-muted">Ladder record</dt><dd className="font-semibold text-text">{ladderRecord}</dd><dd className="text-caption text-text-muted">95% interval {intervalText(result.ladder.interval)}</dd></div>
        <div><dt className="text-caption text-text-muted">Ladder gap below 50%</dt><dd className="font-semibold text-text">{ladderGap}</dd></div>
        <div><dt className="text-caption text-text-muted">Remaining gap below 50%</dt><dd className="font-semibold text-text">{playerGap}</dd></div>
      </dl>
      <p className="text-caption text-text-muted">{snapshot} · <a href={SC2PULSE_URL} className="inline-flex min-h-11 items-center rounded-sm text-accent underline focus-visible:ring-2 focus-visible:ring-accent">Data from SC2Pulse</a></p>
      <BalanceCardActions kind="permit" title={result.status} lines={lines} />
    </article>
  );
}
