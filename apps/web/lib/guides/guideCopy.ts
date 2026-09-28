/**
 * guideCopy — deterministic prose for the guide pages.
 *
 * A pure template engine in the style of `lib/grudge.ts`: no LLM, no
 * network, no randomness. Each builder turns a guide payload into a few
 * short sentences; a template variant is picked by
 * `fnv1a(<page slug> + "|" + <section>)`, so a page always renders the
 * same words (stable HTML for crawlers) while different guides read
 * differently.
 *
 * ALL DATA IS REAL: every number in a sentence is a value from the
 * payload (formatted, never computed), and each returned line lists
 * those raw values in `numbers` so tests can trace every rendered digit
 * back to its input. Sentences whose inputs are missing are skipped, and
 * unpublished payloads produce `[]` (callers render "Not enough games
 * yet"). Samples under twice the page floor get a plain small-sample
 * caveat.
 */
import { fmtClock, fmtCi, fmtCount, fmtCountNoun, fmtPct, trendDirection } from "@/lib/guides/format";
import type {
  GuideBuildPayload,
  GuideBuildPublished,
  GuideCell,
  GuideCounterPayload,
  GuideEra,
  GuideMapPayload,
  GuideMatchupPayload,
  GuideMilestone,
  GuideMilestoneSplit,
} from "@/lib/guides/types";

/** One sentence plus the raw payload numbers it renders. */
export interface GuideCopyLine {
  id: string;
  text: string;
  numbers: number[];
}

/** Mirror of the API's GUIDE_PAGE_MIN_GAMES (apps/api/src/config/guides.js). */
export const GUIDE_PAGE_MIN_GAMES = 100;
/** Below THIN_SAMPLE_FACTOR × the page floor a page reads as directional. */
const THIN_SAMPLE_FACTOR = 2;
export const GUIDE_THIN_SAMPLE_GAMES = GUIDE_PAGE_MIN_GAMES * THIN_SAMPLE_FACTOR;
/** A 50% win rate: a CI entirely above/below it is a clear verdict. */
const COIN_FLIP = 0.5;
const PERCENT_SCALE = 100;
const PP_DECIMALS = 1;
const MY_RACE_INDEX = 0;
const OPP_RACE_INDEX = 2;
const RACE_WORDS: Readonly<Record<string, string>> = {
  P: "Protoss",
  T: "Terran",
  Z: "Zerg",
};
/** 32-bit FNV-1a offset basis and prime. */
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

type Variant<F> = (facts: F) => string;

// ---------------------------------------------------------------------------
// Deterministic selection (self-contained FNV-1a, copied from lib/grudge.ts
// so this module stays dependency-light).
// ---------------------------------------------------------------------------

function fnv1a(text: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

function pickVariant<F>(
  variants: ReadonlyArray<Variant<F>>,
  seed: string,
  section: string,
): Variant<F> {
  return variants[fnv1a(`${seed}|${section}`) % variants.length];
}

function line(id: string, text: string, numbers: number[]): GuideCopyLine {
  return { id, text, numbers };
}

function raceWord(matchup: string, index: number): string {
  return RACE_WORDS[matchup.charAt(index)] ?? "Players";
}

/**
 * Which games a payload covers. The current era is the patch label AND
 * everything after it ("since"), so the phrase stays true when a later
 * balance patch ships; "before" is every earlier game. Never "on patch".
 *
 * Example: `eraPhrase("after", "5.0.16")` → "since patch 5.0.16".
 */
function eraPhrase(era: GuideEra, patch: string): string {
  return `${era === "before" ? "before" : "since"} patch ${patch}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function isMirror(matchup: string): boolean {
  return matchup.charAt(MY_RACE_INDEX) === matchup.charAt(OPP_RACE_INDEX);
}

/** Highest Wilson lower bound (ties keep the earlier row). */
function bestByCiLow<T extends GuideCell>(rows: ReadonlyArray<T>): T | null {
  let best: T | null = null;
  for (const row of rows) {
    if (!best || row.ci.low > best.ci.low) best = row;
  }
  return best;
}

function thinLine(id: string, games: number): GuideCopyLine | null {
  if (games >= GUIDE_THIN_SAMPLE_GAMES) return null;
  return line(
    id,
    `This is still a small sample (n = ${fmtCount(games)}), so treat it as a directional read.`,
    [games],
  );
}

function rangeVerdict(cell: GuideCell): string {
  if (cell.ci.low > COIN_FLIP) return "it wins more often than it loses";
  if (cell.ci.high < COIN_FLIP) return "it loses more often than it wins";
  return "it is too close to call against a coin flip";
}

function compact(lines: ReadonlyArray<GuideCopyLine | null>): GuideCopyLine[] {
  return lines.filter((entry): entry is GuideCopyLine => entry !== null);
}

// ---------------------------------------------------------------------------
// Build page.
// ---------------------------------------------------------------------------

interface BuildFacts {
  name: string;
  matchup: string;
  /** "since patch 5.0.16" / "before patch 5.0.16". */
  when: string;
  wr: string;
  games: string;
  /** "1 player" / "63 players". */
  users: string;
}

const BUILD_OVERVIEW: ReadonlyArray<Variant<BuildFacts>> = [
  (f) =>
    `${f.name} wins ${f.wr} of decided games across ${f.games} ${f.matchup} ladder games from ${f.users} ${f.when}.`,
  (f) =>
    `Across ${f.games} ${f.matchup} ladder games from ${f.users} ${f.when}, ${f.name} wins ${f.wr} of decided games.`,
  (f) =>
    `${capitalize(f.when)}, ${f.users} logged ${f.games} ${f.matchup} ladder games with ${f.name}, winning ${f.wr} of the decided ones.`,
];

function buildSeed(payload: GuideBuildPayload): string {
  return `${payload.matchupSlug}/${payload.buildSlug}`;
}

function buildOverviewLine(p: GuideBuildPublished): GuideCopyLine {
  const facts: BuildFacts = {
    name: p.name,
    matchup: p.matchup,
    when: eraPhrase(p.era, p.patch),
    wr: fmtPct(p.overall.winRate),
    games: fmtCount(p.overall.games),
    users: fmtCountNoun(p.overall.users, "player"),
  };
  const variant = pickVariant(BUILD_OVERVIEW, buildSeed(p), "overview");
  return line("intro-overview", variant(facts), [
    p.overall.winRate,
    p.overall.games,
    p.overall.users,
  ]);
}

function buildRangeLine(p: GuideBuildPublished): GuideCopyLine {
  const { ci } = p.overall;
  return line(
    "intro-range",
    `The likely range for its true win rate is ${fmtCi(ci)}, so ${rangeVerdict(p.overall)}.`,
    [ci.low, ci.high],
  );
}

function buildPrevalenceLine(p: GuideBuildPublished): GuideCopyLine | null {
  if (p.prevalence === null || p.matchupGames === null) return null;
  return line(
    "intro-prevalence",
    `It appears in ${fmtPct(p.prevalence)} of the ${fmtCount(p.matchupGames)} ${p.matchup} games in the guide sample.`,
    [p.prevalence, p.matchupGames],
  );
}

function buildHeadlineLine(p: GuideBuildPublished): GuideCopyLine | null {
  const headline = p.headline;
  if (!headline || headline.scope !== "league" || !headline.label) return null;
  return line(
    "intro-headline",
    `It is played most against ${headline.label} opponents, where it wins ${fmtPct(headline.winRate)} over ${fmtCount(headline.games)} games.`,
    [headline.winRate, headline.games],
  );
}

function buildTrendLine(p: GuideBuildPublished): GuideCopyLine | null {
  if (p.isNew) {
    return line("intro-new", "This guide is newly published, so there is no weekly trend yet.", []);
  }
  if (!p.trend) return null;
  const delta = p.trend.winRateDelta;
  const direction = trendDirection(delta);
  if (direction === "flat") return null;
  const points = (Math.abs(delta) * PERCENT_SCALE).toFixed(PP_DECIMALS);
  return line(
    "intro-trend",
    `Its win rate is ${direction} ${points} percentage points on the previous weekly snapshot.`,
    [delta],
  );
}

/**
 * Hero copy for a build guide. Unpublished → [].
 *
 * Example: `buildIntro(published)[0].text` → "Stargate into Glaives wins
 * 54.2% of decided games across 1,234 PvZ ladder games from 87 players
 * since patch 5.0.16."
 */
export function buildIntro(payload: GuideBuildPayload | null | undefined): GuideCopyLine[] {
  if (!payload || !payload.published) return [];
  return compact([
    buildOverviewLine(payload),
    buildRangeLine(payload),
    buildHeadlineLine(payload),
    buildPrevalenceLine(payload),
    buildTrendLine(payload),
    thinLine("intro-thin", payload.overall.games),
  ]);
}

// ---------------------------------------------------------------------------
// Build page — key timings.
// ---------------------------------------------------------------------------

/** Verb for a milestone's event: plural ("winning games start") or singular. */
function eventVerb(milestone: GuideMilestone, isSingular: boolean): string {
  if (milestone.event === "finish") return isSingular ? "finishes" : "finish";
  return isSingular ? "starts" : "start";
}

/** The milestone with the latest median: the payoff of the opener. */
function latestMilestone(milestones: ReadonlyArray<GuideMilestone>): GuideMilestone | null {
  let latest: GuideMilestone | null = null;
  for (const milestone of milestones) {
    if (!latest || milestone.median > latest.median) latest = milestone;
  }
  return latest;
}

interface SplitMilestone {
  milestone: GuideMilestone;
  winners: GuideMilestoneSplit;
  losers: GuideMilestoneSplit;
}

/** Milestone whose winner/loser medians differ most (selection only; the gap is never printed). */
function widestSplit(milestones: ReadonlyArray<GuideMilestone>): SplitMilestone | null {
  let best: SplitMilestone | null = null;
  let bestGap = 0;
  for (const milestone of milestones) {
    const { winners, losers } = milestone;
    if (!winners || !losers) continue;
    const gap = Math.abs(winners.median - losers.median);
    if (gap > bestGap) {
      best = { milestone, winners, losers };
      bestGap = gap;
    }
  }
  return best;
}

function timingsSampleLine(samples: number, users: number): GuideCopyLine {
  return line(
    "timings-sample",
    `These timings come from ${fmtCount(samples)} recorded build orders by ${fmtCountNoun(users, "player")}. Buildings are timed when construction starts, upgrades and morphs when they finish, exactly as the replay records them.`,
    [samples, users],
  );
}

function timingsPayoffLine(milestones: ReadonlyArray<GuideMilestone>): GuideCopyLine | null {
  const milestone = latestMilestone(milestones);
  if (!milestone) return null;
  return line(
    "timings-payoff",
    `The median player ${eventVerb(milestone, true)} ${milestone.label} at ${fmtClock(milestone.median)}, with the middle half between ${fmtClock(milestone.p25)} and ${fmtClock(milestone.p75)}.`,
    [milestone.median, milestone.p25, milestone.p75],
  );
}

function timingsSplitLine(milestones: ReadonlyArray<GuideMilestone>): GuideCopyLine | null {
  const split = widestSplit(milestones);
  if (!split) return null;
  const winnersAt = fmtClock(split.winners.median);
  const losersAt = fmtClock(split.losers.median);
  if (winnersAt === losersAt) return null;
  return line(
    "timings-split",
    `Winning games ${eventVerb(split.milestone, false)} ${split.milestone.label} at ${winnersAt} on median, against ${losersAt} in losses.`,
    [split.winners.median, split.losers.median],
  );
}

function timingsThinLine(samples: number): GuideCopyLine | null {
  if (samples >= GUIDE_THIN_SAMPLE_GAMES) return null;
  return line(
    "timings-thin",
    `Timing data is still thin (n = ${fmtCount(samples)} replays), so expect these medians to move.`,
    [samples],
  );
}

/**
 * Blurb above the key-timings table. Unpublished / no timings → [].
 *
 * Example: `buildTimingsBlurb(published)[1].text` → "The median player
 * finishes Resonating Glaives at 6:12, with the middle half between 5:58
 * and 6:31."
 */
export function buildTimingsBlurb(
  payload: GuideBuildPayload | null | undefined,
): GuideCopyLine[] {
  if (!payload || !payload.published || !payload.timings) return [];
  const { samples, users, milestones } = payload.timings;
  if (milestones.length === 0) return [];
  return compact([
    timingsSampleLine(samples, users),
    timingsPayoffLine(milestones),
    timingsSplitLine(milestones),
    timingsThinLine(samples),
  ]);
}

// ---------------------------------------------------------------------------
// Counter page.
// ---------------------------------------------------------------------------

interface CounterFacts {
  name: string;
  race: string;
  matchup: string;
  wr: string;
  games: string;
  /** "1 player" / "63 players". */
  users: string;
}

const COUNTER_OVERVIEW: ReadonlyArray<Variant<CounterFacts>> = [
  (f) =>
    `Against ${f.name}, ${f.race} players win ${f.wr} of decided games across ${f.games} ${f.matchup} ladder games from ${f.users}.`,
  (f) =>
    `When the opponent opens ${f.name}, ${f.race} players take ${f.wr} of decided games (${f.games} ${f.matchup} ladder games, ${f.users}).`,
];

function openerLine(id: string, lead: string, row: GuideCell & { name: string }): GuideCopyLine {
  return line(
    id,
    `${lead} ${row.name}: ${fmtPct(row.winRate)} over ${fmtCount(row.games)} games (likely range ${fmtCi(row.ci)}).`,
    [row.winRate, row.games, row.ci.low, row.ci.high],
  );
}

/**
 * Intro for a counter page (how to beat an opponent strategy). Unpublished → [].
 *
 * Example: `buildCounterIntro(published)[0].text` → "Against 8 Pool,
 * Protoss players win 61.0% of decided games across 312 PvZ ladder games
 * from 58 players."
 */
export function buildCounterIntro(
  payload: GuideCounterPayload | null | undefined,
): GuideCopyLine[] {
  if (!payload || !payload.published) return [];
  const { overall, openers } = payload;
  const facts: CounterFacts = {
    name: payload.name,
    race: raceWord(payload.matchup, MY_RACE_INDEX),
    matchup: payload.matchup,
    wr: fmtPct(overall.winRate),
    games: fmtCount(overall.games),
    users: fmtCountNoun(overall.users, "player"),
  };
  const seed = `${payload.matchupSlug}/counter/${payload.strategySlug}`;
  const overview = pickVariant(COUNTER_OVERVIEW, seed, "overview");
  const best = bestByCiLow(openers);
  const runnerUp = best ? bestByCiLow(openers.filter((row) => row !== best)) : null;
  return compact([
    line("counter-overview", overview(facts), [overall.winRate, overall.games, overall.users]),
    best ? openerLine("counter-best", "The most reliable answer so far is", best) : null,
    runnerUp ? openerLine("counter-runner-up", "Next best is", runnerUp) : null,
    thinLine("counter-thin", overall.games),
  ]);
}

// ---------------------------------------------------------------------------
// Matchup page.
// ---------------------------------------------------------------------------

interface MatchupFacts {
  matchup: string;
  when: string;
  games: string;
  /** "1 player" / "63 players". */
  users: string;
  /** "has" for one player, else "have". */
  have: string;
}

const MATCHUP_OVERVIEW: ReadonlyArray<Variant<MatchupFacts>> = [
  (f) =>
    `The guide sample covers ${f.games} ${f.matchup} ladder games from ${f.users} ${f.when}.`,
  (f) => `${f.users} ${f.have} contributed ${f.games} ${f.matchup} ladder games ${f.when}.`,
];

function matchupOverviewLine(p: GuideMatchupPayload, games: number, users: number): GuideCopyLine {
  const facts: MatchupFacts = {
    matchup: p.matchup,
    when: eraPhrase(p.era, p.patch),
    games: fmtCount(games),
    users: fmtCountNoun(users, "player"),
    have: users === 1 ? "has" : "have",
  };
  const variant = pickVariant(MATCHUP_OVERVIEW, p.slug, "overview");
  return line("matchup-overview", variant(facts), [games, users]);
}

function matchupBandLine(p: GuideMatchupPayload): GuideCopyLine | null {
  if (!p.band) return null;
  const who =
    p.band.type === "mmr" ? `opponents rated ${p.band.label} MMR` : `${p.band.label} opponents`;
  return line(
    "matchup-band",
    `Filtered to ${who}; openers are ranked by the low end of their likely win-rate range.`,
    [],
  );
}

function matchupPopularLine(p: GuideMatchupPayload, topKey: string | null): GuideCopyLine | null {
  let popular: (typeof p.openers)[number] | null = null;
  for (const row of p.openers) {
    if (row.prevalence === null) continue;
    if (!popular || row.prevalence > (popular.prevalence ?? 0)) popular = row;
  }
  if (!popular || popular.prevalence === null || popular.buildKey === topKey) return null;
  return line(
    "matchup-popular",
    `${popular.name} is the most common pick, showing up in ${fmtPct(popular.prevalence)} of games.`,
    [popular.prevalence],
  );
}

/**
 * Intro for a matchup page. Unpublished / no totals → [].
 *
 * Example: `buildMatchupIntro(published)[0].text` → "The guide sample
 * covers 18,412 PvZ ladder games from 634 players since patch 5.0.16."
 */
export function buildMatchupIntro(
  payload: GuideMatchupPayload | null | undefined,
): GuideCopyLine[] {
  if (!payload || !payload.published) return [];
  const { games, users } = payload;
  if (games === null || users === null) return [];
  const top = bestByCiLow(payload.openers.filter((row) => row.published));
  return compact([
    matchupOverviewLine(payload, games, users),
    matchupBandLine(payload),
    top ? openerLine("matchup-top", "The strongest record we can vouch for belongs to", top) : null,
    matchupPopularLine(payload, top ? top.buildKey : null),
    thinLine("matchup-thin", games),
  ]);
}

// ---------------------------------------------------------------------------
// Map page.
// ---------------------------------------------------------------------------

type MapRows = Extract<GuideMapPayload, { published: true }>["matchups"];

interface MapFacts {
  map: string;
  when: string;
  games: string;
}

const MAP_OVERVIEW: ReadonlyArray<Variant<MapFacts>> = [
  (f) => `${f.map} has ${f.games} tracked ladder games ${f.when}.`,
  (f) => `${capitalize(f.when)}, the guide sample holds ${f.games} ladder games on ${f.map}.`,
];

function mapBusiestLine(rows: MapRows): GuideCopyLine | null {
  let busiest: MapRows[number] | null = null;
  for (const row of rows) {
    if (!busiest || row.games > busiest.games) busiest = row;
  }
  if (!busiest) return null;
  const games = fmtCount(busiest.games);
  if (isMirror(busiest.matchup)) {
    return line(
      "map-busiest",
      `${busiest.matchup} is the most played matchup here with ${games} games.`,
      [busiest.games],
    );
  }
  const race = raceWord(busiest.matchup, MY_RACE_INDEX);
  return line(
    "map-busiest",
    `${busiest.matchup} is the most played matchup here with ${games} games, and ${race} wins ${fmtPct(busiest.winRate)} of the decided ones.`,
    [busiest.games, busiest.winRate],
  );
}

function mapStandoutLine(rows: MapRows): GuideCopyLine | null {
  let standout: { matchup: string; opener: MapRows[number]["openers"][number] } | null = null;
  for (const row of rows) {
    const opener = bestByCiLow(row.openers);
    if (opener && (!standout || opener.ci.low > standout.opener.ci.low)) {
      standout = { matchup: row.matchup, opener };
    }
  }
  if (!standout) return null;
  const { opener, matchup } = standout;
  return line(
    "map-standout",
    `The standout opener on this map is ${opener.name} in ${matchup}: ${fmtPct(opener.winRate)} over ${fmtCount(opener.games)} games.`,
    [opener.winRate, opener.games],
  );
}

/**
 * Intro for a map page. Unpublished → [].
 *
 * Example: `buildMapIntro(published)[0].text` → "Alcyone LE has 2,418
 * tracked ladder games since patch 5.0.16."
 */
export function buildMapIntro(payload: GuideMapPayload | null | undefined): GuideCopyLine[] {
  if (!payload || !payload.published) return [];
  const facts: MapFacts = {
    map: payload.map,
    when: eraPhrase(payload.era, payload.patch),
    games: fmtCount(payload.games),
  };
  const overview = pickVariant(MAP_OVERVIEW, payload.mapSlug, "overview");
  return compact([
    line("map-overview", overview(facts), [payload.games]),
    mapBusiestLine(payload.matchups),
    mapStandoutLine(payload.matchups),
    thinLine("map-thin", payload.games),
  ]);
}
