"use strict";

/**
 * Build check-in suggestion: which build the player most likely went for.
 *
 * Pure and synchronous. Callers supply the game, the classifier's view of
 * it, the "you" start-time events (``null`` when the replay detail could not
 * be read), the live declaration and randomizer roll, the matchup's options
 * and the rules of the user's custom builds in that matchup.
 *
 *   declared                  → the declaration ("declared")
 *   randomizer roll R         → R when the replay is consistent with it
 *                               ("randomizer"), else bestMatch() and
 *                               ``randomizerDeviated``
 *   otherwise                 → bestMatch()
 *
 *   bestMatch: the detector's custom build, then the detector's catalog
 *   build ("detected"); then the custom build whose rules came closest
 *   (≥ 50 % passed, "rules"); then the matchup's usual build ("usual").
 *
 * The opponent's build (``suggestOpponent``) only has the first two steps:
 * the detector's opponent label when it is an opponent option ("detected"),
 * else the opponent-perspective custom build whose rules came closest on
 * the opponent's events ("rules").
 */

const { evaluateRules } = require("./buildRulesEvaluator");
const { ruleNameFromUnit } = require("./knownBuildings");
const { TWELVE_POOL_NAMES, poolNameForGame } = require("../util/poolBuildNames");

/** Classifier fallbacks that never name a build the player went for. */
const GENERIC_LABEL_RE = /\(Unclassified\)$|^Unclassified - |Game Too Short$|Standard Play| Comp$/;
const RULES_MIN_RATIO = 0.5;
const RANDOMIZER_CONSISTENT_RATIO = 0.6;

/** @typedef {import('./buildIntentAttribution').BuildRef} BuildRef */
/**
 * @typedef {"declared"|"randomizer"|"detected"|"rules"|"usual"} SuggestionReason
 * @typedef {BuildRef & { reason: SuggestionReason, passedRules: number|null, ruleCount: number|null }} Suggestion
 * @typedef {{
 *   key: string, name: string, slug: string|null, source: "catalog"|"custom",
 *   games: number, wins: number, losses: number, checkins: number,
 *   lastPlayedAt: string|null, inRandomizer: boolean, group: "yours"|"all",
 *   ruleCount?: number,
 * }} BuildOption
 * @typedef {{ rules: Array<Record<string, any>>, updatedAt: number }} CustomRuleSet
 * @typedef {{ myBuild: string|null, customBuildSlug: string|null }} DetectorLabel
 * @typedef {{ strategy: string|null, customStrategySlug: string|null }} OpponentDetectorLabel
 */

/**
 * @param {unknown} name
 * @returns {boolean}
 */
function isGenericLabel(name) {
  return typeof name === "string" && GENERIC_LABEL_RE.test(name);
}

/**
 * The era-neutral (12 Pool) form of a catalog name; other names unchanged.
 * @param {unknown} name
 * @returns {string|null}
 */
function twelvePoolName(name) {
  if (typeof name !== "string" || name.length === 0) return null;
  return Object.hasOwn(TWELVE_POOL_NAMES, name)
    ? /** @type {Record<string, string>} */ (TWELVE_POOL_NAMES)[name]
    : name;
}

/**
 * A custom build's evaluable rules: v3 ``rules``, else the legacy
 * ``signature`` rows (same mapping as the classifier's ``extractRules``).
 *
 * @param {Record<string, any>} build
 * @returns {Array<Record<string, any>>}
 */
function rulesForBuild(build) {
  if (Array.isArray(build.rules) && build.rules.length > 0) {
    return build.rules.filter((rule) => rule && typeof rule === "object" && rule.name);
  }
  if (Array.isArray(build.signature) && build.signature.length > 0) {
    return build.signature
      .filter((row) => row && typeof row === "object" && typeof row.unit === "string")
      .map((row) => ({
        type: "count_min",
        name: ruleNameFromUnit(row.unit),
        time_lt: Math.max(1, Number(row.beforeSec) || 60),
        count: Math.max(1, Number(row.count) || 1),
        ...(row.proxy === true ? { proxy: true } : {}),
      }));
  }
  return [];
}

/**
 * @param {Array<Record<string, any>>} rules
 * @param {ReadonlyArray<any>|null} events
 * @returns {{ passedCount: number, ruleCount: number, unavailable: boolean } | null}
 *   null when the evaluation cannot run (no events, no rules, evaluator error)
 */
function scoreRules(rules, events) {
  if (!Array.isArray(events) || events.length === 0 || rules.length === 0) return null;
  try {
    const result = evaluateRules(/** @type {any} */ (rules), events);
    return {
      passedCount: result.passedCount,
      ruleCount: result.ruleCount,
      unavailable: result.unavailable === true,
    };
  } catch {
    return null;
  }
}

/**
 * @param {BuildRef} ref
 * @param {SuggestionReason} reason
 * @param {{ passedCount: number, ruleCount: number } | null} counts
 * @param {Record<string, any>} game
 * @returns {Suggestion}
 */
function toSuggestion(ref, reason, counts, game) {
  const name = ref.source === "catalog"
    ? String(poolNameForGame(twelvePoolName(ref.name), game))
    : ref.name;
  return {
    key: ref.key,
    name,
    slug: ref.source === "custom" ? ref.slug : null,
    source: ref.source,
    reason,
    passedRules: counts ? counts.passedCount : null,
    ruleCount: counts ? counts.ruleCount : null,
  };
}

/**
 * @param {Record<string, any>|null|undefined} ref
 * @returns {BuildRef|null}
 */
function asBuildRef(ref) {
  if (!ref || typeof ref !== "object") return null;
  if (typeof ref.key !== "string" || typeof ref.name !== "string") return null;
  const source = ref.source === "custom" ? "custom" : "catalog";
  return {
    key: ref.key,
    name: ref.name,
    slug: source === "custom" && typeof ref.slug === "string" ? ref.slug : null,
    source,
  };
}

/**
 * Did the replay come out as ``build``?
 *
 * @param {Record<string, any>|null|undefined} build
 * @param {DetectorLabel} detector
 * @returns {boolean}
 */
function executedFor(build, detector) {
  const ref = asBuildRef(build);
  if (!ref) return false;
  if (ref.source === "custom") {
    return Boolean(ref.slug) && detector.customBuildSlug === ref.slug;
  }
  const detected = twelvePoolName(detector.myBuild);
  return detected !== null && detected === twelvePoolName(ref.name);
}

/**
 * The option key of the detector's label, when that label is an option.
 *
 * @param {DetectorLabel} detector
 * @param {ReadonlyArray<BuildOption>} builds
 * @returns {string|null}
 */
function detectedOptionKey(detector, builds) {
  const option = detectedOption(detector, builds);
  return option ? option.key : null;
}

/**
 * @param {DetectorLabel} detector
 * @param {ReadonlyArray<BuildOption>} builds
 * @returns {BuildOption|null}
 */
function detectedOption(detector, builds) {
  if (detector.customBuildSlug) {
    const custom = builds.find((b) => b.source === "custom" && b.slug === detector.customBuildSlug);
    if (custom) return custom;
    return null;
  }
  const name = twelvePoolName(detector.myBuild);
  if (!name || isGenericLabel(name)) return null;
  return builds.find((b) => b.source === "catalog" && b.name === name) || null;
}

/**
 * @param {BuildRef} roll
 * @param {DetectorLabel} detector
 * @param {ReadonlyArray<any>|null} events
 * @param {Map<string, CustomRuleSet>} customRules
 * @returns {{ consistent: boolean, counts: { passedCount: number, ruleCount: number } | null }}
 */
function rollConsistency(roll, detector, events, customRules) {
  if (roll.source === "custom") {
    const set = roll.slug ? customRules.get(roll.slug) : undefined;
    // Unknown (deleted build) or rule-less: nothing contradicts the roll.
    if (!set || set.rules.length === 0) return { consistent: true, counts: null };
    const score = scoreRules(set.rules, events);
    // Unreadable detail or unavailable evidence: the roll stands.
    if (!score || score.unavailable) return { consistent: true, counts: null };
    const counts = { passedCount: score.passedCount, ruleCount: score.ruleCount };
    if (detector.customBuildSlug === roll.slug) return { consistent: true, counts };
    return {
      consistent: score.passedCount / score.ruleCount >= RANDOMIZER_CONSISTENT_RATIO,
      counts,
    };
  }
  const detected = twelvePoolName(detector.myBuild);
  const consistent = detected === null
    || isGenericLabel(detected)
    || detected === twelvePoolName(roll.name);
  return { consistent, counts: null };
}

/**
 * @param {{
 *   game: Record<string, any>,
 *   detector: DetectorLabel,
 *   events: ReadonlyArray<any>|null,
 *   builds: ReadonlyArray<BuildOption>,
 *   usualKey: string|null,
 *   customRules: Map<string, CustomRuleSet>,
 * }} input
 * @returns {Suggestion|null}
 */
function bestMatch(input) {
  const { game, detector, events, builds, customRules } = input;
  const detected = detectedOption(detector, builds);
  if (detected) return detectedSuggestion(detected, events, customRules, game);
  const ranked = rankCustomByRules(builds, events, customRules);
  if (ranked) return toSuggestion(ranked.option, "rules", ranked.score, game);
  const usual = input.usualKey ? builds.find((b) => b.key === input.usualKey) : null;
  if (usual) return toSuggestion(usual, "usual", null, game);
  return null;
}

/**
 * The detector's option as a "detected" suggestion; a custom build carries
 * its rule score.
 * @param {BuildOption} detected
 * @param {ReadonlyArray<any>|null} events
 * @param {Map<string, CustomRuleSet>} customRules
 * @param {Record<string, any>} game
 * @returns {Suggestion}
 */
function detectedSuggestion(detected, events, customRules, game) {
  /** @type {{ passedCount: number, ruleCount: number } | null} */
  let counts = null;
  if (detected.source === "custom" && detected.slug) {
    const rules = customRules.get(detected.slug)?.rules || [];
    const score = scoreRules(rules, events);
    // The classifier passed every rule; trust that when the detail is unreadable.
    if (score && !score.unavailable) {
      counts = { passedCount: score.passedCount, ruleCount: score.ruleCount };
    } else if (rules.length > 0) {
      counts = { passedCount: rules.length, ruleCount: rules.length };
    }
  }
  return toSuggestion(detected, "detected", counts, game);
}

/**
 * @param {ReadonlyArray<BuildOption>} builds
 * @param {ReadonlyArray<any>|null} events
 * @param {Map<string, CustomRuleSet>} customRules
 * @returns {{ option: BuildOption, score: { passedCount: number, ruleCount: number } } | null}
 */
function rankCustomByRules(builds, events, customRules) {
  if (!Array.isArray(events) || events.length === 0) return null;
  /** @type {Array<{ option: BuildOption, score: { passedCount: number, ruleCount: number }, ratio: number, updatedAt: number }>} */
  const scored = [];
  for (const option of builds) {
    if (option.source !== "custom" || !option.slug) continue;
    const set = customRules.get(option.slug);
    if (!set || set.rules.length === 0) continue;
    const score = scoreRules(set.rules, events);
    if (!score || score.ruleCount === 0) continue;
    const ratio = score.passedCount / score.ruleCount;
    if (ratio < RULES_MIN_RATIO) continue;
    scored.push({
      option,
      score: { passedCount: score.passedCount, ruleCount: score.ruleCount },
      ratio,
      updatedAt: set.updatedAt,
    });
  }
  scored.sort((a, b) => (
    b.ratio - a.ratio
    || b.score.ruleCount - a.score.ruleCount
    || b.updatedAt - a.updatedAt
    || String(a.option.slug).localeCompare(String(b.option.slug))
  ));
  const top = scored[0];
  return top ? { option: top.option, score: top.score } : null;
}

/**
 * @param {{
 *   game: Record<string, any>,
 *   detector: DetectorLabel,
 *   events: ReadonlyArray<any>|null,
 *   declared?: Record<string, any>|null,
 *   randomizer?: Record<string, any>|null,
 *   builds: ReadonlyArray<BuildOption>,
 *   usualKey?: string|null,
 *   customRules?: Map<string, CustomRuleSet>,
 * }} input
 * @returns {{ suggestion: Suggestion|null, randomizerDeviated: boolean }}
 */
function suggestIntent(input) {
  const customRules = input.customRules || new Map();
  const base = {
    game: input.game,
    detector: input.detector,
    events: input.events,
    builds: input.builds,
    usualKey: input.usualKey || null,
    customRules,
  };
  const declared = asBuildRef(input.declared);
  if (declared) {
    return { suggestion: toSuggestion(declared, "declared", null, input.game), randomizerDeviated: false };
  }
  const roll = asBuildRef(input.randomizer);
  if (roll) {
    const { consistent, counts } = rollConsistency(roll, input.detector, input.events, customRules);
    if (consistent) {
      return { suggestion: toSuggestion(roll, "randomizer", counts, input.game), randomizerDeviated: false };
    }
    return { suggestion: bestMatch(base), randomizerDeviated: true };
  }
  return { suggestion: bestMatch(base), randomizerDeviated: false };
}

/**
 * The opponent axis's detector view in the shape the "you"-axis helpers
 * read (``executedFor``, ``detectedOptionKey``).
 * @param {OpponentDetectorLabel} view
 * @returns {DetectorLabel}
 */
function opponentDetectorLabel(view) {
  return { myBuild: view.strategy, customBuildSlug: view.customStrategySlug };
}

/**
 * The opponent option the classifier's opponent label names: its custom
 * slug among the opponent-perspective custom options, else its era-neutral
 * name among the catalog opponent options. Generic labels name nothing.
 *
 * @param {OpponentDetectorLabel} view
 * @param {ReadonlyArray<BuildOption>} builds opponent options
 * @returns {BuildOption|null}
 */
function detectedOpponentOption(view, builds) {
  return detectedOption(opponentDetectorLabel(view), builds);
}

/**
 * Which build the opponent most likely went for: the detector's opponent
 * label when it is an option ("detected"), else the opponent-perspective
 * custom build whose rules came closest on the opponent's start-time
 * events (≥ 50 %, "rules"), else null.
 *
 * @param {{
 *   game: Record<string, any>,
 *   detector: OpponentDetectorLabel,
 *   events: ReadonlyArray<any>|null,
 *   builds: ReadonlyArray<BuildOption>,
 *   customRules?: Map<string, CustomRuleSet>,
 * }} input
 * @returns {Suggestion|null}
 */
function suggestOpponent(input) {
  const customRules = input.customRules || new Map();
  const detected = detectedOpponentOption(input.detector, input.builds);
  if (detected) return detectedSuggestion(detected, input.events, customRules, input.game);
  const ranked = rankCustomByRules(input.builds, input.events, customRules);
  return ranked ? toSuggestion(ranked.option, "rules", ranked.score, input.game) : null;
}

module.exports = {
  GENERIC_LABEL_RE,
  RULES_MIN_RATIO,
  RANDOMIZER_CONSISTENT_RATIO,
  isGenericLabel,
  twelvePoolName,
  rulesForBuild,
  scoreRules,
  asBuildRef,
  executedFor,
  detectedOptionKey,
  suggestIntent,
  opponentDetectorLabel,
  detectedOpponentOption,
  suggestOpponent,
};
