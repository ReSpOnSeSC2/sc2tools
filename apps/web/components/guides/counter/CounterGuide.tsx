import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import { PageHeader } from "@/components/ui/PageHeader";
import { GuideSection as Section } from "@/components/guides/GuideSection";
import { GuideBreadcrumbs } from "@/components/guides/GuideBreadcrumbs";
import { GuideCopyText } from "@/components/guides/GuideCopyText";
import { GuideEightWorkerVideos } from "@/components/guides/GuideEightWorkerVideos";
import { GuideJsonLd } from "@/components/guides/GuideJsonLd";
import { GuideNotEnoughGames } from "@/components/guides/GuideStates";
import { GuideVideoSection } from "@/components/guides/GuideVideoSection";
import { GuideSectionNav } from "@/components/guides/GuideSectionNav";
import { GuideStatsLegend } from "@/components/guides/GuideStatsLegend";
import { safeVideoUrls } from "@/components/guides/youtubeUrls";
import { WinRateCell } from "@/components/guides/WinRateCell";
import { guidePaths } from "@/components/guides/guideMetadata";
import { breadcrumbJsonLd, embeddedVideoJsonLd, type GuideCrumb } from "@/components/guides/guideSeo";
import { GUIDE_LINK_CLASS, GUIDE_PANEL_CLASS, myRaceWord, oppRaceWord, cellVerdict, verdictLabel } from "@/components/guides/guideUi";
import { BUILD_DEFINITIONS } from "@/lib/build-definitions";
import { fmtCount, fmtCountNoun, fmtGuideDate, fmtPct } from "@/lib/guides/format";
import { buildCounterIntro } from "@/lib/guides/guideCopy";
import type { GuideCounterOpener, GuideCounterPayload, GuideCounterPublished } from "@/lib/guides/types";

/**
 * Body of /guides/[matchup]/counter/[strategy] — how to beat one
 * opponent opener: the viewer race's overall record against it, the
 * openers ranked by the low end of their likely win rate (each with its
 * catalog description), the channel video when one matches and, collapsed
 * at the foot, matching videos from the 8-worker patch.
 */

const EIGHT_WORKER_TITLE = "Videos against this opener from the 8-worker patch";

const CATALOG_DESCRIPTIONS: ReadonlyMap<string, string> = new Map(
  BUILD_DEFINITIONS.map((definition) => [definition.name, definition.description]),
);

export function counterCrumbs(payload: GuideCounterPayload): GuideCrumb[] {
  return [
    { name: "Guides", path: guidePaths.hub() },
    { name: payload.matchup, path: guidePaths.matchup(payload.matchupSlug) },
    { name: "Counters", path: guidePaths.counters(payload.matchupSlug) },
    { name: `How to beat ${payload.name}`, path: guidePaths.counter(payload.matchupSlug, payload.strategySlug) },
  ];
}

function OpenerCard({ opener, rank, matchupSlug }: { opener: GuideCounterOpener; rank: number; matchupSlug: string }) {
  const description = CATALOG_DESCRIPTIONS.get(opener.buildKey) ?? null;
  return (
    <li className={`${GUIDE_PANEL_CLASS} flex gap-3 p-4`}>
      <span className="font-display text-h4 font-bold tabular-nums text-text-dim" aria-hidden>
        {rank}
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h3 className="min-w-0 font-display text-h4 font-bold text-text">
            {opener.published ? (
              <Link href={guidePaths.build(matchupSlug, opener.buildSlug)} className={GUIDE_LINK_CLASS}>
                {opener.name}
              </Link>
            ) : (
              opener.name
            )}
          </h3>
          <WinRateCell winRate={opener.winRate} ci={opener.ci} />
        </div>
        <p className="text-micro tabular-nums text-text-dim">
          Based on {fmtCount(opener.games)} games from {fmtCountNoun(opener.users, "player")}
        </p>
        {description ? <p className="text-caption text-text-muted">{description}</p> : null}
      </div>
    </li>
  );
}

function PublishedCounter({ payload }: { payload: GuideCounterPublished }) {
  const { overall } = payload;
  return (
    <>
      <div className="space-y-3">
        <PageHeader eyebrow={`${payload.matchup} counter guide`} title={`How to beat ${payload.name}`} description={payload.description} />
        <p className="font-display text-h3 font-bold text-text" data-testid="guide-headline">
          {myRaceWord(payload.matchup)} win rate against it: {fmtPct(overall.winRate)} <Badge variant="neutral">{verdictLabel(cellVerdict(overall))}</Badge>
        </p>
        <p className="text-caption tabular-nums text-text-dim">
          Based on {fmtCount(overall.games)} games from {fmtCountNoun(overall.users, "player")}
          {payload.computedAt ? ` · updated ${fmtGuideDate(payload.computedAt)}` : ""}
        </p>
        <GuideCopyText lines={buildCounterIntro(payload)} />
      </div>
      <GuideSectionNav items={[
        ...(payload.videos.length ? [{ id: "video", label: "Video" }] : []),
        ...(payload.openers.length ? [{ id: "best-openers", label: "Best openers" }] : []),
        ...(payload.eightWorkerVideos?.some((video) => safeVideoUrls(video).watch) ? [{ id: "eight-worker-videos", label: "8-worker videos" }] : []),
      ]}>
      {!payload.openers.length ? <GuideStatsLegend computedAt={payload.computedAt} /> : null}
      <GuideVideoSection videos={payload.videos} />
      {payload.openers.length > 0 ? (
        <Section id="best-openers" title={`Best ${myRaceWord(payload.matchup)} openers against ${payload.name}`}>
          <GuideStatsLegend computedAt={payload.computedAt} />
          <ol className="mt-4 space-y-3">
            {payload.openers.map((opener, index) => (
              <OpenerCard key={opener.buildKey} opener={opener} rank={index + 1} matchupSlug={payload.matchupSlug} />
            ))}
          </ol>
        </Section>
      ) : null}
      <GuideEightWorkerVideos title={EIGHT_WORKER_TITLE} videos={payload.eightWorkerVideos} />
      </GuideSectionNav>
    </>
  );
}

export function CounterGuide({ payload }: { payload: GuideCounterPayload }) {
  const crumbs = counterCrumbs(payload);
  const jsonLd = [breadcrumbJsonLd(crumbs), ...embeddedVideoJsonLd(payload.videos)];
  return (
    <article className="space-y-10">
      <GuideJsonLd items={jsonLd} />
      <GuideBreadcrumbs crumbs={crumbs} />
      {payload.published ? (
        <PublishedCounter payload={payload} />
      ) : (
        <GuideNotEnoughGames
          eyebrow={`${payload.matchup} counter guide`}
          title={`How to beat ${payload.name}`}
          description={payload.description}
          backHref={guidePaths.counters(payload.matchupSlug)}
          backLabel={`All ${oppRaceWord(payload.matchup)} openers`}
        >
          <GuideVideoSection videos={payload.videos} />
          <GuideEightWorkerVideos title={EIGHT_WORKER_TITLE} videos={payload.eightWorkerVideos} />
        </GuideNotEnoughGames>
      )}
    </article>
  );
}
