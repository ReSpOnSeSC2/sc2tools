"use client";

import { useMemo } from "react";
import { useApi } from "@/lib/clientApi";
import { analyzerViewHref } from "@/lib/analyzerViews";
import type { AnalyzerFilters } from "@/lib/filterContext";
import { browserTimeZone, plural, record, signed, weekLabel, winRate, type NamedRecord, type WeeklyReport } from "@/lib/reports";
import { PageHeader } from "@/components/ui/PageHeader";
import { LinkButton } from "@/components/ui/Button";
import { Card, Skeleton } from "@/components/ui/Card";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { RequestError } from "@/components/ui/RequestError";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { WinRateComparison } from "@/components/analyzer/charts/WinRateComparison";

/** /app/reports/weekly/[week]: one local ISO week next to the week before. Facts only. */
export function WeeklyReportView({ week }: { week: string }) {
  const tz = useMemo(() => browserTimeZone(), []);
  const query = useApi<WeeklyReport>(`/v1/reports/weekly?week=${encodeURIComponent(week)}&tz=${encodeURIComponent(tz)}`);
  const report = query.data;
  return <div className="space-y-5">
    <PageHeader title="Weekly report" description={report ? `${weekLabel(report.week)} · Monday to Sunday in ${report.timeZone.replaceAll("_", " ")}` : "Your week in numbers, next to the week before."}
      actions={<LazyHelpLink slug="weekly-report" />} />
    {query.error && !report ? <RequestError error={query.error} onRetry={() => query.mutate()} /> : !report ? <Skeleton rows={6} /> : <>
      <WeekNav report={report} />
      {report.totals.games === 0 ? <Card><EmptyStatePanel title="No games this week" description="Pick another week, or play a few games and come back next Monday." /></Card> : <WeeklyBody report={report} />}
    </>}
  </div>;
}

function WeekNav({ report }: { report: WeeklyReport }) {
  const trends = analyzerViewHref({ section: "trends", filters: { preset: "custom", since: report.start, until: new Date(Date.parse(report.end) - 1).toISOString() } as AnalyzerFilters });
  return <nav aria-label="Weeks" className="flex flex-wrap gap-2">
    {report.navigation.previous ? <LinkButton href={`/app/reports/weekly/${report.navigation.previous}`} variant="secondary" size="sm" className="min-h-11">Previous week</LinkButton> : null}
    {report.navigation.next ? <LinkButton href={`/app/reports/weekly/${report.navigation.next}`} variant="secondary" size="sm" className="min-h-11">Next week</LinkButton> : null}
    <LinkButton href={trends} variant="secondary" size="sm" className="min-h-11">Open in Trends</LinkButton>
  </nav>;
}

function WeeklyBody({ report }: { report: WeeklyReport }) {
  const t = report.totals; const p = t.previous;
  return <>
    <section aria-labelledby="week-totals" className="space-y-2">
      <h2 id="week-totals" className="text-body font-semibold text-text">This week</h2>
      <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Fact label="Games" value={String(t.games)} before={`${p.games} the week before`} />
        <Fact label="Record" value={record(t)} before={`${record(p)} the week before`} />
        <Fact label="Time played" value={`${t.hours} h`} before={`${p.hours} h the week before`} />
        <Fact label="Sessions" value={String(t.sessions)} before={`${p.sessions} the week before`} />
      </dl>
    </section>
    {report.matchups.length ? <Card><h2 className="mb-3 text-body font-semibold text-text">Matchups</h2>
      <WinRateComparison ariaLabel="Win rate by matchup this week" smallSampleThreshold={10} rows={report.matchups.map((row) => ({ key: row.matchup, label: row.matchup, rate: winRate(row),
        games: row.games, wins: row.wins, losses: row.losses, detail: row.previous.games ? `Week before: ${record(row.previous)} in ${plural(row.previous.games, "game")}` : "Not played the week before" }))} />
    </Card> : null}
    {report.mmr.length ? <Card><h2 className="mb-2 text-body font-semibold text-text">MMR</h2><ul className="space-y-1">{report.mmr.map((row) => <li key={`${row.account}-${row.race}`} className="text-caption text-text">
      <span className="font-semibold">{row.account} · {row.race}</span>: {row.start} → {row.end} ({signed(row.delta)}), peak {row.peak}, {plural(row.games, "rated game")}</li>)}</ul></Card> : null}
    <div className="grid gap-3 md:grid-cols-2">
      <BestWorst title="Maps" facts={report.maps} />
      <BestWorst title="Builds" facts={report.builds} />
    </div>
    {report.opponentStrategies.length ? <Card><h2 className="mb-2 text-body font-semibold text-text">Opponent strategies you faced most</h2><ul className="space-y-1">{report.opponentStrategies.map((row) => <li key={row.name} className="text-caption text-text">{row.name}: {plural(row.games, "game")}, you went {record(row)}</li>)}</ul></Card> : null}
    <MacroCard report={report} />
    {report.truncated ? <p className="text-caption text-text-muted">This week had more games than the report reads at once; totals cover the first 3,000.</p> : null}
  </>;
}

function Fact({ label, value, before }: { label: string; value: string; before: string }) {
  return <div className="rounded-xl border border-border bg-bg-surface p-3"><dt className="text-caption text-text-muted">{label}</dt><dd className="text-xl font-display font-bold tabular-nums text-text">{value}</dd><dd className="text-caption text-text-muted">{before}</dd></div>;
}

function BestWorst({ title, facts }: { title: string; facts: { best: NamedRecord | null; worst: NamedRecord | null; minDecided: number } }) {
  const line = (label: string, row: NamedRecord) => <p className="text-caption text-text"><span className="font-semibold">{label}:</span> {row.name} ({record(row)} in {plural(row.games, "game")})</p>;
  return <Card><h2 className="mb-2 text-body font-semibold text-text">{title}</h2>
    {facts.best ? line("Best", facts.best) : <p className="text-caption text-text-muted">Nothing with {facts.minDecided} or more decided games yet.</p>}
    {facts.worst ? line("Worst", facts.worst) : null}
  </Card>;
}

function MacroCard({ report }: { report: WeeklyReport }) {
  const m = report.macro;
  if (m.average === null && m.previous.average === null && !m.topLeak) return null;
  return <Card><h2 className="mb-2 text-body font-semibold text-text">Macro</h2>
    <p className="text-caption text-text">Average macro score: {m.average ?? "not enough scored games"}{m.average !== null ? ` over ${plural(m.games, "game")}` : ""}{m.previous.average !== null ? ` (week before: ${m.previous.average})` : ""}.</p>
    {m.topLeak ? <p className="text-caption text-text">Most frequent leak: {m.topLeak.name}, in {plural(m.topLeak.games, "game")}{m.previous.topLeak ? ` (week before: ${m.previous.topLeak.name})` : ""}.</p> : null}
    <p className="mt-1 text-caption text-text-muted">Averages need at least {m.minGames} scored games.</p>
  </Card>;
}
