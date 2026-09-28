"use strict";

/**
 * Guide videos — deterministic, conservative matching of a channel video
 * to the guide catalog (services/guideVideos.js).
 *
 * A video matches:
 *   - a matchup: the first "PvZ"-style token in its title, else the first
 *     "#PvT"-style hashtag in its description. Shorts (YouTube's own
 *     /shorts/ link, or a #Shorts hashtag) and stream VODs ("stream" /
 *     "livestream" in the title, or the channel's "Support the stream"
 *     description line) match nothing.
 *   - builds / counters: catalog names in that matchup's builds / counters
 *     namespace (config/guideSlugs.js) whose normalised display name occurs
 *     as a whole-word phrase in the normalised title. Normalising
 *     lowercases, folds diacritics, turns every non-alphanumeric run into a
 *     space and folds simple plurals ("Glaives" → "glaive", "Pools" →
 *     "pool") on both sides. A phrase needs at least two words, and a
 *     phrase contained in a longer matched phrase of the same namespace is
 *     dropped (the more specific name wins).
 *
 * Only the title names builds: descriptions mention many builds in
 * passing ("Watch next — …"), so reading them would over-match. Videos
 * whose titles do not name the catalog build are linked by hand through
 * `curatedLinks` in config/guideVideosSnapshot.json.
 *
 * Pure and synchronous: no I/O, no logging.
 */

const {
  MATCHUPS,
  buildNamesForMatchup,
  strategyNamesForMatchup,
  displayName,
} = require("../config/guideSlugs");

/** "PvZ" at a word boundary anywhere in a title (case-insensitive). */
const TITLE_MATCHUP_RE = /(?:^|[^A-Za-z0-9])([PTZ])v([PTZ])(?![A-Za-z0-9])/i;
/** "#PvZ" hashtag in a description (case-insensitive). */
const HASHTAG_MATCHUP_RE = /#([PTZ])v([PTZ])(?![A-Za-z0-9])/i;
/** YouTube Shorts marker hashtag. */
const SHORTS_HASHTAG_RE = /#shorts(?![A-Za-z0-9])/i;
/**
 * Stream VOD titles: any title containing "stream" ("Stream", "streaming",
 * "livestream", "LIVESTREAMED"). Deliberately a plain substring (the
 * contract's rule): a rare false negative ("mainstream") beats a stream
 * VOD posing as a build guide.
 */
const STREAM_TITLE_RE = /stream/i;
/**
 * The channel's stream VODs carry this description line. Leading blanks
 * exclude line breaks: `^\s*` would re-scan every run of blank lines from
 * each of its line starts (quadratic on a newline-heavy description).
 */
const STREAM_DESCRIPTION_RE = /^[^\S\r\n]*support the stream\b/im;
/** Shortest phrase (in words) that may name a catalog build. */
const MIN_PHRASE_WORDS = 2;
/** Plural folding only applies to words at least this long. */
const PLURAL_MIN_CHARS = 4;
/** Word endings that are not simple plurals ("glass", "colossus"). */
const NON_PLURAL_SUFFIX_RE = /(?:ss|us)$/;
/** Longest title / description the matcher reads (bounded work). */
const MAX_TITLE_CHARS = 300;
const MAX_DESCRIPTION_CHARS = 10000;

/**
 * @typedef {object} VideoMatch
 * @property {string|null} matchup "PvZ" form
 * @property {string[]} builds    catalog names (builds namespace), sorted
 * @property {string[]} counters  catalog names (counters namespace), sorted
 */

/**
 * @typedef {object} MatchableVideo
 * @property {string} [youtubeId]
 * @property {string} title
 * @property {string} [description]
 * @property {boolean} [isShort] true when YouTube serves it as a Short
 */

/**
 * @typedef {object} CuratedLink
 * @property {string} youtubeId
 * @property {"build"|"counter"} kind
 * @property {string} matchup "PvZ" form
 * @property {string} name    exact catalog name
 */

/** @typedef {{ name: string, phrase: string }} CatalogPhrase */

/**
 * Fold a simple English plural: "glaives" → "glaive", "pools" → "pool".
 *
 * @param {string} word lowercase ASCII word
 * @returns {string}
 */
function foldPlural(word) {
  if (word.length < PLURAL_MIN_CHARS || !word.endsWith("s")) return word;
  if (NON_PLURAL_SUFFIX_RE.test(word)) return word;
  return word.slice(0, -1);
}

/**
 * Normalise text for phrase matching.
 *
 * Example: `normalizeMatchText("PvZ Stargate into Glaive Adept Timing")`
 * → "pvz stargate into glaive adept timing";
 * `normalizeMatchText("Rail's Disruptor Drop")` → "rail s disruptor drop".
 *
 * @param {unknown} text
 * @returns {string} space-separated words ("" for non-strings)
 */
function normalizeMatchText(text) {
  if (typeof text !== "string") return "";
  return text
    .slice(0, MAX_DESCRIPTION_CHARS)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(foldPlural)
    .join(" ");
}

/**
 * @param {RegExpExecArray|null} hit
 * @returns {string|null}
 */
function matchupFromHit(hit) {
  if (!hit) return null;
  const matchup = `${hit[1].toUpperCase()}v${hit[2].toUpperCase()}`;
  return MATCHUPS.includes(matchup) ? matchup : null;
}

/**
 * Matchup named by a video: the title's first "PvZ" token, else the
 * description's first "#PvZ" hashtag.
 *
 * Example: title "3 Rax, 1 Answer" + description "… #StarCraft2 #PvT" → "PvT".
 *
 * @param {string} title
 * @param {string} description
 * @returns {string|null}
 */
function detectMatchup(title, description) {
  return matchupFromHit(TITLE_MATCHUP_RE.exec(title))
    || matchupFromHit(HASHTAG_MATCHUP_RE.exec(description));
}

/**
 * True for a YouTube Short: YouTube's /shorts/ link (`isShort`) or a
 * #Shorts hashtag in the description.
 *
 * @param {MatchableVideo} video
 * @returns {boolean}
 */
function isShortVideo(video) {
  if (video.isShort === true) return true;
  return typeof video.description === "string" && SHORTS_HASHTAG_RE.test(video.description);
}

/**
 * True for a stream VOD ("stream"/"livestream" in the title, or the
 * channel's "Support the stream" description line).
 *
 * @param {MatchableVideo} video
 * @returns {boolean}
 */
function isStreamVideo(video) {
  if (typeof video.title === "string" && STREAM_TITLE_RE.test(video.title)) return true;
  return typeof video.description === "string" && STREAM_DESCRIPTION_RE.test(video.description);
}

/**
 * @param {ReadonlyArray<string>} names
 * @returns {ReadonlyArray<CatalogPhrase>}
 */
function phrasesFor(names) {
  return Object.freeze(
    names
      .map((name) => ({ name, phrase: normalizeMatchText(displayName(name)) }))
      .filter((entry) => entry.phrase.split(" ").length >= MIN_PHRASE_WORDS),
  );
}

/** @type {ReadonlyMap<string, { builds: ReadonlyArray<CatalogPhrase>, counters: ReadonlyArray<CatalogPhrase> }>} */
const PHRASES_BY_MATCHUP = new Map(MATCHUPS.map((matchup) => [matchup, {
  builds: phrasesFor(buildNamesForMatchup(matchup)),
  counters: phrasesFor(strategyNamesForMatchup(matchup)),
}]));

/**
 * @param {string} haystack normalised text
 * @param {string} phrase   normalised phrase
 * @returns {boolean} true when `phrase` occurs as whole words in `haystack`
 */
function containsPhrase(haystack, phrase) {
  return ` ${haystack} `.includes(` ${phrase} `);
}

/**
 * Catalog names whose phrase occurs in the normalised title, minus any
 * phrase contained in a longer matched phrase.
 *
 * @param {string} normalizedTitle
 * @param {ReadonlyArray<CatalogPhrase>} phrases
 * @returns {string[]} sorted catalog names
 */
function namesInTitle(normalizedTitle, phrases) {
  const hits = phrases.filter((entry) => containsPhrase(normalizedTitle, entry.phrase));
  return hits
    .filter((entry) => !hits.some((other) =>
      other.phrase !== entry.phrase && containsPhrase(other.phrase, entry.phrase)))
    .map((entry) => entry.name)
    .sort();
}

/** @returns {VideoMatch} */
function noMatch() {
  return { matchup: null, builds: [], counters: [] };
}

/**
 * Match one video to a matchup and to catalog builds / counters.
 *
 * Example: `matchVideo({ title: "PvZ Cracking 8 Pools", description: "" })`
 * → `{ matchup: "PvZ", builds: [], counters: ["Zerg - 8 Pool"] }`.
 *
 * @param {MatchableVideo} video
 * @returns {VideoMatch}
 */
function matchVideo(video) {
  if (!video || typeof video.title !== "string") return noMatch();
  const title = video.title.slice(0, MAX_TITLE_CHARS);
  const description = typeof video.description === "string"
    ? video.description.slice(0, MAX_DESCRIPTION_CHARS)
    : "";
  const safe = { title, description, isShort: video.isShort };
  if (isShortVideo(safe) || isStreamVideo(safe)) return noMatch();
  const matchup = detectMatchup(title, description);
  const phrases = matchup ? PHRASES_BY_MATCHUP.get(matchup) : undefined;
  if (!matchup || !phrases) return noMatch();
  const normalizedTitle = normalizeMatchText(title);
  return {
    matchup,
    builds: namesInTitle(normalizedTitle, phrases.builds),
    counters: namesInTitle(normalizedTitle, phrases.counters),
  };
}

/**
 * True when a curated link names a real catalog entry of its matchup's
 * namespace (builds for "build", counters for "counter").
 *
 * @param {CuratedLink} link
 * @returns {boolean}
 */
function isValidCuratedLink(link) {
  if (!link || typeof link.name !== "string" || !MATCHUPS.includes(link.matchup)) return false;
  if (link.kind === "build") return buildNamesForMatchup(link.matchup).includes(link.name);
  if (link.kind === "counter") return strategyNamesForMatchup(link.matchup).includes(link.name);
  return false;
}

/**
 * Add a video's curated links to its automatic match. A link only applies
 * when it is valid and agrees with the detected matchup (or none was
 * detected); names stay sorted and unique.
 *
 * @param {string} youtubeId
 * @param {VideoMatch} auto
 * @param {ReadonlyArray<CuratedLink>} links
 * @returns {VideoMatch}
 */
function applyCuratedLinks(youtubeId, auto, links) {
  let matchup = auto.matchup;
  const builds = new Set(auto.builds);
  const counters = new Set(auto.counters);
  for (const link of links) {
    if (link.youtubeId !== youtubeId || !isValidCuratedLink(link)) continue;
    if (matchup && matchup !== link.matchup) continue;
    matchup = link.matchup;
    (link.kind === "build" ? builds : counters).add(link.name);
  }
  return { matchup, builds: [...builds].sort(), counters: [...counters].sort() };
}

module.exports = {
  normalizeMatchText,
  detectMatchup,
  isShortVideo,
  isStreamVideo,
  matchVideo,
  isValidCuratedLink,
  applyCuratedLinks,
};
