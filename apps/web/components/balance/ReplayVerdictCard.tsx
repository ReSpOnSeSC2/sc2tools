import Link from "next/link";
import { Scale } from "lucide-react";
import { getBalanceCohort, cohortOptions, BALANCE_RACE_NAMES, SC2PULSE_URL, type BalanceEvidence } from "@/lib/balance/evidence";
import { ladderShare, matchesVerdictInterval, replayVerdictLabel, replayVerdictPath, type ReplayVerdict } from "@/lib/balance/verdictShare";
import { BalanceCardActions } from "./BalanceCardActions";

const percent = new Intl.NumberFormat("en", { style: "percent", maximumFractionDigits: 1 });
const games = new Intl.NumberFormat("en");

export function BalanceVerdictCredit() {
  return <a href={SC2PULSE_URL} className="text-caption text-accent underline underline-offset-4">Data: SC2Pulse</a>;
}

export function ReplayVerdictCard({ summary, evidence, shared = false }: {
  summary: ReplayVerdict;
  evidence: BalanceEvidence;
  shared?: boolean;
}) {
  const { race, opponent, cohort, mapId, verdict, season, asOf } = summary;
  const counts = getBalanceCohort(evidence, cohort, race, opponent, mapId);
  const league = cohortOptions(evidence).find(option => option.value === cohort)?.label;
  const map = mapId === undefined ? null : evidence.maps.find(option => option.id === mapId)?.name;
  if (!counts || !league || (mapId !== undefined && !map)) {
    return <p role="status" className="text-body text-text-muted">This matchup has no same-tier games in the selected snapshot.</p>;
  }
  if (!matchesVerdictInterval(verdict, counts.interval)) {
    return <p role="status" className="text-body text-text-muted">The verdict label does not match the evidence in this snapshot.</p>;
  }
  const match = `${BALANCE_RACE_NAMES[race]} vs ${BALANCE_RACE_NAMES[opponent]}`;
  const title = replayVerdictLabel(verdict);
  const blame = percent.format(ladderShare(counts.winRate));
  const interval = `${percent.format(counts.interval.low)}–${percent.format(counts.interval.high)}`;
  const scope = `${match} · ${league}${map ? ` · ${map}` : ""}`;
  const snapshot = `Season ${season} · Snapshot ${asOf} UTC`;
  const data = `${games.format(counts.games)} same-tier games · ${counts.confidence}% interval ${interval}`;
  return (
    <article className="space-y-3 rounded-xl border-2 border-line bg-bg-surface p-4 shadow-hard sm:p-6">
      <p className="flex items-center gap-2 font-semibold text-text-muted"><Scale size={18} aria-hidden />Balance Court</p>
      <h2 className="font-display text-h2 font-bold text-text">{title}</h2>
      <p className="break-words text-body text-text-muted">{scope}</p>
      <p className="text-body-lg font-semibold text-text">Ladder&apos;s share of the blame <span className="tabular-nums text-accent">{blame}</span></p>
      <p className="text-body text-text-muted">{BALANCE_RACE_NAMES[race]} won {percent.format(counts.winRate)} of these games. {data}.</p>
      <p className="text-caption text-text-muted">{snapshot}. This estimates excess losses across the ladder cohort.</p>
      {shared ? <p className="text-caption text-text-muted">This verdict was shared by a player. The replay and its exhibits remain on their device.</p> : null}
      <BalanceVerdictCredit />
      <BalanceCardActions kind="verdict" title={`Balance Court · ${title}`} lines={[scope, `Ladder's share of the blame ${blame}`, data, snapshot, "Data: SC2Pulse"]} sharePath={replayVerdictPath(summary)} />
      {shared ? <Link href="/try#balance-court" className="inline-flex min-h-11 items-center text-accent underline underline-offset-4">Review your own loss</Link> : null}
    </article>
  );
}
