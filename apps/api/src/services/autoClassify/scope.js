"use strict";

/**
 * autoClassify/scope — Helpers the discovery orchestrator uses to
 * decide which games are even eligible for clustering, and how to
 * group the survivors into one matchup-per-bucket view.
 *
 * Three concerns live here:
 *
 *   1. `UNCLASSIFIED_LABEL_RE` — the regex that recognises the
 *      Python-core catch-all labels we want to re-examine. Mirrors
 *      the strings the standalone analyzer emits when none of its
 *      hardcoded detectors fire: "Macro Transition (Unclassified)",
 *      "Macro Transition - <X>", "Unclassified - <Matchup>", and the
 *      legacy "Default" placeholder (see
 *      SC2Replay-Analyzer/analytics/clustering.py and
 *      core/strategy_detector_user.py for the source labels).
 *
 *   2. `isAlreadyClassified` — given a game and the user's saved
 *      custom builds (with their rules pre-extracted), tells the
 *      orchestrator whether the game is already accounted for by a
 *      named build (myBuild is a real, non-unclassified label) OR
 *      by an existing user custom build's rules. Those games must
 *      stay out of the discovery scan or we'd re-suggest builds the
 *      user has already authored.
 *
 *   3. `inferMatchupKey` / `groupGamesByMatchup` — derive the per-
 *      matchup buckets the cluster engine operates over. Matchups
 *      follow the rest of the codebase's convention (`${myRace}v${
 *      oppRace}`, my-side first) regardless of perspective; the
 *      perspective only decides which side's events get clustered.
 *
 * Pure: no I/O, no Mongo. The orchestrator owns all data loading.
 */

const {
  gameMatchesBuildMatchup,
  filterMatchingGames,
} = require("../customBuilds");

/**
 * Catch-all `myBuild` labels emitted by the Python-core detectors
 * (SC2Replay-Analyzer/analytics/clustering.py +
 *  SC2Replay-Analyzer/core/strategy_detector_user.py) when no named
 * tree matches the replay. Three families:
 *
 *   - "Macro Transition (Unclassified)" / "Macro Transition - <X>"
 *   - "Unclassified - <Matchup>" (start-anchored so a build literally
 *     named "Unclassified Aggression Build" by the user doesn't get
 *     re-scanned).
 *   - "Default" (anywhere in the label; covers the legacy placeholder
 *     and any "<X> Default" variant the analyzer falls through to).
 *
 * Empty / null labels are also "unclassified" — callers handle those
 * separately, since a regex can't match the absence of a string.
 */
const UNCLASSIFIED_LABEL_RE = /Macro Transition|^Unclassified|Default/i;

/**
 * `true` when the game's `myBuild` is empty, missing, or one of the
 * Python-core catch-all labels.
 *
 * @param {{myBuild?: string|null|undefined}} game
 * @returns {boolean}
 */
function isUnclassifiedLabel(game) {
  if (!game) return true;
  const label = game.myBuild;
  if (label == null) return true;
  const str = String(label).trim();
  if (str.length === 0) return true;
  return UNCLASSIFIED_LABEL_RE.test(str);
}

/**
 * @typedef {{
 *   build: any,
 *   rules: ReadonlyArray<{type:string, name:string, time_lt:number, count?:number}>,
 *   perspective: 'you'|'opponent',
 * }} PreparedCustomBuild
 */

/**
 * `true` when the game is already accounted for by ONE of:
 *   - a non-unclassified `myBuild` label (the agent's named detector
 *     already covered it), OR
 *   - any of the user's existing custom builds whose race / vsRace
 *     gate AND rule set both pass for this game.
 *
 * The second check is what stops us from re-suggesting a build the
 * user already saved themselves. We test membership using the same
 * `filterMatchingGames` predicate `/reclassify` uses, so a game we
 * call "already classified" is exactly a game `/reclassify` would
 * tag.
 *
 * @param {{events?: any[], oppEvents?: any[], myRace?: string|null, oppRace?: string|null, myBuild?: string|null}} game
 * @param {ReadonlyArray<PreparedCustomBuild>} prepared
 * @returns {boolean}
 */
function isAlreadyClassified(game, prepared) {
  if (!game) return false;
  if (!isUnclassifiedLabel(game)) return true;
  if (!Array.isArray(prepared) || prepared.length === 0) return false;
  for (const entry of prepared) {
    if (!entry || !entry.build) continue;
    const rules = entry.rules;
    if (!Array.isArray(rules) || rules.length === 0) continue;
    if (!gameMatchesBuildMatchup(game, entry.build, entry.perspective)) continue;
    if (filterMatchingGames([game], rules, entry.perspective).length > 0) {
      return true;
    }
  }
  return false;
}

/**
 * One-letter race code matching the cloud's convention (first char
 * upper-cased; falls back to "?" for missing/unknown races).
 *
 * @param {string|null|undefined} race
 * @returns {string}
 */
function raceLetter(race) {
  if (typeof race !== "string" || race.length === 0) return "?";
  return race.charAt(0).toUpperCase();
}

/**
 * Matchup key from a game. Always `${myRace[0]}v${oppRace[0]}` —
 * matches `matchupKey` in customBuilds.js and the rest of the
 * codebase. Returns null when either side is missing/unknown so the
 * orchestrator can drop those games from the scan (a discovered
 * build needs both races to round-trip through validateCustomBuild).
 *
 * @param {{myRace?: string|null, oppRace?: string|null}} game
 * @returns {string|null}
 */
function inferMatchupKey(game) {
  const my = raceLetter(game && game.myRace);
  const opp = raceLetter(game && game.oppRace);
  if (my === "?" || opp === "?") return null;
  return `${my}v${opp}`;
}

/**
 * Bucket a flat game list by matchup key. Games whose matchup can't
 * be inferred are silently dropped — they can't seed a valid custom
 * build anyway.
 *
 * @param {ReadonlyArray<{myRace?: string|null, oppRace?: string|null}>} games
 * @returns {Map<string, any[]>}
 */
function groupGamesByMatchup(games) {
  /** @type {Map<string, any[]>} */
  const buckets = new Map();
  if (!Array.isArray(games)) return buckets;
  for (const g of games) {
    const key = inferMatchupKey(g);
    if (!key) continue;
    let arr = buckets.get(key);
    if (!arr) {
      arr = [];
      buckets.set(key, arr);
    }
    arr.push(g);
  }
  return buckets;
}

/**
 * Pick the side of a game's parsed events the orchestrator should
 * cluster on. perspective='you' (default) returns the user's events;
 * perspective='opponent' returns the opponent's. The cluster engine
 * only needs an `events` field, so we shim into the same shape
 * whichever side wins.
 *
 * @param {{events?: any[]|null, oppEvents?: any[]|null}} game
 * @param {'you'|'opponent'} perspective
 * @returns {any[]}
 */
function selectEventsForPerspective(game, perspective) {
  if (!game) return [];
  const evs =
    perspective === "opponent" ? game.oppEvents : game.events;
  return Array.isArray(evs) ? evs : [];
}

/**
 * The race of the side a discovered build describes. perspective='you'
 * → the user's race; perspective='opponent' → the opponent's race.
 * Returns null when the chosen side has no race recorded.
 *
 * @param {{myRace?: string|null, oppRace?: string|null}} game
 * @param {'you'|'opponent'} perspective
 * @returns {string|null}
 */
function perspectiveRace(game, perspective) {
  if (!game) return null;
  return perspective === "opponent"
    ? game.oppRace || null
    : game.myRace || null;
}

/**
 * The race opposite the perspective side. perspective='you' → opp
 * race; perspective='opponent' → user's race.
 *
 * @param {{myRace?: string|null, oppRace?: string|null}} game
 * @param {'you'|'opponent'} perspective
 * @returns {string|null}
 */
function perspectiveVsRace(game, perspective) {
  if (!game) return null;
  return perspective === "opponent"
    ? game.myRace || null
    : game.oppRace || null;
}

/**
 * Capitalise a one-letter race code into the full race name the
 * custom-build schema enum requires ("Protoss" / "Terran" / "Zerg").
 * Returns null when the input doesn't decode to one of the three.
 *
 * @param {string|null|undefined} race
 * @returns {"Protoss"|"Terran"|"Zerg"|null}
 */
function fullRaceName(race) {
  if (typeof race !== "string" || race.length === 0) return null;
  const c = race.charAt(0).toUpperCase();
  if (c === "P") return "Protoss";
  if (c === "T") return "Terran";
  if (c === "Z") return "Zerg";
  return null;
}

module.exports = {
  UNCLASSIFIED_LABEL_RE,
  isUnclassifiedLabel,
  isAlreadyClassified,
  inferMatchupKey,
  groupGamesByMatchup,
  selectEventsForPerspective,
  perspectiveRace,
  perspectiveVsRace,
  fullRaceName,
  raceLetter,
};
