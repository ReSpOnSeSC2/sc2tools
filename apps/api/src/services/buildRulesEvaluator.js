"use strict";

const { isProxyEligibleBuilding } = require("./knownBuildings");

/**
 * buildRulesEvaluator — Pure rule evaluator for v3 BuildEditor rules.
 *
 * Mirrors the SPA's preview-matches semantics. Given an array of parsed
 * events (the same shape `parseBuildLogLines` emits) and a list of
 * rules, returns whether all rules pass — and, if not, which one
 * failed, why, and how many matching events the game had before the
 * rule's time (`got` / `failedGot`, so the SPA can word the reason
 * itself). Used by the /v1/custom-builds/preview-matches and
 * /v1/custom-builds/reclassify endpoints.
 *
 * Rule types (schema v3), counting `name` events with time < `time_lt`:
 *   - "before"      : at least 1 (the same verdict as count_min 1)
 *   - "not_before"  : none
 *   - "count_max"   : at most `count`
 *   - "count_exact" : exactly `count`
 *   - "count_min"   : at least `count`
 *   - `proxy: true`  : optional modifier; count only structures classified
 *                      as proxied by the replay agent's canonical geometry
 *
 * Events must be at construction-START time (`eventsToStartTime`): the SPA
 * saves `time_lt` off the start-time timeline. The desktop evaluator
 * (apps/replay-engine/core/strategy_detector_base.py, `check_custom_rules`)
 * applies the same rewind and the same proxy geometry;
 * __tests__/customRuleParity.test.js and the engine's
 * tests/test_custom_rule_parity.py run one fixture through both.
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
 * whose legacy build-log rows look identical to real units. New structured
 * rows may carry `hallucinated: true`; this prerequisite heuristic is the
 * fallback when they do not. Without it, a 2-base Charge / Templar build can
 * register as a Phoenix Opener.
 *
 * Mirror of UNIT_TECH_PREREQUISITES in
 * reveal-sc2-opponent-main/core/strategy_detector.py and
 * apps/replay-engine/detectors/base.py — keep the three in sync.
 *
 * @type {Record<string, string[][]>}
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
  // Both Overlord morphs need a Lair; the Lair's own event stays in the
  // log after it becomes a Hive.
  Overseer: [["Lair"]],
  OverlordTransport: [["Lair"]],
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
  // Some ingestion paths can retain sc2reader's positive hallucination
  // signal. It is authoritative even when the player also owns the unit's
  // prerequisite structure; the structure heuristic below remains the
  // fallback for legacy build-log rows that cannot carry this metadata.
  if (ev.hallucinated === true) return false;
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
 *            name: string, time_lt: number, count?: number,
 *            proxy?: boolean}} BuildRule
 *
 * @typedef {{time: number, name: string, race?: string, category?: string,
 *            is_building?: boolean, is_proxy?: boolean,
 *            hallucinated?: boolean,
 *            proxy_classification_known?: boolean}} ParsedEvent
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
 * Count events whose token equals `name` with time strictly below
 * `limit`, applying the hallucination filter when the rule's token
 * has a known tech prerequisite.
 *
 * @param {ReadonlyArray<ParsedEvent>} events
 * @param {string} name
 * @param {number} limit
 * @param {Map<string, number> | undefined} prereqIndex Always defined
 *   when `ruleNeedsPrereq` is true (the caller builds it lazily).
 * @param {boolean} ruleNeedsPrereq
 * @param {boolean} proxyOnly
 * @returns {number}
 */
function _countMatches(
  events,
  name,
  limit,
  prereqIndex,
  ruleNeedsPrereq,
  proxyOnly,
) {
  let n = 0;
  for (const ev of events) {
    if (!ev) continue;
    const t = Number(ev.time);
    if (!Number.isFinite(t)) continue;
    if (t >= limit) continue;
    if (!matchesRuleEvent(ev, name, prereqIndex, ruleNeedsPrereq, proxyOnly)) continue;
    // Hallucination filter: drop unit events whose tech prerequisite
    // wasn't started by the unit's own time. Building/upgrade tokens
    // are unaffected because they are absent from
    // UNIT_TECH_PREREQUISITES.
    n++;
  }
  return n;
}

/** Shared eligibility for count verdicts and detailed evidence; callers own
 * the same strict-before window. No alternate token/prerequisite semantics.
 * @param {ParsedEvent} event @param {string} name
 * @param {Map<string,number>|undefined} index @param {boolean} needsPrereq
 * @param {boolean} proxyOnly */
function matchesRuleEvent(event, name, index, needsPrereq, proxyOnly) {
  return eventToken(event) === name && (!proxyOnly || event.is_proxy === true)
    && (!needsPrereq || _unitPrereqMet(event, /** @type {Map<string,number>} */ (index)));
}

/**
 * A counted rule's failure: a symbol-free fallback reason for clients
 * that cannot word it themselves, plus the count the game had (`got`).
 *   "BuildVoidRay: needs at least 4 before 10:00, had 1"
 *
 * @param {string} subject Raw token, or "{token} (proxied)".
 * @param {string} need "at least 4", "exactly 2", "at most 1", "none".
 * @param {number} limit The rule's `time_lt` in seconds.
 * @param {number} got Matching events before `limit`.
 * @returns {{ pass: false, reason: string, got: number }}
 */
function _countFailure(subject, need, limit, got) {
  return {
    pass: false,
    reason: `${subject}: needs ${need} before ${formatTime(limit)}, had ${got}`,
    got,
  };
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
 * @returns {{ pass: boolean, unavailable?: boolean, reason?: string, got?: number }}
 *   A pass is exactly `{ pass: true }`. `got` is set only when one of the
 *   five rule types fails on its count, never for invalid or unavailable
 *   rules.
 */
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
  const proxyOnly = rule.proxy === true;
  if (
    proxyOnly
    && (
      !/^Build[A-Za-z0-9]+$/.test(name)
      || !isProxyEligibleBuilding(name.slice("Build".length))
    )
  ) {
    return {
      pass: false,
      reason: `Proxy requirement is only valid for structure rules (${name})`,
    };
  }
  if (
    proxyOnly
    && (
      !events.some((event) => event?.is_building === true)
      || events.some((event) => (
        event?.is_building === true
        && event?.proxy_classification_known !== true
      ))
    )
  ) {
    return {
      pass: false,
      unavailable: true,
      reason: `Proxy classification unavailable for ${name}`,
    };
  }
  if (
    proxyOnly
    && events.some((event) => (
      event?.is_building === true
      && typeof event.is_proxy !== "boolean"
      && Number(event.time) < limit
      && eventToken(event) === name
    ))
  ) {
    // A structure this rule would count that an older agent's stamp cannot
    // settle (see proxyClassification.js): unknown, not a guess.
    return {
      pass: false,
      unavailable: true,
      reason: `Proxy classification unavailable for ${name}`,
    };
  }
  const occurrencesBefore = _countMatches(
    events,
    name,
    limit,
    idx,
    needsPrereq,
    proxyOnly,
  );
  const subject = proxyOnly ? `${name} (proxied)` : name;
  /** @param {string} need */
  const fail = (need) => _countFailure(subject, need, limit, occurrencesBefore);
  switch (rule.type) {
    case "before":
      if (occurrencesBefore >= 1) return { pass: true };
      return fail("at least 1");
    case "not_before":
      if (occurrencesBefore === 0) return { pass: true };
      return fail("none");
    case "count_max": {
      const cap = Number(rule.count);
      if (occurrencesBefore <= cap) return { pass: true };
      return fail(`at most ${cap}`);
    }
    case "count_exact": {
      const target = Number(rule.count);
      if (occurrencesBefore === target) return { pass: true };
      return fail(`exactly ${target}`);
    }
    case "count_min": {
      const floor = Number(rule.count);
      if (occurrencesBefore >= floor) return { pass: true };
      return fail(`at least ${floor}`);
    }
    default:
      return { pass: false, reason: `unknown rule type: ${rule.type}` };
  }
}

/**
 * Evaluate a list of rules against an event list. All rules must pass
 * for the build to "match". When exactly one rule fails the result is
 * an "almost match" with the failing rule surfaced. `failedRule` is the
 * same object as the entry in `rules`, so callers can find its index;
 * `failedGot` is that rule's `got` when it failed on its count.
 * `passedCount` / `ruleCount` say how close a near-miss came (the build
 * check-in suggestion ranks custom builds by that ratio); a rule whose
 * evidence is unavailable does not count as passed.
 *
 * @param {ReadonlyArray<BuildRule>} rules
 * @param {ReadonlyArray<ParsedEvent>} events
 * @returns {{ pass: boolean, almost: boolean, passedCount: number, ruleCount: number, unavailable?: boolean, failedRule?: BuildRule, failedReason?: string, failedGot?: number }}
 */
function evaluateRules(rules, events) {
  if (!Array.isArray(rules) || rules.length === 0) {
    return { pass: true, almost: false, passedCount: 0, ruleCount: 0 };
  }
  const ruleCount = rules.length;
  let passedCount = 0;
  /** @type {string[]} */
  const failures = [];
  /** @type {BuildRule|undefined} */
  let firstFailRule;
  /** @type {number|undefined} */
  let firstFailGot;
  /** @type {BuildRule|undefined} */
  let firstUnavailableRule;
  let firstUnavailableReason;
  // Build the structure-time index once; every rule reuses it.
  const earliestBuilds = _earliestBuildTimes(events);
  for (const rule of rules) {
    const r = evaluateRule(rule, events, earliestBuilds);
    if (r.pass) {
      passedCount += 1;
    } else {
      if (r.unavailable === true) {
        if (!firstUnavailableRule) {
          firstUnavailableRule = rule;
          firstUnavailableReason = r.reason || "unknown";
        }
        continue;
      }
      if (failures.length === 0) {
        firstFailRule = rule;
        firstFailGot = r.got;
      }
      failures.push(r.reason || "unknown");
    }
  }
  if (failures.length === 0 && firstUnavailableRule) {
    return {
      pass: false,
      almost: false,
      passedCount,
      ruleCount,
      unavailable: true,
      failedRule: firstUnavailableRule,
      failedReason: firstUnavailableReason,
    };
  }
  if (failures.length === 0) return { pass: true, almost: false, passedCount, ruleCount };
  return {
    pass: false,
    almost: failures.length === 1,
    passedCount,
    ruleCount,
    failedRule: firstFailRule,
    failedReason: failures[0],
    ...(typeof firstFailGot === "number" ? { failedGot: firstFailGot } : {}),
  };
}

/** Add evidence without changing any existing classifier verdict. Missing
 * extraction differs from a valid empty event list. An incomplete set has no
 * overall percentage: an unavailable rule is never a failed rule.
 * @param {ReadonlyArray<BuildRule>} rules
 * @param {ReadonlyArray<ParsedEvent>|null} events
 * @param {boolean} [available] */
function evaluateRulesDetailed(rules, events, available = Array.isArray(events)) {
  const source = Array.isArray(events) ? events : [];
  const index = _earliestBuildTimes(source);
  const rows = (Array.isArray(rules) ? rules : []).map((rule, position) => {
    const verdict = evaluateRule(rule, source, index);
    const valid = !!rule && SIG_TOKEN_REGEX.test(String(rule.name || ""))
      && ["before", "not_before", "count_min", "count_max", "count_exact"].includes(rule.type)
      && Number.isFinite(rule.time_lt) && rule.time_lt > 0
      && (["before", "not_before"].includes(rule.type) || Number.isInteger(rule.count) && Number(rule.count) >= 0);
    const unknown = !available || !valid || verdict.unavailable === true
      || !verdict.pass && verdict.got === undefined;
    const need = valid ? rule.type === "before" ? 1 : rule.type === "not_before" ? 0 : Number(rule.count) : null;
    const times = unknown ? [] : source.filter(event => event && Number.isFinite(Number(event.time))
      && Number(event.time) < rule.time_lt
      && matchesRuleEvent(event, rule.name, index, Object.hasOwn(UNIT_TECH_PREREQUISITES, _bareNoun(rule.name)), rule.proxy === true))
      .map(event => Number(event.time)).sort((a, b) => a - b);
    const got = unknown ? null : times.length;
    // A minimum is established at its nth eligible event. An excess is
    // established at the first disallowed event. Absence/shortfall and upper
    // bound success are window claims; their chips explicitly say Deadline.
    let eventAt;
    if (!unknown && need !== null) {
      if (verdict.pass && (rule.type === "before" || rule.type === "count_min")) eventAt = times[Math.max(0, need - 1)];
      else if (!verdict.pass && got !== null && got > need) eventAt = times[need];
    }
    const operator = rule?.type === "not_before" ? "none" : rule?.type === "count_max" ? `at most ${need}`
      : rule?.type === "count_exact" ? `exactly ${need}` : `at least ${need}`;
    const subject = valid ? rule.name.replace(VERB_PREFIX_RE, "").replace(/([a-z])([A-Z])/g, "$1 $2") : "Rule";
    return { index: position, name: valid ? rule.name : "", type: valid ? rule.type : "unknown", proxy: rule?.proxy === true,
      sentence: unknown ? `${subject}: evidence unavailable` : `${subject}${rule.proxy ? " (proxied)" : ""}: needed ${operator} before ${formatTime(rule.time_lt)}; had ${got}`,
      pass: !unknown && verdict.pass, unavailable: unknown, got, need,
      deadlineSec: valid ? rule.time_lt : null,
      evidenceSec: unknown ? null : eventAt ?? rule.time_lt,
      evidenceKind: unknown ? null : eventAt === undefined ? "deadline" : "event" };
  });
  const knownCount = rows.filter(row => !row.unavailable).length;
  const passedCount = rows.filter(row => row.pass).length;
  return { rules: rows, passedCount, knownCount, ruleCount: rows.length,
    matchPct: rows.length > 0 && knownCount === rows.length ? 100 * passedCount / rows.length : null };
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
  evaluateRulesDetailed,
  eventToken,
  UNIT_TECH_PREREQUISITES,
};
