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
import { fmtCountNoun, fmtGuideDate, fmtPct } from "@/lib/guides/format";
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

/**
 * Whether a page may link another guide page: only when the target is in
 * the published set (`fetchPublishedGuidePaths`), so an indexed page never
 * sends readers or crawlers to a noindex "Not enough games yet" page. An
 * unknown set (null: the list couldn't be read) keeps the link.
 *
 * Example: `canLinkGuidePath(new Set(["/guides/maps/rainfall"]), "/guides/maps/washout")` → false.
 */
export function canLinkGuidePath(published: ReadonlySet<string> | null, path: string): boolean {
  return published === null || published.has(path);
}

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
 * The league band is the OPPONENT's league (the band the build faces
 * most), so it reads "vs Diamond", never "at Diamond".
 *
 * Example: "Stargate into Glaives PvZ — 56.6% win rate vs Diamond (Patch 5.0.16)".
 */
export function buildHeadline(data: GuideBuildPayload): string {
  const base = `${data.name} ${data.matchup}`;
  if (!data.published) return `${base} build order guide ${patchTag(data.patch)}`;
  const { headline } = data;
  if (headline && headline.scope === "league" && headline.label) {
    return `${base} — ${fmtPct(headline.winRate)} win rate vs ${headline.label} ${patchTag(data.patch)}`;
  }
  const winRate = headline ? headline.winRate : data.overall.winRate;
  return `${base} — ${fmtPct(winRate)} ladder win rate ${patchTag(data.patch)}`;
}

/**
 * Search description for a build guide.
 *
 * When the title quotes the league-band win rate ("46.3% win rate vs
 * Master"), the description leads with that same number before the
 * overall one, so a search result never shows two different win rates
 * without saying which is which.
 *
 * Example: "Robo First (PvT) wins 46.3% vs Master opponents and 55.0% of
 * decided games overall, across 109 ladder games from 5 players since
 * patch 5.0.16. …"
 */
export function buildDescription(data: GuideBuildPayload): string {
  if (!data.published) {
    return `${data.name} (${data.matchup}): ${data.description} Not enough ladder games yet for published stats.`;
  }
  const { overall, headline } = data;
  const sample = `${fmtCountNoun(overall.games, "ladder game")} from ${fmtCountNoun(overall.users, "player")} ${eraLabel(data.era, data.patch)}`;
  const record =
    headline && headline.scope === "league" && headline.label
      ? `wins ${fmtPct(headline.winRate)} vs ${headline.label} opponents and ${fmtPct(overall.winRate)} of decided games overall, across ${sample}`
      : `wins ${fmtPct(overall.winRate)} of decided games across ${sample}`;
  return `${data.name} (${data.matchup}) ${record}. Key timings, army and matchups from real replays.${updated(data.computedAt)}`;
}

export function buildMetadata(data: GuideBuildPayload): Metadata {
  return guideMetadata({
    title: `${buildHeadline(data)}${SUFFIX}`,
    description: buildDescription(data),
    canonical: guidePaths.build(data.matchupSlug, data.buildSlug),
    noindex: !data.published,
    ogType: data.published ? "article" : "website",
    routeOgImage: true,
  });
}

/* ------------------------------------------------------------------ */
/* Counter                                                             */
/* ------------------------------------------------------------------ */

/**
 * Counter page headline. A published page carries its real overall win
 * rate and n (the page floor was met on `overall`), which also keeps two
 * strategies with the same display name from sharing a title; an
 * unpublished page carries no numbers. Race words come from the matchup
 * ("PvZ" → Protoss / Zerg), never from the payload's free-form race
 * labels, so the copy reads the same whatever form the API labels races in.
 *
 * Example: "How to beat 8 Pool as Protoss — 63.4% win rate over 236 ladder
 * games (Patch 5.0.16)"; unpublished → "How to beat Lurker Contain as
 * Protoss — best openers by win rate (Patch 5.0.16)".
 */
export function counterHeadline(data: GuideCounterPayload): string {
  const base = `How to beat ${data.name} as ${myRaceWord(data.matchup)}`;
  if (!data.published) return `${base} — best openers by win rate ${patchTag(data.patch)}`;
  const { overall } = data;
  const record = `${fmtPct(overall.winRate)} win rate over ${fmtCountNoun(overall.games, "ladder game")}`;
  return `${base} — ${record} ${patchTag(data.patch)}`;
}

export function counterMetadata(data: GuideCounterPayload): Metadata {
  const mine = myRaceWord(data.matchup);
  const description = data.published
    ? `${mine} players win ${fmtPct(data.overall.winRate)} of decided games against ${data.name} across ${fmtCountNoun(data.overall.games, `${data.matchup} ladder game`)}; ${fmtCountNoun(data.openers.length, "opener")} ranked by the low end of their likely win rate.${updated(data.computedAt)}`
    : `How to beat ${data.name} (${oppRaceWord(data.matchup)}) as ${mine}: ${data.description} Not enough ladder games yet for published stats.`;
  return guideMetadata({
    title: `${counterHeadline(data)}${SUFFIX}`,
    description,
    canonical: guidePaths.counter(data.matchupSlug, data.strategySlug),
    noindex: !data.published,
    routeOgImage: true,
  });
}

/* ------------------------------------------------------------------ */
/* Matchup + counter list                                              */
/* ------------------------------------------------------------------ */

function bandPhrase(band: GuideBand | null): string {
  if (!band) return "";
  return band.type === "mmr" ? ` vs ${band.label} MMR opponents` : ` vs ${band.label} opponents`;
}

/**
 * Openers the matchup page ranks: every row of its numbered table
 * (published or still below the page floor), so the title, the
 * description and the social card all state the count the page shows.
 *
 * Example: 4 published + 2 unpublished rows → 6.
 */
export function rankedOpenerCount(data: GuideMatchupPayload): number {
  return data.openers.length;
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
      routeOgImage: true,
    });
  }
  const count = rankedOpenerCount(data);
  return guideMetadata({
    title: `${data.matchup} build orders${bandPhrase(data.band)} — ${fmtCountNoun(count, "opener")} ranked by win rate ${tag}${SUFFIX}`,
    description: `${fmtCountNoun(count, `${data.matchup} opener`)} ranked by real ladder win rate across ${fmtCountNoun(data.games, "game")} from ${fmtCountNoun(data.users, "player")} ${eraLabel(data.era, data.patch)}.${updated(data.computedAt)}`,
    canonical,
    routeOgImage: true,
  });
}

/**
 * Games behind the published counter guides, summed from the floored
 * per-row counts the list itself prints. Each game has one opponent
 * strategy, so no game is counted twice.
 *
 * Example: counters with 236 and 118 published games → 354.
 */
export function publishedCounterGames(data: GuideMatchupPayload): number {
  return data.counters.reduce(
    (sum, counter) => sum + (counter.published && counter.games !== null ? counter.games : 0),
    0,
  );
}

export function counterListMetadata(data: GuideMatchupPayload): Metadata {
  const published = data.counters.filter((counter) => counter.published).length;
  const opp = oppRaceWord(data.matchup);
  const mine = myRaceWord(data.matchup);
  const games = publishedCounterGames(data);
  const across = games > 0 ? ` across ${fmtCountNoun(games, `${data.matchup} ladder game`)}` : "";
  return guideMetadata({
    title: `How to beat ${opp} openers as ${mine} (${data.matchup}) — ${fmtCountNoun(published, "counter guide")} ${patchTag(data.patch)}${SUFFIX}`,
    description: `Every ${opp} opener we track in ${data.matchup}, with the ${mine} openers that beat it most reliably on ladder${across}.${updated(data.computedAt)}`,
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

/**
 * The hub title's real number: published openers, else (videos only, as
 * at launch) the build-order videos the hub shows, else none (noindex).
 *
 * Example: `hubTitleCount(0, 4)` → " — 4 build-order videos".
 */
function hubTitleCount(builds: number, videos: number): string {
  if (builds > 0) return ` — ${fmtCountNoun(builds, "opener")} ranked by real ladder win rate`;
  if (videos > 0) return ` — ${fmtCountNoun(videos, "build-order video")}`;
  return "";
}

export function hubMetadata(data: GuideIndexPayload): Metadata {
  const totals = hubTotals(data);
  const tag = patchTag(data.patch, data.era);
  const title = `StarCraft II build order guides${hubTitleCount(totals.builds, data.videos.length)} ${tag}${SUFFIX}`;
  const description =
    totals.builds > 0
      ? `What's winning on the SC2 ladder: ${fmtCountNoun(totals.builds, "build order")} across ${fmtCountNoun(totals.matchups, "matchup")}, ranked by win rate from ${fmtCountNoun(totals.games, "real ladder game")}.${updated(data.computedAt)}`
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
  // Each game is played on one map, so the per-map counts the list prints sum without overlap.
  const games = data.maps.reduce((sum, map) => sum + map.games, 0);
  const from = games > 0 ? fmtCountNoun(games, "real ladder game") : "real ladder games";
  return guideMetadata({
    title: `SC2 ladder map guides — ${fmtCountNoun(count, "map")} with openers ranked by win rate ${patchTag(data.patch, data.era)}${SUFFIX}`,
    description: `Win rates by matchup and the best openers on ${fmtCountNoun(count, "ladder map")}, from ${from}.${updated(data.computedAt)}`,
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
    title: `${data.map} — best openers by matchup from ${fmtCountNoun(data.games, "ladder game")} ${tag}${SUFFIX}`,
    description: `Matchup win rates and the best openers on ${data.map} across ${fmtCountNoun(data.games, "ladder game")} ${eraLabel(data.era, data.patch)}.${updated(data.computedAt)}`,
    canonical,
  });
}
