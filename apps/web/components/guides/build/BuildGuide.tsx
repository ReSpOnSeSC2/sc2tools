import { GuideBreadcrumbs } from "@/components/guides/GuideBreadcrumbs";
import { GuideEightWorkerVideos } from "@/components/guides/GuideEightWorkerVideos";
import { GuideJsonLd } from "@/components/guides/GuideJsonLd";
import { GuideNotEnoughGames } from "@/components/guides/GuideStates";
import { GuideVideoSection } from "@/components/guides/GuideVideoSection";
import { GuideSectionNav } from "@/components/guides/GuideSectionNav";
import { GuideStatsLegend } from "@/components/guides/GuideStatsLegend";
import { buildGuideSections } from "./buildGuideSections";
import { BuildHero } from "@/components/guides/build/BuildHero";
import { BuildArmySection } from "@/components/guides/build/BuildArmySection";
import { BuildBandsSection, BuildLengthsSection } from "@/components/guides/build/BuildChartSections";
import { BuildMapsSection, BuildVsStrategySection } from "@/components/guides/build/BuildMatchupSections";
import { BuildTimingsSection } from "@/components/guides/build/BuildTimingsSection";
import {
  BuildLeaksSection,
  BuildNotesSection,
  BuildRelatedSection,
} from "@/components/guides/build/BuildExtrasSections";
import { buildDescription, buildHeadline, guidePaths } from "@/components/guides/guideMetadata";
import {
  breadcrumbJsonLd,
  buildArticleJsonLd,
  embeddedVideoJsonLd,
  type GuideCrumb,
} from "@/components/guides/guideSeo";
import { buildGhostTargetFromGuide } from "@/lib/guides/ghost";
import { buildIntro, buildTimingsBlurb } from "@/lib/guides/guideCopy";
import type { GuideBuildPayload, GuideBuildPublished, GuideBuildUnpublished } from "@/lib/guides/types";

/**
 * Body of /guides/[matchup]/[build]: the published guide (sections in
 * the brief's order) or the number-free "not enough games yet" page, each
 * ending with the build's collapsed 8-worker patch videos.
 * Server component; the only client islands are the CTAs, the personal
 * comparison, the charts and the video facade.
 */

const EIGHT_WORKER_TITLE = "Videos of this build from the 8-worker patch";

export function buildCrumbs(payload: GuideBuildPayload): GuideCrumb[] {
  return [
    { name: "Guides", path: guidePaths.hub() },
    { name: payload.matchup, path: guidePaths.matchup(payload.matchupSlug) },
    { name: payload.name, path: guidePaths.build(payload.matchupSlug, payload.buildSlug) },
  ];
}

function buildJsonLd(payload: GuideBuildPayload): Array<Record<string, unknown>> {
  const crumbs = buildCrumbs(payload);
  const items: Array<Record<string, unknown>> = [breadcrumbJsonLd(crumbs)];
  if (payload.published) {
    const path = guidePaths.build(payload.matchupSlug, payload.buildSlug);
    items.push(buildArticleJsonLd(payload, path, buildHeadline(payload), buildDescription(payload)));
  }
  items.push(...embeddedVideoJsonLd(payload.videos));
  return items;
}

function PublishedBuild({
  payload,
  publishedPaths,
}: {
  payload: GuideBuildPublished;
  publishedPaths: ReadonlySet<string> | null;
}) {
  const sections = buildGuideSections(payload);
  const content: Record<string, React.ReactNode> = {
    video: <GuideVideoSection videos={payload.videos} />,
    "win-rate-by-band": <BuildBandsSection bands={payload.bands} computedAt={payload.computedAt} />,
    "key-timings": <BuildTimingsSection payload={payload} blurb={buildTimingsBlurb(payload)} />,
    "your-record": <BuildTimingsSection payload={payload} blurb={buildTimingsBlurb(payload)} />,
    army: <BuildArmySection army={payload.army} />,
    "vs-openers": <BuildVsStrategySection rows={payload.vsStrategy} matchupSlug={payload.matchupSlug} />,
    "when-it-wins": <BuildLengthsSection lengths={payload.lengths} />,
    maps: <BuildMapsSection maps={payload.maps} publishedPaths={publishedPaths} />,
    "macro-leaks": <BuildLeaksSection leaks={payload.leaks} macro={payload.macro} />,
    related: <BuildRelatedSection related={payload.related} communityBuilds={payload.communityBuilds} examples={payload.examples} matchupSlug={payload.matchupSlug} />,
    "coach-notes": <BuildNotesSection notes={payload.notes} />,
    "eight-worker-videos": <GuideEightWorkerVideos title={EIGHT_WORKER_TITLE} videos={payload.eightWorkerVideos} />,
  };
  return (
    <>
      <BuildHero
        payload={payload}
        intro={buildIntro(payload)}
        ghostTarget={buildGhostTargetFromGuide(payload)}
      />
      <GuideSectionNav items={sections}>
        {!sections.some((section) => section.id === "win-rate-by-band") ? <GuideStatsLegend computedAt={payload.computedAt} /> : null}
        {sections.map((section) => <div key={section.id}>{content[section.id]}</div>)}
      </GuideSectionNav>
    </>
  );
}

function UnpublishedBuild({ payload }: { payload: GuideBuildUnpublished }) {
  return (
    <GuideNotEnoughGames
      eyebrow={`${payload.matchup} build order guide`}
      title={payload.name}
      description={payload.description}
      backHref={guidePaths.matchup(payload.matchupSlug)}
      backLabel={`What's winning in ${payload.matchup}`}
    >
      <GuideVideoSection videos={payload.videos} />
      <GuideEightWorkerVideos title={EIGHT_WORKER_TITLE} videos={payload.eightWorkerVideos} />
    </GuideNotEnoughGames>
  );
}

/**
 * `publishedPaths`: published guide page paths (null = unknown), which
 * gate the links whose target's publication the payload doesn't carry.
 */
export function BuildGuide({
  payload,
  publishedPaths = null,
}: {
  payload: GuideBuildPayload;
  publishedPaths?: ReadonlySet<string> | null;
}) {
  return (
    <article className="space-y-10">
      <GuideJsonLd items={buildJsonLd(payload)} />
      <GuideBreadcrumbs crumbs={buildCrumbs(payload)} />
      {payload.published ? (
        <PublishedBuild payload={payload} publishedPaths={publishedPaths} />
      ) : (
        <UnpublishedBuild payload={payload} />
      )}
    </article>
  );
}
