import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { GuideBreadcrumbs } from "@/components/guides/GuideBreadcrumbs";
import { GuideJsonLd } from "@/components/guides/GuideJsonLd";
import { CounterLinks } from "@/components/guides/matchup/CounterLinks";
import { guidePaths } from "@/components/guides/guideMetadata";
import { breadcrumbJsonLd, type GuideCrumb } from "@/components/guides/guideSeo";
import { GUIDE_PANEL_CLASS, myRaceWord, oppRaceWord } from "@/components/guides/guideUi";
import { fmtGuideDate } from "@/lib/guides/format";
import type { GuideMatchupPayload } from "@/lib/guides/types";

/**
 * Body of /guides/[matchup]/counter — every opponent opener with a
 * counter page in this matchup (from the matchup payload's `counters`),
 * published ones first with their game counts.
 */

export function counterListCrumbs(payload: Pick<GuideMatchupPayload, "matchup" | "slug">): GuideCrumb[] {
  return [
    { name: "Guides", path: guidePaths.hub() },
    { name: payload.matchup, path: guidePaths.matchup(payload.slug) },
    { name: "Counters", path: guidePaths.counters(payload.slug) },
  ];
}

export function CounterList({ payload }: { payload: GuideMatchupPayload }) {
  const crumbs = counterListCrumbs(payload);
  const opp = oppRaceWord(payload.matchup);
  return (
    <div className="space-y-8">
      <GuideJsonLd items={[breadcrumbJsonLd(crumbs)]} />
      <GuideBreadcrumbs crumbs={crumbs} />
      <div className="space-y-2">
        <PageHeader
          eyebrow={`${payload.matchup} counter guides`}
          title={`How to beat ${opp} openers`}
          description={`Pick the ${opp} opener you keep losing to and see which ${myRaceWord(payload.matchup)} openers beat it most reliably on ladder.`}
        />
        {payload.computedAt ? (
          <p className="text-caption text-text-dim">Stats updated {fmtGuideDate(payload.computedAt)}</p>
        ) : null}
      </div>
      {payload.counters.length > 0 ? (
        <CounterLinks counters={payload.counters} matchupSlug={payload.slug} includeUnpublished />
      ) : (
        <div className={GUIDE_PANEL_CLASS}>
          <EmptyStatePanel size="md" title="No counter guides yet" description="Check back once more games are in." />
        </div>
      )}
    </div>
  );
}
