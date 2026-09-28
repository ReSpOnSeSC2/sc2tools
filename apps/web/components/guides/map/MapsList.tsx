import Link from "next/link";
import { MapArtwork } from "@/components/maps/MapArtwork";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { GuideBreadcrumbs } from "@/components/guides/GuideBreadcrumbs";
import { GuideJsonLd } from "@/components/guides/GuideJsonLd";
import { guidePaths } from "@/components/guides/guideMetadata";
import { breadcrumbJsonLd, type GuideCrumb } from "@/components/guides/guideSeo";
import { GUIDE_PANEL_CLASS, eraLabel } from "@/components/guides/guideUi";
import { fmtCount, fmtGuideDate } from "@/lib/guides/format";
import type { GuideIndexPayload } from "@/lib/guides/types";

/**
 * Body of /guides/maps: the published map guides (from the hub payload),
 * busiest first, each with its game count.
 */

const MAPS_CRUMBS: GuideCrumb[] = [
  { name: "Guides", path: guidePaths.hub() },
  { name: "Maps", path: guidePaths.maps() },
];

export function MapsList({ payload }: { payload: GuideIndexPayload }) {
  return (
    <div className="space-y-8">
      <GuideJsonLd items={[breadcrumbJsonLd(MAPS_CRUMBS)]} />
      <GuideBreadcrumbs crumbs={MAPS_CRUMBS} />
      <div className="space-y-2">
        <PageHeader
          eyebrow="Map guides"
          title="SC2 ladder map guides"
          description={`Matchup win rates and the openers that do best on each ladder map, ${eraLabel(payload.era, payload.patch)}.`}
        />
        {payload.computedAt ? (
          <p className="text-caption text-text-dim">Stats updated {fmtGuideDate(payload.computedAt)}</p>
        ) : null}
      </div>
      {payload.maps.length > 0 ? (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {payload.maps.map((map) => (
            <li key={map.slug} className="min-w-0">
              <Link
                href={guidePaths.map(map.slug)}
                className={`${GUIDE_PANEL_CLASS} flex items-center gap-3 p-3 hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg`}
              >
                <MapArtwork mapName={map.map} size="md" />
                <span className="min-w-0">
                  <span className="block break-words font-display text-h4 font-bold text-text">{map.map}</span>
                  <span className="block text-caption tabular-nums text-text-dim">{fmtCount(map.games)} games</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <div className={GUIDE_PANEL_CLASS}>
          <EmptyStatePanel size="md" title="No map guides yet" description="Map guides appear once enough ladder games are in." />
        </div>
      )}
    </div>
  );
}
