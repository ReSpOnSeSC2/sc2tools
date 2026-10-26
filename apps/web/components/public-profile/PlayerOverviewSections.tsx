import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { publicDate } from "@/lib/seo/publicDate";
import type { PublicPlayerProfile } from "./types";

/** All optional sections have already passed their independent API switches. */
export function PlayerOverviewSections({ profile }: { profile: PublicPlayerProfile }) {
  return <div className="grid min-w-0 gap-5 lg:grid-cols-2">
    {profile.sections?.showReplays && profile.replayArchive ? <Card title="Shared replays" padded><p className="mb-3 text-caption text-text-muted">Original replays shared separately by this player.</p><Link className="inline-flex min-h-11 items-center font-semibold text-accent underline" href={`/players/${encodeURIComponent(profile.replayArchive.handle)}/replays`}>Browse {profile.replayArchive.total.toLocaleString("en-US")} replays</Link></Card> : null}
    {profile.sections?.showRecentForm && (profile.recentForm?.length || 0) >= 3 ? <RecentForm profile={profile} /> : null}
    {profile.sections?.showChannels && profile.channels?.length ? <Card title="Channels" padded><ul className="space-y-2">{profile.channels.map(channel => <li key={channel.url}><a href={channel.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center font-semibold capitalize text-accent underline">{channel.platform}<span className="sr-only"> (opens in a new tab)</span></a></li>)}</ul></Card> : null}
    {profile.sections?.showMmrHistory && profile.mmrHistory?.length ? <MmrHistory rows={profile.mmrHistory} /> : null}
    {profile.sections?.showSeasons && profile.seasons?.length ? <Card title="Season records" padded><ul className="space-y-3 text-caption">{profile.seasons.map(row => <li key={row.season}>Season {row.season}: {row.wins}–{row.losses} · {row.mainRace || "Mixed"}{row.peakMmr !== null ? ` · peak ${row.peakMmr} MMR` : ""}</li>)}</ul></Card> : null}
    {profile.sections?.showSeasons && profile.seasonDataAvailable === false ? <Card title="Season records" padded><p className="text-caption text-text-muted">The season catalog is not available yet. No season record is inferred from calendar dates.</p></Card> : null}
    {profile.sections?.showMaps && profile.maps?.length ? <Card title="Maps · at least 10 games" padded><ul className="space-y-3 text-caption">{profile.maps.map(row => <li key={row.name}><span className="font-semibold">{row.name}</span>: {row.wins}–{row.losses} · {row.games} games</li>)}</ul></Card> : null}
  </div>;
}

function RecentForm({ profile }: { profile: PublicPlayerProfile }) {
  const rows = profile.recentForm || [], wins = rows.filter(row => row.result === "W").length, losses = rows.filter(row => row.result === "L").length;
  const ties = rows.length - wins - losses;
  const summary = `Last ${rows.length}: ${wins} ${wins === 1 ? "win" : "wins"}, ${losses} ${losses === 1 ? "loss" : "losses"}${ties ? `, ${ties} ${ties === 1 ? "tie" : "ties"}` : ""}`;
  return <Card title="Recent form" padded><ol aria-label={summary} className="flex flex-wrap gap-2">{[...rows].reverse().map((row, index) => <li key={`${row.date}:${index}`} aria-label={`${row.result === "W" ? "Win" : row.result === "L" ? "Loss" : "Tie"}, ${row.matchup}, ${publicDate(row.date)}`}
    className={`grid h-9 w-9 place-items-center rounded-md border font-mono text-caption ${row.result === "W" ? "border-success/40 bg-success/10 text-success" : row.result === "L" ? "border-danger/40 bg-danger/10 text-danger" : "border-border text-text-muted"}`}>{row.result}</li>)}</ol>
    <p className="mt-3 text-caption text-text-muted">{summary}</p>
    {profile.currentStreak && profile.currentStreak.count >= 2 ? <p className="mt-2 text-caption">{profile.currentStreak.count}-{profile.currentStreak.kind === "W" ? "win" : "loss"} streak</p> : null}
    {profile.lastPlayedAt ? <p className="mt-2 text-caption text-text-muted">Last played {new Intl.RelativeTimeFormat("en-US", { numeric: "auto" }).format(-Math.max(0, Math.floor((Date.now() - Date.parse(profile.lastPlayedAt)) / 86_400_000)), "day")}</p> : null}
  </Card>;
}

function MmrHistory({ rows }: { rows: NonNullable<PublicPlayerProfile["mmrHistory"]> }) {
  const values = rows.map(row => row.mmr), low = Math.min(...values), high = Math.max(...values), range = Math.max(1, high - low);
  const points = rows.map((row, index) => `${10 + index * 280 / Math.max(1, rows.length - 1)},${85 - (row.mmr - low) * 65 / range}`).join(" ");
  return <Card title="MMR · weekly average over 90 days" padded><svg viewBox="0 0 300 100" role="img" aria-label={`Weekly average MMR: ${values.join(", ")}`} className="h-28 w-full text-accent"><polyline points={points} fill="none" stroke="currentColor" strokeWidth="3" vectorEffect="non-scaling-stroke" /></svg><p className="text-caption text-text-muted">{low}–{high} MMR · {rows.length} measured weeks</p></Card>;
}
