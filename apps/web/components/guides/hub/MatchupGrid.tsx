/* eslint-disable @next/next/no-img-element */
import Link from "next/link";
import { TrendBadge } from "@/components/guides/TrendBadge";
import { MatchupLabel } from "@/components/guides/MatchupLabel";
import { guidePaths } from "@/components/guides/guideMetadata";
import { GUIDE_LINK_CLASS, GUIDE_PANEL_CLASS, verdictTextClass, verdictMeta, cellVerdict, oppRaceWord } from "@/components/guides/guideUi";
import { fmtCount, fmtCountNoun, fmtPct } from "@/lib/guides/format";
import { GUIDE_MATCHUPS } from "@/lib/guides/slugs";
import { raceTint, type Race } from "@/lib/race";
import { getIconPath } from "@/lib/sc2-icons";
import type { GuideIndexMatchup, GuideMatchup } from "@/lib/guides/types";

const RACE_ROWS: readonly { letter: string; race: Race }[] = [{ letter: "P", race: "Protoss" }, { letter: "T", race: "Terran" }, { letter: "Z", race: "Zerg" }];
function TopBuilds({ row }: { row: GuideIndexMatchup }) {
  if (!row.published || !row.top.length) return <p className="text-caption text-text-dim">Not enough games yet.</p>;
  return <ol className="space-y-1.5">{row.top.map((build) => {
    const verdict = cellVerdict(build); const meta = verdictMeta(verdict);
    return <li key={build.buildKey} className="flex items-center justify-between gap-2 text-caption"><Link href={guidePaths.build(row.slug, build.buildSlug)} className={`${GUIDE_LINK_CLASS} relative z-10 min-w-0 break-words`}>{build.name}</Link><span className="flex shrink-0 items-center gap-1.5"><span className={`font-semibold tabular-nums ${verdictTextClass(verdict)}`}><span aria-hidden>{meta.glyph} </span>{fmtPct(build.winRate)}<span className="sr-only">, {meta.phrase}</span></span><TrendBadge trend={build.trend} isNew={build.isNew} /></span></li>;
  })}</ol>;
}
function MatchupTile({ row }: { row: GuideIndexMatchup }) {
  return <li className={`${GUIDE_PANEL_CLASS} relative min-w-0 space-y-3 p-4 has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-accent`}>
    <div className="flex items-baseline justify-between gap-2"><h4 className="font-display text-h3 font-bold"><Link href={guidePaths.matchup(row.slug)} className={`${GUIDE_LINK_CLASS} after:absolute after:inset-0`} data-stretched-guide-link><MatchupLabel matchup={row.matchup} /></Link></h4>{row.published && row.games !== null ? <span className="text-micro tabular-nums text-text-dim">{fmtCount(row.games)} games</span> : null}</div>
    <TopBuilds row={row} />
    <div className="relative z-10 flex flex-col items-start gap-2 border-t border-border pt-3 text-caption">{row.publishedBuilds > 0 ? <Link href={guidePaths.matchup(row.slug)} className={GUIDE_LINK_CLASS}>All {fmtCountNoun(row.publishedBuilds, "opener")} →</Link> : null}{row.published ? <Link href={guidePaths.counters(row.slug)} className={GUIDE_LINK_CLASS}>How to beat {oppRaceWord(row.matchup)} openers →</Link> : null}</div>
  </li>;
}
export function MatchupGrid({ matchups }: { matchups: readonly GuideIndexMatchup[]; period?: string }) {
  const byMatchup = new Map<GuideMatchup, GuideIndexMatchup>(matchups.map((row) => [row.matchup, row]));
  return <div className="space-y-6">{RACE_ROWS.map(({ letter, race }) => {
    const rows = GUIDE_MATCHUPS.filter((matchup) => matchup.startsWith(letter)).map((matchup) => byMatchup.get(matchup)).filter((row): row is GuideIndexMatchup => Boolean(row));
    if (!rows.length) return null;
    const icon = getIconPath(race, "race");
    // Mixing a little text ink keeps the race accent above 4.5:1 on light
    // surfaces without changing the shared race colors used in charts.
    return <section key={letter} aria-label={`Playing ${race}`} className="space-y-2"><h3 className={`flex items-center gap-2 text-caption font-semibold uppercase tracking-wider ${raceTint(race).text}`} style={{ color: `color-mix(in srgb, rgb(var(--race-${race.toLowerCase()})) 85%, rgb(var(--text)))` }}>{icon ? <img src={icon} alt="" width={24} height={24} data-race-icon={race} className="h-6 w-6" /> : null}Playing {race}</h3><ul className="grid gap-4 md:grid-cols-3">{rows.map((row) => <MatchupTile key={row.matchup} row={row} />)}</ul></section>;
  })}</div>;
}
