"use client";

import { useApi } from "@/lib/clientApi";
import { plural, record, signed, streamDiscordSummary, type NamedRecord, type StreamReport } from "@/lib/reports";
import { PageHeader } from "@/components/ui/PageHeader";
import { LinkButton } from "@/components/ui/Button";
import { Card, Skeleton } from "@/components/ui/Card";
import { CopyButton } from "@/components/ui/CopyButton";
import { RequestError } from "@/components/ui/RequestError";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";

const ENDED = { manual: "You ended this stream in the Dock.", idle: "Closed after four hours without a game.", restart: "Closed when a new session started in the Dock." };

/** /app/streams/[id]: one stream's record, MMR, maps, builds and aggregate viewer activity. */
export function StreamReportView({ id }: { id: string }) {
  const query = useApi<StreamReport>(`/v1/reports/streams/${encodeURIComponent(id)}`);
  const report = query.data;
  const dateLabel = report ? new Date(report.startAt).toLocaleDateString(undefined, { dateStyle: "medium" }) : "";
  return <div className="space-y-5">
    <PageHeader title="Stream report" description={report ? `${new Date(report.startAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} to ${new Date(report.endAt).toLocaleTimeString(undefined, { timeStyle: "short" })}` : "One stream in numbers."}
      actions={<LazyHelpLink slug="stream-reports" />} />
    {query.error && !report ? <RequestError error={query.error} onRetry={() => query.mutate()} /> : !report ? <Skeleton rows={6} /> : <>
      <div className="flex flex-wrap gap-2">
        <LinkButton href="/app/streams" variant="secondary" size="sm" className="min-h-11">All stream reports</LinkButton>
        <CopyButton text={streamDiscordSummary(report, dateLabel)} size="sm" className="min-h-11" successMessage="Discord summary copied" fallbackLabel="Copy this Discord summary">Copy Discord summary</CopyButton>
      </div>
      <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Fact label="Games" value={String(report.games)} />
        <Fact label="Record" value={record(report)} />
        <Fact label="Time in games" value={`${report.hours} h`} />
        <Fact label="MMR" value={report.mmr ? `${report.mmr.start} → ${report.mmr.end}` : "No rating"} note={report.mmr ? `${signed(report.mmr.delta)}, peak ${report.mmr.peak}` : undefined} />
      </dl>
      {report.mmr && report.mmr.points.length > 1 ? <Card><h2 className="mb-2 text-body font-semibold text-text">MMR during the stream</h2><Sparkline points={report.mmr.points} /></Card> : null}
      <div className="grid gap-3 md:grid-cols-3">
        <Records title="Matchups" rows={report.matchups} />
        <Records title="Maps" rows={report.maps} />
        <Records title="Builds" rows={report.builds} />
      </div>
      <StreamExtras report={report} />
      <p className="text-caption text-text-muted">{ENDED[report.endedBy] || ""}</p>
    </>}
  </div>;
}

function Fact({ label, value, note }: { label: string; value: string; note?: string }) {
  return <div className="rounded-xl border border-border bg-bg-surface p-3"><dt className="text-caption text-text-muted">{label}</dt><dd className="text-xl font-display font-bold tabular-nums text-text">{value}</dd>{note ? <dd className="text-caption text-text-muted">{note}</dd> : null}</div>;
}

function Records({ title, rows }: { title: string; rows: NamedRecord[] }) {
  return <Card><h2 className="mb-2 text-body font-semibold text-text">{title}</h2>
    {rows.length ? <ul className="space-y-1">{rows.map((row) => <li key={row.name} className="break-words text-caption text-text">{row.name}: {record(row)}</li>)}</ul> : <p className="text-caption text-text-muted">None recorded.</p>}
  </Card>;
}

function StreamExtras({ report }: { report: StreamReport }) {
  const ball = report.crystalBall;
  return <div className="grid gap-3 md:grid-cols-2">
    <Card><h2 className="mb-2 text-body font-semibold text-text">Highlights</h2><ul className="space-y-1 text-caption text-text">
      {report.bestWin ? <li>Best win: {report.bestWin.matchup}{report.bestWin.map ? ` on ${report.bestWin.map}` : ""} against {report.bestWin.opponentMmr} MMR</li> : <li>No rated win this stream.</li>}
      {report.randomizer ? <li>Randomizer builds: {plural(report.randomizer.games, "game")}, {record(report.randomizer)}</li> : null}
      {ball ? <li>Crystal Ball: {plural(ball.rounds, "round")}, {plural(ball.picks, "call")} from {plural(ball.viewers, "viewer")}{ball.accuracy !== null ? `, ${ball.accuracy}% right` : " (too few calls for a percentage)"}</li> : null}
      {report.supporters ? <li>Supporter events: {report.supporters.events} from {plural(report.supporters.viewers, "viewer")}</li> : null}
    </ul></Card>
    <Card><h2 className="mb-2 text-body font-semibold text-text">Clip moments</h2>
      {report.clips.length ? <ul className="space-y-1">{report.clips.map((clip) => <li key={`${clip.minute}-${clip.reason}`} className="break-words text-caption text-text"><span className="tabular-nums">{clip.minute} min</span> · {clip.reason || (clip.kind === "game-event" ? "Game moment" : "Chat spike")}</li>)}</ul>
        : <p className="text-caption text-text-muted">No clip moments were marked.</p>}
    </Card>
  </div>;
}

/** Decorative line with an accessible summary; no animation. */
function Sparkline({ points }: { points: number[] }) {
  const min = Math.min(...points); const max = Math.max(...points); const span = Math.max(1, max - min);
  const path = points.map((value, i) => `${(i / (points.length - 1)) * 100},${30 - ((value - min) / span) * 28 - 1}`).join(" ");
  return <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="h-16 w-full text-accent" role="img" aria-label={`MMR from ${points[0]} to ${points[points.length - 1]}, low ${min}, high ${max}`}>
    <polyline points={path} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
  </svg>;
}
