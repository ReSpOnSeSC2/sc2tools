import Link from "next/link";
import { MapArtwork } from "@/components/maps/MapArtwork";
import { PageHeader } from "@/components/ui/PageHeader";
import { Section } from "@/components/ui/Section";
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
  GUIDE_TABLE_CLASS,
  GUIDE_TABLE_WRAP_CLASS,
  GUIDE_TD_CLASS,
  GUIDE_TD_NUM_CLASS,
  GUIDE_TH_CLASS,
  GUIDE_TH_NUM_CLASS,
  GUIDE_THEAD_CLASS,
  eraLabel,
  myRaceWord,
} from "@/components/guides/guideUi";
import { fmtCount, fmtGuideDate } from "@/lib/guides/format";
import { buildMapIntro } from "@/lib/guides/guideCopy";
import type { GuideMapMatchupRow, GuideMapOpener, GuideMapPayload, GuideMapPublished } from "@/lib/guides/types";

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

function MatchupTable({ rows }: { rows: ReadonlyArray<GuideMapMatchupRow> }) {
  const sorted = [...rows].sort((a, b) => b.games - a.games);
  return (
    <div className={GUIDE_TABLE_WRAP_CLASS}>
      <table className={GUIDE_TABLE_CLASS}>
        <caption className="sr-only">Win rate by matchup on this map</caption>
        <thead className={GUIDE_THEAD_CLASS}>
          <tr>
            <th scope="col" className={GUIDE_TH_CLASS}>Matchup</th>
            <th scope="col" className={GUIDE_TH_NUM_CLASS}>Win rate</th>
            <th scope="col" className={GUIDE_TH_NUM_CLASS}>Games</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {sorted.map((row) => (
            <tr key={row.matchup}>
              <th scope="row" className={`${GUIDE_TD_CLASS} text-left font-medium`}>
                <Link href={guidePaths.matchup(row.slug)} className={GUIDE_LINK_CLASS}>
                  {row.matchup}
                </Link>
                <span className="block text-micro font-normal text-text-dim">
                  {myRaceWord(row.matchup)}&apos;s side
                </span>
              </th>
              <td className={GUIDE_TD_NUM_CLASS}>
                <WinRateCell winRate={row.winRate} ci={row.ci} />
              </td>
              <td className={GUIDE_TD_NUM_CLASS}>{fmtCount(row.games)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
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
  const withOpeners = rows.filter((row) => row.openers.length > 0);
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
}: {
  payload: GuideMapPublished;
  publishedPaths: ReadonlySet<string> | null;
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
        <div className="relative aspect-video w-full overflow-hidden rounded-xl border-2 border-line shadow-hard">
          <MapArtwork mapName={payload.map} size="card" eager alt={`${payload.map} map`} />
        </div>
      </div>
      <Section id="matchups" title="Win rate by matchup" description="Share of decided games won by the first-named race in each matchup.">
        <MatchupTable rows={payload.matchups} />
      </Section>
      <BestOpeners rows={payload.matchups} publishedPaths={publishedPaths} />
    </>
  );
}

/** `publishedPaths`: published guide page paths (null = unknown) gating the opener links. */
export function MapGuide({
  payload,
  publishedPaths = null,
}: {
  payload: GuideMapPayload;
  publishedPaths?: ReadonlySet<string> | null;
}) {
  const crumbs = mapCrumbs(payload);
  return (
    <article className="space-y-10">
      <GuideJsonLd items={[breadcrumbJsonLd(crumbs)]} />
      <GuideBreadcrumbs crumbs={crumbs} />
      {payload.published ? (
        <PublishedMap payload={payload} publishedPaths={publishedPaths} />
      ) : (
        <GuideNotEnoughGames
          eyebrow="Map guide"
          title={payload.map}
          backHref={guidePaths.maps()}
          backLabel="All map guides"
        />
      )}
    </article>
  );
}
