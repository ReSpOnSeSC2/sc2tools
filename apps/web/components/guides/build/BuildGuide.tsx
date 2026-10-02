import { GuideBreadcrumbs } from "@/components/guides/GuideBreadcrumbs";
import { GuideEightWorkerVideos } from "@/components/guides/GuideEightWorkerVideos";
import { GuideJsonLd } from "@/components/guides/GuideJsonLd";
import { GuideNotEnoughGames } from "@/components/guides/GuideStates";
import { GuideVideoSection } from "@/components/guides/GuideVideoSection";
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
  return (
    <>
      <BuildHero
        payload={payload}
        intro={buildIntro(payload)}
        ghostTarget={buildGhostTargetFromGuide(payload)}
      />
      <GuideVideoSection videos={payload.videos} />
      <BuildBandsSection bands={payload.bands} />
      <BuildTimingsSection payload={payload} blurb={buildTimingsBlurb(payload)} />
      <BuildArmySection army={payload.army} />
      <BuildVsStrategySection rows={payload.vsStrategy} matchupSlug={payload.matchupSlug} />
      <BuildLengthsSection lengths={payload.lengths} />
      <BuildMapsSection maps={payload.maps} publishedPaths={publishedPaths} />
      <BuildLeaksSection leaks={payload.leaks} macro={payload.macro} />
      <BuildRelatedSection
        related={payload.related}
        communityBuilds={payload.communityBuilds}
        examples={payload.examples}
        matchupSlug={payload.matchupSlug}
      />
      <BuildNotesSection notes={payload.notes} />
      <GuideEightWorkerVideos title={EIGHT_WORKER_TITLE} videos={payload.eightWorkerVideos} />
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
