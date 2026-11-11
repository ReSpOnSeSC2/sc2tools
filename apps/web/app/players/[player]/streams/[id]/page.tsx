import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { StatCard } from "@/components/ui/Stat";
import { LinkButton } from "@/components/ui/Button";
import { record, signed } from "@/lib/reports";
import { fetchPublicStreamReport, type PublicStreamParams } from "@/lib/publicStreamReport";
import { siteTitle } from "@/lib/siteTitle";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: PublicStreamParams): Promise<Metadata> {
  const { player, id } = await params;
  const report = await fetchPublicStreamReport(player, id);
  if (!report) notFound();
  const title = siteTitle(`${report.player} · Stream report`);
  const description = `${report.games} games · ${record(report)} · ${report.hours} h played`;
  return { title, description, robots: { index: false, follow: false, nocache: true },
    openGraph: { title, description }, twitter: { card: "summary_large_image", title, description } };
}

export default async function PublicStreamPage({ params }: PublicStreamParams) {
  const { player, id } = await params;
  const report = await fetchPublicStreamReport(player, id);
  if (!report) notFound();
  const date = new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" }).format(new Date(`${report.date}T12:00:00Z`));
  return <main className="mx-auto w-full max-w-4xl space-y-5 px-4 py-8 sm:px-6">
    <header className="space-y-2">
      <h1 className="break-words font-display text-h1 font-bold text-text">{report.player}&apos;s stream report</h1>
      <p className="text-caption text-text-muted">{date}</p>
      <LinkButton href={`/players/${encodeURIComponent(report.slug)}`} size="sm" variant="secondary" className="min-h-11">View player page</LinkButton>
    </header>
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <StatCard label="Games" value={String(report.games)} size="sm" />
      <StatCard label="Wins–losses" value={record(report)} size="sm" />
      <StatCard label="Hours played" value={String(report.hours)} size="sm" />
      {report.mmrDelta !== null ? <StatCard label="MMR change" value={signed(report.mmrDelta)} size="sm" /> : null}
    </div>
    {report.matchups.length ? <Card title="Matchup records">
      <ul className="space-y-2">{report.matchups.map((row) => <li key={row.name} className="text-body text-text">{row.name} · {record(row)}</li>)}</ul>
    </Card> : null}
  </main>;
}
