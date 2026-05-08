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
const VERB_PREFIX_RE = /^(Build|Train|Research|Morph)(?=[A-Z])/;

/**
 * Anti-hallucination tech prerequisites.
 *
 * Maps a bare unit name to a list of alternative requirement-sets. A
 * unit event counts toward classification only when at least one
 * alternative is fully satisfied: every structure in that alternative
 * must have a `BuildX` token at or before the unit's own time. The
 * structure does NOT need to still be standing; a Stargate killed at
 * 5:00 still qualifies a Phoenix at 7:00 because the construction
 * event lives in the event log permanently.
 *
 * Why: a Sentry's Hallucination ability spawns illusory Phoenix /
 * VoidRay / HighTemplar / Archon / Immortal / Colossus / WarpPrism
 * that look identical to real units in the event log. Without this
 * filter, a 2-base Charge / Templar build can register as a Phoenix
 * Opener.
 *
 * Mirror of UNIT_TECH_PREREQUISITES in
 * reveal-sc2-opponent-main/core/strategy_detector.py and
 * SC2Replay-Analyzer/detectors/base.py — keep the three in sync.
 */
const UNIT_TECH_PREREQUISITES = {
  // Protoss Stargate path
  Phoenix: [["Stargate"]],
  Oracle: [["Stargate"]],
  VoidRay: [["Stargate"]],
  Carrier: [["Stargate", "FleetBeacon"]],
  Tempest: [["Stargate", "FleetBeacon"]],
  Mothership: [["Stargate", "FleetBeacon"]],
  // Protoss Robotics path
  Immortal: [["RoboticsFacility"]],
  Observer: [["RoboticsFacility"]],
  WarpPrism: [["RoboticsFacility"]],
  Colossus: [["RoboticsFacility", "RoboticsBay"]],
  Disruptor: [["RoboticsFacility", "RoboticsBay"]],
  // Protoss Templar path
  HighTemplar: [["TemplarArchive"]],
  DarkTemplar: [["DarkShrine"]],
  Archon: [["TemplarArchive"], ["DarkShrine"]],
  // Zerg
  Zergling: [["SpawningPool"]],
  Queen: [["SpawningPool"]],
  Baneling: [["BanelingNest"]],
  Roach: [["RoachWarren"]],
  Ravager: [["RoachWarren"]],
  Hydralisk: [["HydraliskDen"]],
  Lurker: [["LurkerDen"]],
  LurkerMP: [["LurkerDen"]],
  Mutalisk: [["Spire"]],
  Corruptor: [["Spire"]],
  BroodLord: [["GreaterSpire"]],
  Infestor: [["InfestationPit"]],
  SwarmHostMP: [["InfestationPit"]],
  Viper: [["Hive"]],
  Ultralisk: [["UltraliskCavern"]],
  // Terran
  Marine: [["Barracks"]],
  Reaper: [["Barracks"]],
  Marauder: [["Barracks"]],
  Ghost: [["Barracks", "GhostAcademy"]],
  Hellion: [["Factory"]],
  Hellbat: [["Factory", "Armory"]],
  Cyclone: [["Factory"]],
  WidowMine: [["Factory"]],
  SiegeTank: [["Factory"]],
  Thor: [["Factory", "Armory"]],
  Medivac: [["Starport"]],
  Liberator: [["Starport"]],
  Banshee: [["Starport"]],
  Raven: [["Starport"]],
  VikingFighter: [["Starport"]],
  Battlecruiser: [["Starport", "FusionCore"]],
};

/**
 * Strip a verb prefix (Build/Train/Research/Morph) from a token to
 * recover the bare noun. Returns the token unchanged when no
 * recognised verb prefix is present.
 *
 * @param {string} token
 * @returns {string}
 */
function _bareNoun(token) {
  if (typeof token !== "string") return "";
  return token.replace(VERB_PREFIX_RE, "");
}

/**
 * Index the earliest `Build<X>` time per structure name across `events`.
 * Used by the hallucination filter to ask "was this structure ever
 * started before this unit appeared?".
 *
 * @param {ReadonlyArray<ParsedEvent>} events
 * @returns {Map<string, number>}
 */
function _earliestBuildTimes(events) {
  /** @type {Map<string, number>} */
  const out = new Map();
  for (const ev of events) {
    if (!ev) continue;
    const t = Number(ev.time);
    if (!Number.isFinite(t)) continue;
    const tok = eventToken(ev);
    if (typeof tok !== "string") continue;
    if (!tok.startsWith("Build")) continue;
    const bare = tok.slice("Build".length);
    if (!bare) continue;
    const cur = out.get(bare);
    if (cur === undefined || t < cur) out.set(bare, t);
  }
  return out;
}

/**
 * Test whether a unit event is "real" given the structures present so
 * far. Returns true when the bare unit name has no known prerequisite
 * (we trust the event), or when at least one prerequisite alternative
 * is fully satisfied at the unit's own time.
 *
 * @param {ParsedEvent} ev
 * @param {Map<string, number>} earliestBuilds
 * @returns {boolean}
 */
function _unitPrereqMet(ev, earliestBuilds) {
  const tok = eventToken(ev);
  if (typeof tok !== "string") return true;
  const bare = _bareNoun(tok);
  const alternatives = UNIT_TECH_PREREQUISITES[bare];
  if (!alternatives) return true;
  const t = Number(ev.time);
  if (!Number.isFinite(t)) return true;
  return alternatives.some((reqSet) =>
    reqSet.every((req) => {
      const built = earliestBuilds.get(req);
      return built !== undefined && built <= t;
    }),
  );
}

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
 * @param {Map<string, number>} [earliestBuilds] Pre-computed earliest
 *   `Build<X>` time per structure. When provided, unit events whose
 *   tech prerequisite isn't satisfied at the event's own time are
 *   skipped (anti-hallucination filter). When absent, the index is
 *   built lazily here so direct callers still get the same behaviour.
 * @returns {{ pass: boolean, reason?: string }}
 */
function _countMatches(events, name, limit, prereqIndex, ruleNeedsPrereq) {
  let n = 0;
  for (const ev of events) {
    if (!ev) continue;
    const t = Number(ev.time);
    if (!Number.isFinite(t)) continue;
    if (t >= limit) continue;
    if (eventToken(ev) !== name) continue;
    // Hallucination filter: drop unit events whose tech prerequisite
    // wasn't started by the unit's own time. Building/upgrade tokens
    // are unaffected because they are absent from
    // UNIT_TECH_PREREQUISITES.
    if (ruleNeedsPrereq && !_unitPrereqMet(ev, prereqIndex)) continue;
    n++;
  }
  return n;
}

function evaluateRule(rule, events, earliestBuilds) {
  if (!rule || typeof rule !== "object") {
    return { pass: false, reason: "invalid rule" };
  }
  const name = String(rule.name || "");
  if (!SIG_TOKEN_REGEX.test(name)) {
    return { pass: false, reason: `bad rule name: ${name}` };
  }
  const limit = Number(rule.time_lt) || 0;
  // evaluateRules reuses a shared earliestBuilds index across rules;
  // direct callers get a lazy build inside _countMatches' caller.
  const needsPrereq = Object.prototype.hasOwnProperty.call(
    UNIT_TECH_PREREQUISITES, _bareNoun(name),
  );
  const idx = needsPrereq && !earliestBuilds ? _earliestBuildTimes(events) : earliestBuilds;
  const occurrencesBefore = _countMatches(events, name, limit, idx, needsPrereq);
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
  // Build the structure-time index once; every rule reuses it.
  const earliestBuilds = _earliestBuildTimes(events);
  for (const rule of rules) {
    const r = evaluateRule(rule, events, earliestBuilds);
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

module.exports = {
  evaluateRule,
  evaluateRules,
  eventToken,
  UNIT_TECH_PREREQUISITES,
};
