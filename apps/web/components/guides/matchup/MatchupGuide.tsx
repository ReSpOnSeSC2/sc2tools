import Link from "next/link";
import { Section } from "@/components/ui/Section";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { GuideBreadcrumbs } from "@/components/guides/GuideBreadcrumbs";
import { GuideCopyText } from "@/components/guides/GuideCopyText";
import { GuideJsonLd } from "@/components/guides/GuideJsonLd";
import { GuideNotEnoughGames } from "@/components/guides/GuideStates";
import { GuideVideoRow } from "@/components/guides/GuideVideoRow";
import { BandSwitcher } from "@/components/guides/matchup/BandSwitcher";
import { CounterLinks } from "@/components/guides/matchup/CounterLinks";
import { OpenersTable } from "@/components/guides/matchup/OpenersTable";
import { guidePaths } from "@/components/guides/guideMetadata";
import { breadcrumbJsonLd, type GuideCrumb } from "@/components/guides/guideSeo";
import { GUIDE_LINK_CLASS, GUIDE_PANEL_CLASS, eraLabel, oppRaceWord } from "@/components/guides/guideUi";
import { fmtGuideDate } from "@/lib/guides/format";
import { buildMatchupIntro } from "@/lib/guides/guideCopy";
import type { GuideMatchupPayload } from "@/lib/guides/types";

/**
 * Body of /guides/[matchup]: intro, filters, the ranked openers table,
 * "How to beat …" counter links and the latest channel videos for the
 * matchup. Unpublished matchups get the "not enough games yet" page.
 */

export function matchupCrumbs(payload: Pick<GuideMatchupPayload, "matchup" | "slug">): GuideCrumb[] {
  return [
    { name: "Guides", path: guidePaths.hub() },
    { name: payload.matchup, path: guidePaths.matchup(payload.slug) },
  ];
}

function OpenersSection({ payload }: { payload: GuideMatchupPayload }) {
  const bandText = payload.band ? ` vs ${payload.band.label}${payload.band.type === "mmr" ? " MMR" : ""} opponents` : "";
  return (
    <Section
      id="openers"
      title={`${payload.matchup} openers ranked`}
      description="Ranked by the low end of each opener's likely win-rate range, so small samples can't top the table on luck."
    >
      <div className="space-y-4">
        <BandSwitcher
          matchupSlug={payload.slug}
          band={payload.band}
          era={payload.era}
          patch={payload.patch}
          options={payload.bandOptions}
        />
        {payload.openers.length > 0 ? (
          <OpenersTable
            openers={payload.openers}
            matchupSlug={payload.slug}
            caption={`${payload.matchup} openers${bandText}, ${eraLabel(payload.era, payload.patch)}`}
          />
        ) : (
          <div className={GUIDE_PANEL_CLASS}>
            <EmptyStatePanel
              size="sm"
              title="No opener has enough games in this filter yet"
              description="Try another band or the full ladder view."
            />
          </div>
        )}
      </div>
    </Section>
  );
}

function CountersSection({ payload }: { payload: GuideMatchupPayload }) {
  if (!payload.counters.some((counter) => counter.published)) return null;
  return (
    <Section
      id="counters"
      title={`How to beat ${oppRaceWord(payload.matchup)} openers`}
      actions={
        <Link href={guidePaths.counters(payload.slug)} className={GUIDE_LINK_CLASS}>
          All {oppRaceWord(payload.matchup)} openers
        </Link>
      }
    >
      <CounterLinks counters={payload.counters} matchupSlug={payload.slug} />
    </Section>
  );
}

function PublishedMatchup({ payload }: { payload: GuideMatchupPayload }) {
  return (
    <>
      <div className="space-y-3">
        <PageHeader
          eyebrow="Build order guides"
          title={`${payload.matchup} build orders`}
          description={`What's winning in ${payload.matchup} on the ladder, from real games ${eraLabel(payload.era, payload.patch)}.`}
        />
        <GuideCopyText lines={buildMatchupIntro(payload)} />
        {payload.computedAt ? (
          <p className="text-caption text-text-dim">Stats updated {fmtGuideDate(payload.computedAt)}</p>
        ) : null}
      </div>
      <OpenersSection payload={payload} />
      <CountersSection payload={payload} />
    </>
  );
}

export function MatchupGuide({ payload }: { payload: GuideMatchupPayload }) {
  const crumbs = matchupCrumbs(payload);
  return (
    <div className="space-y-10">
      <GuideJsonLd items={[breadcrumbJsonLd(crumbs)]} />
      <GuideBreadcrumbs crumbs={crumbs} />
      {payload.published ? (
        <PublishedMatchup payload={payload} />
      ) : (
        <GuideNotEnoughGames
          eyebrow="Build order guides"
          title={`${payload.matchup} build orders`}
          description={`Real ${payload.matchup} ladder win rates by opener, once enough games are in.`}
          backHref={guidePaths.hub()}
          backLabel="All matchups"
        />
      )}
      <GuideVideoRow title={`Latest ${payload.matchup} videos`} videos={payload.videos} id="videos" />
    </div>
  );
}
