/**
 * Titles, descriptions and paths for every /guides page.
 *
 * Each title carries a real number from the payload (win rate, opener
 * count, games) plus the patch, so every page's title is unique and
 * specific; unpublished payloads carry no numbers and are noindex.
 * Descriptions state n and the stats date. Nothing here invents a
 * value: every number is formatted straight from the payload.
 */
import type { Metadata } from "next";
import { fmtCount, fmtGuideDate, fmtPct } from "@/lib/guides/format";
import type {
  GuideBand,
  GuideBuildPayload,
  GuideCounterPayload,
  GuideEra,
  GuideIndexPayload,
  GuideMapPayload,
  GuideMatchupPayload,
} from "@/lib/guides/types";
import { GUIDE_SITE_NAME, guideMetadata } from "@/components/guides/guideSeo";
import { eraLabel, myRaceWord, oppRaceWord } from "@/components/guides/guideUi";

const SUFFIX = ` | ${GUIDE_SITE_NAME}`;

/** Site paths of the guide pages. */
export const guidePaths = {
  hub: (): string => "/guides",
  maps: (): string => "/guides/maps",
  matchup: (matchupSlug: string): string => `/guides/${matchupSlug}`,
  counters: (matchupSlug: string): string => `/guides/${matchupSlug}/counter`,
  build: (matchupSlug: string, buildSlug: string): string => `/guides/${matchupSlug}/${buildSlug}`,
  counter: (matchupSlug: string, strategySlug: string): string =>
    `/guides/${matchupSlug}/counter/${strategySlug}`,
  map: (mapSlug: string): string => `/guides/maps/${mapSlug}`,
};

function patchTag(patch: string, era: GuideEra = "after"): string {
  return era === "before" ? `(before Patch ${patch})` : `(Patch ${patch})`;
}

function updated(computedAt: string | null): string {
  return computedAt ? ` Stats updated ${fmtGuideDate(computedAt)}.` : "";
}

/* ------------------------------------------------------------------ */
/* Build                                                               */
/* ------------------------------------------------------------------ */

/**
 * Page headline (title without the site suffix), also the Article headline.
 *
 * Example: "Stargate into Glaives PvZ — 56.6% win rate at Diamond (Patch 5.0.16)".
 */
export function buildHeadline(data: GuideBuildPayload): string {
  const base = `${data.name} ${data.matchup}`;
  if (!data.published) return `${base} build order guide ${patchTag(data.patch)}`;
  const { headline } = data;
  if (headline && headline.scope === "league" && headline.label) {
    return `${base} — ${fmtPct(headline.winRate)} win rate at ${headline.label} ${patchTag(data.patch)}`;
  }
  const winRate = headline ? headline.winRate : data.overall.winRate;
  return `${base} — ${fmtPct(winRate)} ladder win rate ${patchTag(data.patch)}`;
}

/** Search description for a build guide. */
export function buildDescription(data: GuideBuildPayload): string {
  if (!data.published) {
    return `${data.name} (${data.matchup}): ${data.description} Not enough ladder games yet for published stats.`;
  }
  const { overall } = data;
  return `${data.name} (${data.matchup}) wins ${fmtPct(overall.winRate)} of decided games across ${fmtCount(overall.games)} ladder games from ${fmtCount(overall.users)} players ${eraLabel(data.era, data.patch)}. Key timings, army and matchups from real replays.${updated(data.computedAt)}`;
}

export function buildMetadata(data: GuideBuildPayload): Metadata {
  return guideMetadata({
    title: `${buildHeadline(data)}${SUFFIX}`,
    description: buildDescription(data),
    canonical: guidePaths.build(data.matchupSlug, data.buildSlug),
    noindex: !data.published,
    ogType: data.published ? "article" : "website",
  });
}

/* ------------------------------------------------------------------ */
/* Counter                                                             */
/* ------------------------------------------------------------------ */

/**
 * Race words come from the matchup ("PvZ" → Protoss / Zerg), never from
 * the payload's free-form race labels, so the copy reads the same
 * whatever form the API labels races in.
 */
export function counterHeadline(data: GuideCounterPayload): string {
  return `How to beat ${data.name} as ${myRaceWord(data.matchup)} — best openers by win rate ${patchTag(data.patch)}`;
}

export function counterMetadata(data: GuideCounterPayload): Metadata {
  const mine = myRaceWord(data.matchup);
  const description = data.published
    ? `${mine} players win ${fmtPct(data.overall.winRate)} of decided games against ${data.name} across ${fmtCount(data.overall.games)} ${data.matchup} ladder games; ${fmtCount(data.openers.length)} openers ranked by the low end of their likely win rate.${updated(data.computedAt)}`
    : `How to beat ${data.name} (${oppRaceWord(data.matchup)}) as ${mine}: ${data.description} Not enough ladder games yet for published stats.`;
  return guideMetadata({
    title: `${counterHeadline(data)}${SUFFIX}`,
    description,
    canonical: guidePaths.counter(data.matchupSlug, data.strategySlug),
    noindex: !data.published,
  });
}

/* ------------------------------------------------------------------ */
/* Matchup + counter list                                              */
/* ------------------------------------------------------------------ */

function bandPhrase(band: GuideBand | null): string {
  if (!band) return "";
  return band.type === "mmr" ? ` vs ${band.label} MMR opponents` : ` vs ${band.label} opponents`;
}

export function matchupMetadata(data: GuideMatchupPayload): Metadata {
  const canonical = guidePaths.matchup(data.slug);
  const tag = patchTag(data.patch, data.era);
  if (!data.published || data.games === null || data.users === null) {
    return guideMetadata({
      title: `${data.matchup} build orders ${tag}${SUFFIX}`,
      description: `${data.matchup} build order guides ranked by real ladder win rate. Not enough games yet for published stats.`,
      canonical,
      noindex: true,
    });
  }
  const count = data.openers.length;
  return guideMetadata({
    title: `${data.matchup} build orders${bandPhrase(data.band)} — ${fmtCount(count)} openers ranked by win rate ${tag}${SUFFIX}`,
    description: `${fmtCount(count)} ${data.matchup} openers ranked by real ladder win rate across ${fmtCount(data.games)} games from ${fmtCount(data.users)} players ${eraLabel(data.era, data.patch)}.${updated(data.computedAt)}`,
    canonical,
  });
}

export function counterListMetadata(data: GuideMatchupPayload): Metadata {
  const published = data.counters.filter((counter) => counter.published).length;
  const opp = oppRaceWord(data.matchup);
  const mine = myRaceWord(data.matchup);
  return guideMetadata({
    title: `How to beat ${opp} openers as ${mine} (${data.matchup}) — ${fmtCount(published)} counter guides ${patchTag(data.patch)}${SUFFIX}`,
    description: `Every ${opp} opener we track in ${data.matchup}, with the ${mine} openers that beat it most reliably on ladder.${updated(data.computedAt)}`,
    canonical: guidePaths.counters(data.slug),
    noindex: published === 0,
  });
}

/* ------------------------------------------------------------------ */
/* Hub + maps                                                          */
/* ------------------------------------------------------------------ */

/**
 * Published-only totals for the hub copy: an unpublished matchup's game
 * count is below the page floor and never shown, so it is never summed.
 */
export function hubTotals(data: GuideIndexPayload): { builds: number; matchups: number; games: number } {
  let builds = 0;
  let matchups = 0;
  let games = 0;
  for (const row of data.matchups) {
    if (!row.published) continue;
    builds += row.publishedBuilds;
    matchups += 1;
    games += row.games ?? 0;
  }
  return { builds, matchups, games };
}

export function hubMetadata(data: GuideIndexPayload): Metadata {
  const totals = hubTotals(data);
  const tag = patchTag(data.patch, data.era);
  const title =
    totals.builds > 0
      ? `StarCraft II build order guides — ${fmtCount(totals.builds)} openers ranked by real ladder win rate ${tag}${SUFFIX}`
      : `StarCraft II build order guides ${tag}${SUFFIX}`;
  const description =
    totals.builds > 0
      ? `What's winning on the SC2 ladder: ${fmtCount(totals.builds)} build orders across ${fmtCount(totals.matchups)} matchups, ranked by win rate from ${fmtCount(totals.games)} real ladder games.${updated(data.computedAt)}`
      : "StarCraft II build order guides ranked by real ladder win rate, plus build-order videos from the channel.";
  return guideMetadata({
    title,
    description,
    canonical: guidePaths.hub(),
    noindex: totals.builds === 0 && data.videos.length === 0,
  });
}

export function mapsListMetadata(data: GuideIndexPayload): Metadata {
  const count = data.maps.length;
  return guideMetadata({
    title: `SC2 ladder map guides — ${fmtCount(count)} maps with openers ranked by win rate ${patchTag(data.patch, data.era)}${SUFFIX}`,
    description: `Win rates by matchup and the best openers on ${fmtCount(count)} ladder maps, from real ladder games.${updated(data.computedAt)}`,
    canonical: guidePaths.maps(),
    noindex: count === 0,
  });
}

export function mapMetadata(data: GuideMapPayload): Metadata {
  const canonical = guidePaths.map(data.mapSlug);
  const tag = patchTag(data.patch, data.era);
  if (!data.published) {
    return guideMetadata({
      title: `${data.map} map guide ${tag}${SUFFIX}`,
      description: `${data.map} ladder map guide. Not enough games yet for published stats.`,
      canonical,
      noindex: true,
    });
  }
  return guideMetadata({
    title: `${data.map} — best openers by matchup from ${fmtCount(data.games)} ladder games ${tag}${SUFFIX}`,
    description: `Matchup win rates and the best openers on ${data.map} across ${fmtCount(data.games)} ladder games ${eraLabel(data.era, data.patch)}.${updated(data.computedAt)}`,
    canonical,
  });
}
