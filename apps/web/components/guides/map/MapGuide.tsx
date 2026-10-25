import Link from "next/link";
import type { ReactNode } from "react";
import { GuideSectionNav } from "../GuideSectionNav";
import { GuideStatsLegend } from "../GuideStatsLegend";
import { MapHeroEnlarge } from "./MapHeroEnlarge";
import { MapRaceMatrix } from "./MapRaceMatrix";
import { OtherMaps } from "./OtherMaps";
import { GUIDE_MATCHUPS } from "@/lib/guides/slugs";
import { PageHeader } from "@/components/ui/PageHeader";
import { GuideSection as Section } from "@/components/guides/GuideSection";
import { GuideBreadcrumbs } from "@/components/guides/GuideBreadcrumbs";
import { GuideCopyText } from "@/components/guides/GuideCopyText";
import { GuideJsonLd } from "@/components/guides/GuideJsonLd";
import { GuideNotEnoughGames } from "@/components/guides/GuideStates";
import { WinRateCell } from "@/components/guides/WinRateCell";
import { canLinkGuidePath, guidePaths } from "@/components/guides/guideMetadata";
import { breadcrumbJsonLd, type GuideCrumb } from "@/components/guides/guideSeo";
import {
  GUIDE_LINK_CLASS,
  GUIDE_PANEL_CLASS,
  eraLabel,
} from "@/components/guides/guideUi";
import { fmtCount, fmtGuideDate } from "@/lib/guides/format";
import { buildMapIntro } from "@/lib/guides/guideCopy";
import type { GuideIndexMap, GuideMapMatchupRow, GuideMapOpener, GuideMapPayload, GuideMapPublished } from "@/lib/guides/types";

/**
 * Body of /guides/maps/[map]: the map artwork, the win rate of each
 * matchup on it (from the first-named race's side) and the best openers
 * per matchup, each linking its build guide when that guide is published
 * (a map opener only needs the cell floor on this map; a build page needs
 * the page floor over every map).
 */

export function mapCrumbs(payload: Pick<GuideMapPayload, "map" | "mapSlug">): GuideCrumb[] {
  return [
    { name: "Guides", path: guidePaths.hub() },
    { name: "Maps", path: guidePaths.maps() },
    { name: payload.map, path: guidePaths.map(payload.mapSlug) },
  ];
}

function OpenerName({
  matchupSlug,
  opener,
  publishedPaths,
}: {
  matchupSlug: string;
  opener: GuideMapOpener;
  publishedPaths: ReadonlySet<string> | null;
}) {
  const path = guidePaths.build(matchupSlug, opener.buildSlug);
  if (!canLinkGuidePath(publishedPaths, path)) {
    return <span className="break-words text-text">{opener.name}</span>;
  }
  return (
    <Link href={path} className={`${GUIDE_LINK_CLASS} break-words`}>
      {opener.name}
    </Link>
  );
}

function BestOpeners({
  rows,
  publishedPaths,
}: {
  rows: ReadonlyArray<GuideMapMatchupRow>;
  publishedPaths: ReadonlySet<string> | null;
}) {
  const withOpeners = GUIDE_MATCHUPS.flatMap((matchup) => rows.filter((row) => row.matchup === matchup && row.openers.length > 0));
  if (withOpeners.length === 0) return null;
  return (
    <Section id="best-openers" title="Best openers per matchup">
      <ul className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {withOpeners.map((row) => (
          <li key={row.matchup} className={`${GUIDE_PANEL_CLASS} min-w-0 p-4`}>
            <h3 className="mb-2 font-display text-h4 font-bold text-text">{row.matchup}</h3>
            <ol className="divide-y divide-border">
              {row.openers.map((opener) => (
                <li key={opener.buildKey} className="flex items-center justify-between gap-3 py-2 text-caption">
                  <span className="min-w-0">
                    <OpenerName matchupSlug={row.slug} opener={opener} publishedPaths={publishedPaths} />
                    <span className="block text-micro text-text-dim">{fmtCount(opener.games)} games</span>
                  </span>
                  <WinRateCell winRate={opener.winRate} ci={opener.ci} showWhisker={false} />
                </li>
              ))}
            </ol>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function PublishedMap({
  payload,
  publishedPaths,
  mapIndex,
  personalSlot,
}: {
  payload: GuideMapPublished;
  publishedPaths: ReadonlySet<string> | null;
  mapIndex: readonly GuideIndexMap[] | null;
  personalSlot?: ReactNode;
}) {
  return (
    <>
      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,20rem)] md:items-start">
        <div className="space-y-3">
          <PageHeader eyebrow="Map guide" title={payload.map} />
          <p className="font-display text-h4 font-bold text-text">
            {fmtCount(payload.games)} ladder games {eraLabel(payload.era, payload.patch)}
          </p>
          {payload.computedAt ? (
            <p className="text-caption text-text-dim">Stats updated {fmtGuideDate(payload.computedAt)}</p>
          ) : null}
          <GuideCopyText lines={buildMapIntro(payload)} />
        </div>
        <MapHeroEnlarge mapName={payload.map} />
      </div>
      <GuideSectionNav items={[
        { id: "matchups", label: "Matchups" },
        ...(personalSlot ? [{ id: "your-map", label: "You on this map" }] : []),
        ...(payload.matchups.some((row) => row.openers.length) ? [{ id: "best-openers", label: "Best openers" }] : []),
        ...(mapIndex?.some((map) => map.slug !== payload.mapSlug) ? [{ id: "other-maps", label: "Other maps" }] : []),
      ]}>
        <Section id="matchups" title="Win rate by matchup" description="Each cell is the row race's win rate against the column race on this map.">
          <GuideStatsLegend computedAt={payload.computedAt} />
          <div className="mt-4"><MapRaceMatrix rows={payload.matchups} /></div>
        </Section>
        {personalSlot}
        <BestOpeners rows={payload.matchups} publishedPaths={publishedPaths} />
        <OtherMaps current={payload.mapSlug} maps={mapIndex} />
      </GuideSectionNav>
    </>
  );
}

/** `publishedPaths`: published guide page paths (null = unknown) gating the opener links. */
export function MapGuide({
  payload,
  publishedPaths = null,
  mapIndex = null,
  personalSlot,
}: {
  payload: GuideMapPayload;
  publishedPaths?: ReadonlySet<string> | null;
  mapIndex?: readonly GuideIndexMap[] | null;
  personalSlot?: ReactNode;
}) {
  const crumbs = mapCrumbs(payload);
  return (
    <article className="space-y-10">
      <GuideJsonLd items={[breadcrumbJsonLd(crumbs)]} />
      <GuideBreadcrumbs crumbs={crumbs} />
      {payload.published ? (
        <PublishedMap payload={payload} publishedPaths={publishedPaths} mapIndex={mapIndex} personalSlot={personalSlot} />
      ) : (
        <><GuideNotEnoughGames
          eyebrow="Map guide"
          title={payload.map}
          backHref={guidePaths.maps()}
          backLabel="All map guides"
        />{personalSlot}</>
      )}
    </article>
  );
}
