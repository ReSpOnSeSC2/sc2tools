import { Badge } from "@/components/ui/Badge";
import { PageHeader } from "@/components/ui/PageHeader";
import { GuideCopyText } from "@/components/guides/GuideCopyText";
import { GuideCtas } from "@/components/guides/GuideCtas";
import { TrendBadge } from "@/components/guides/TrendBadge";
import { eraLabel } from "@/components/guides/guideUi";
import { guidePaths } from "@/components/guides/guideMetadata";
import { fmtCount, fmtCountNoun, fmtGuideDate, fmtPct } from "@/lib/guides/format";
import { eraShortLabel, type GuideCopyLine } from "@/lib/guides/guideCopy";
import type { GhostTarget } from "@/lib/ghostBuild";
import type { GuideBuildPublished } from "@/lib/guides/types";

/**
 * Section 1 of a build guide: name, matchup badge, the catalog's own
 * one-line description, the headline stat (densest opponent league that
 * clears the floor, else all games), n + stats date, the deterministic
 * intro paragraph and the CTAs.
 */

/**
 * Example: "56.6% win rate over 146 games vs Diamond opponents with 12 starting workers".
 */
export function headlineSentence(payload: GuideBuildPublished): string {
  const when = eraLabel(payload.era);
  const { headline, overall } = payload;
  if (headline && headline.scope === "league" && headline.label) {
    return `${fmtPct(headline.winRate)} win rate over ${fmtCount(headline.games)} games vs ${headline.label} opponents ${when}`;
  }
  const games = headline ? headline.games : overall.games;
  const winRate = headline ? headline.winRate : overall.winRate;
  return `${fmtPct(winRate)} win rate over ${fmtCount(games)} ladder games ${when}`;
}

export function BuildHero({
  payload,
  intro,
  ghostTarget,
}: {
  payload: GuideBuildPublished;
  intro: ReadonlyArray<GuideCopyLine>;
  ghostTarget: GhostTarget | null;
}) {
  const { overall } = payload;
  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow={`${payload.matchup} build order guide`}
        title={payload.name}
        description={payload.description}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="cyan">{payload.matchup}</Badge>
        <Badge variant="neutral">{eraShortLabel(payload.era)}</Badge>
        <TrendBadge trend={payload.trend} isNew={payload.isNew} showDelta />
      </div>
      <p className="font-display text-h3 font-bold text-text" data-testid="guide-headline">
        {headlineSentence(payload)}
      </p>
      <p className="text-caption tabular-nums text-text-dim">
        n = {fmtCount(overall.games)} games from {fmtCountNoun(overall.users, "player")}
        {payload.computedAt ? ` · Stats updated ${fmtGuideDate(payload.computedAt)}` : ""}
      </p>
      <GuideCopyText lines={intro} />
      <GuideCtas
        matchup={payload.matchup}
        buildSlug={payload.buildSlug}
        matchupPath={guidePaths.matchup(payload.matchupSlug)}
        ghostTarget={ghostTarget}
      />
    </div>
  );
}
