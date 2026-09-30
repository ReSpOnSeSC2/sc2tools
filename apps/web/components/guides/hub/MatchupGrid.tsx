import Link from "next/link";
import { TrendBadge } from "@/components/guides/TrendBadge";
import { guidePaths } from "@/components/guides/guideMetadata";
import { GUIDE_LINK_CLASS, GUIDE_PANEL_CLASS, verdictTextClass, cellVerdict } from "@/components/guides/guideUi";
import { fmtCount, fmtPct } from "@/lib/guides/format";
import { GUIDE_MATCHUPS } from "@/lib/guides/slugs";
import type { GuideIndexMatchup, GuideMatchup } from "@/lib/guides/types";

/**
 * The hub's 3×3 matchup grid: one row per race you play, one tile per
 * matchup with its game count and the top three published openers
 * ("What's winning with 12 starting workers") with their week-over-week
 * arrows. The win rates cover the whole era, not one week, so
 * the heading names the era (``period``, from ``eraLabel``).
 */

const RACE_ROWS: ReadonlyArray<{ letter: string; label: string }> = [
  { letter: "P", label: "Playing Protoss" },
  { letter: "T", label: "Playing Terran" },
  { letter: "Z", label: "Playing Zerg" },
];

function TopBuilds({ row, period }: { row: GuideIndexMatchup; period: string }) {
  if (!row.published || row.top.length === 0) {
    return <p className="text-caption text-text-dim">Not enough games yet.</p>;
  }
  return (
    <div className="space-y-1.5">
      <p className="text-micro font-semibold uppercase tracking-wider text-text-dim">What&apos;s winning {period}</p>
      <ol className="space-y-1.5">
        {row.top.map((build) => (
          <li key={build.buildKey} className="flex items-center justify-between gap-2 text-caption">
            <Link href={guidePaths.build(row.slug, build.buildSlug)} className={`${GUIDE_LINK_CLASS} min-w-0 break-words`}>
              {build.name}
            </Link>
            <span className="flex shrink-0 items-center gap-1.5">
              <span className={`font-semibold tabular-nums ${verdictTextClass(cellVerdict(build))}`}>
                {fmtPct(build.winRate)}
              </span>
              <TrendBadge trend={build.trend} isNew={build.isNew} />
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function MatchupTile({ row, period }: { row: GuideIndexMatchup; period: string }) {
  return (
    <li className={`${GUIDE_PANEL_CLASS} min-w-0 space-y-3 p-4`}>
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="font-display text-h3 font-bold">
          <Link href={guidePaths.matchup(row.slug)} className={GUIDE_LINK_CLASS}>
            {row.matchup}
          </Link>
        </h4>
        {row.published && row.games !== null ? (
          <span className="text-micro tabular-nums text-text-dim">{fmtCount(row.games)} games</span>
        ) : null}
      </div>
      <TopBuilds row={row} period={period} />
    </li>
  );
}

export function MatchupGrid({
  matchups,
  period,
}: {
  matchups: ReadonlyArray<GuideIndexMatchup>;
  /** The stats window, e.g. "with 12 starting workers" (``eraLabel``). */
  period: string;
}) {
  const byMatchup = new Map<GuideMatchup, GuideIndexMatchup>(matchups.map((row) => [row.matchup, row]));
  return (
    <div className="space-y-6">
      {RACE_ROWS.map((race) => {
        const rows = GUIDE_MATCHUPS.filter((matchup) => matchup.startsWith(race.letter))
          .map((matchup) => byMatchup.get(matchup))
          .filter((row): row is GuideIndexMatchup => row !== undefined);
        if (rows.length === 0) return null;
        return (
          <section key={race.letter} aria-label={race.label} className="space-y-2">
            <h3 className="text-caption font-semibold uppercase tracking-wider text-text-dim">{race.label}</h3>
            <ul className="grid gap-4 md:grid-cols-3">
              {rows.map((row) => (
                <MatchupTile key={row.matchup} row={row} period={period} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
