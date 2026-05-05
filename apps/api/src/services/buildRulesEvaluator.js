"use strict";

/**
 * buildRulesEvaluator — Pure rule evaluator for v3 BuildEditor rules.
 *
 * Mirrors the SPA's preview-matches semantics. Given an array of parsed
 * events (the same shape `parseBuildLogLines` emits) and a list of
 * rules, returns whether all rules pass — and, if not, which one
 * failed and why. Used by the /v1/custom-builds/preview-matches and
 * /v1/custom-builds/reclassify endpoints.
 *
 * Rule types (schema v3):
 *   - "before"      : `name` must occur with time < `time_lt`
 *   - "not_before"  : `name` must NOT occur with time < `time_lt`
 *   - "count_max"   : count of `name` events with time < `time_lt` ≤ `count`
 *   - "count_exact" : count of `name` events with time < `time_lt` === `count`
 *   - "count_min"   : count of `name` events with time < `time_lt` ≥ `count`
 *
 * Event matching uses the SPA token map: an event matches a rule when
 * its computed token (Build/Train/Research/Morph prefix) equals
 * `rule.name`. Bare nouns default to "Build" + noun.
 */

const SIG_TOKEN_REGEX = /^[A-Za-z][A-Za-z0-9]*$/;
const SIG_VERB_REGEX = /^(Build|Train|Research|Morph)\s+([A-Za-z][A-Za-z0-9]*)$/;
const SIG_PREFIXED_REGEX =
  /^(Build|Train|Research|Morph)[A-Z][A-Za-z0-9]*$/;
const ZERG_UNIT_MORPHS =
  /^(Baneling|Ravager|Lurker|LurkerMP|BroodLord|Overseer)$/;
const NOISE_RE = /^(Beacon|Reward|Spray)/;

/**
 * @typedef {{type: 'before'|'not_before'|'count_max'|'count_exact'|'count_min',
 *            name: string, time_lt: number, count?: number}} BuildRule
 *
 * @typedef {{time: number, name: string, race?: string, category?: string,
 *            is_building?: boolean}} ParsedEvent
 */

/**
 * Compute the canonical token for an event (matches the cloud frontend
 * `spaEventToWhat`). Returns null when the event is noise.
 *
 * @param {ParsedEvent | null | undefined} ev
 * @returns {string | null}
 */
function eventToken(ev) {
  if (!ev) return null;
  const raw = String(ev.name == null ? "" : ev.name).trim();
  if (!raw) return null;
  if (NOISE_RE.test(raw)) return null;
  const m = SIG_VERB_REGEX.exec(raw);
  if (m) return m[1] + m[2];
  if (SIG_PREFIXED_REGEX.test(raw)) return raw;
  const noun = raw.replace(/[^A-Za-z0-9]/g, "");
  if (!noun || !/^[A-Za-z]/.test(noun)) return null;
  if (ev.is_building) return "Build" + noun;
  if (ev.category === "upgrade") return "Research" + noun;
  if (
    ev.race === "Zerg" &&
    ev.category === "unit" &&
    ZERG_UNIT_MORPHS.test(noun)
  ) {
    return "Morph" + noun;
  }
  return "Build" + noun;
}

/**
 * Evaluate a single rule against an event list.
 *
 * @param {BuildRule} rule
 * @param {ReadonlyArray<ParsedEvent>} events
 * @returns {{ pass: boolean, reason?: string }}
 */
function evaluateRule(rule, events) {
  if (!rule || typeof rule !== "object") {
    return { pass: false, reason: "invalid rule" };
  }
  const name = String(rule.name || "");
  if (!SIG_TOKEN_REGEX.test(name)) {
    return { pass: false, reason: `bad rule name: ${name}` };
  }
  const limit = Number(rule.time_lt) || 0;
  let occurrencesBefore = 0;
  for (const ev of events) {
    if (!ev) continue;
    const t = Number(ev.time);
    if (!Number.isFinite(t)) continue;
    if (t >= limit) continue;
    if (eventToken(ev) === name) occurrencesBefore++;
  }
  switch (rule.type) {
    case "before":
      if (occurrencesBefore >= 1) return { pass: true };
      return {
        pass: false,
        reason: `${name} not built by ${formatTime(limit)}`,
      };
    case "not_before":
      if (occurrencesBefore === 0) return { pass: true };
      return {
        pass: false,
        reason: `${name} built before ${formatTime(limit)}`,
      };
    case "count_max": {
      const cap = Number(rule.count);
      if (occurrencesBefore <= cap) return { pass: true };
      return {
        pass: false,
        reason: `${name} ≤ ${cap} (got ${occurrencesBefore}) by ${formatTime(limit)}`,
      };
    }
    case "count_exact": {
      const target = Number(rule.count);
      if (occurrencesBefore === target) return { pass: true };
      return {
        pass: false,
        reason: `${name} = ${target} (got ${occurrencesBefore}) by ${formatTime(limit)}`,
      };
    }
    case "count_min": {
      const floor = Number(rule.count);
      if (occurrencesBefore >= floor) return { pass: true };
      return {
        pass: false,
        reason: `${name} ≥ ${floor} (got ${occurrencesBefore}) by ${formatTime(limit)}`,
      };
    }
    default:
      return { pass: false, reason: `unknown rule type: ${rule.type}` };
  }
}

/**
 * Evaluate a list of rules against an event list. All rules must pass
 * for the build to "match". When exactly one rule fails the result is
 * an "almost match" with the failing rule surfaced.
 *
 * @param {ReadonlyArray<BuildRule>} rules
 * @param {ReadonlyArray<ParsedEvent>} events
 * @returns {{ pass: boolean, almost: boolean, failedRule?: BuildRule, failedReason?: string }}
 */
function evaluateRules(rules, events) {
  if (!Array.isArray(rules) || rules.length === 0) {
    return { pass: true, almost: false };
  }
  /** @type {string[]} */
  const failures = [];
  /** @type {BuildRule|undefined} */
  let firstFailRule;
  for (const rule of rules) {
    const r = evaluateRule(rule, events);
    if (!r.pass) {
      if (failures.length === 0) firstFailRule = rule;
      failures.push(r.reason || "unknown");
    }
  }
  if (failures.length === 0) return { pass: true, almost: false };
  if (failures.length === 1) {
    return {
      pass: false,
      almost: true,
      failedRule: firstFailRule,
      failedReason: failures[0],
    };
  }
  return {
    pass: false,
    almost: false,
    failedRule: firstFailRule,
    failedReason: failures[0],
  };
}

/**
 * @param {number} sec
 * @returns {string}
 */
function formatTime(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r < 10 ? "0" + r : "" + r}`;
}

module.exports = { evaluateRule, evaluateRules, eventToken };
