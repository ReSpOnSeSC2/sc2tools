"use strict";

const { createHash } = require("crypto");
const { toStartSeconds } = require("./buildDurations");
const { UNIT_TECH_PREREQUISITES } = require("./buildRulesEvaluator");
const { isProxyEligibleBuilding } = require("./knownBuildings");
const catalog = require("../config/presetCatalog.json");
const NAMES = new Set(catalog.definitions.map((entry) => entry.name));
const SCHEMA_VERSION = 1;
const EVALUATOR_VERSION = 1;

/** @param {any} value @returns {any} */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
/** @param {any} value */
function policyHash(value) {
  const payload = { ...value }; delete payload.hash;
  return createHash("sha256").update(JSON.stringify(canonical(payload)), "utf8").digest("hex");
}
/** @param {string} code @returns {never} */
function invalid(code) { throw Object.assign(new Error(code), { code, status: 400 }); }
/** @param {any} value @param {string[]} required @param {string[]} [optional] */
function keys(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value) || required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) invalid("invalid_policy_fields");
}
/** @param {any} value @param {number} [max] */
function integer(value, max = 86400) { if (!Number.isSafeInteger(value) || value < 0 || value > max) invalid("invalid_policy_integer"); }
/** @param {any} value @param {number} max @param {number} [min] */
function text(value, max, min = 0) {
  if (typeof value !== "string" || [...value].length < min || [...value].length > max || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) invalid("invalid_policy_text");
}
/** @param {any} value */
function identifier(value) { if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9]{0,79}$/.test(value)) invalid("invalid_policy_entity"); }
/** @param {any} rule */
function validateCondition(rule) {
  if (rule?.kind === "count") {
    keys(rule, ["kind", "name", "category", "clock", "beforeSeconds"], ["min", "max", "proxy"]);
    identifier(rule.name); integer(rule.beforeSeconds);
    if (!Object.hasOwn(rule, "min") && !Object.hasOwn(rule, "max")) invalid("missing_policy_count");
    for (const key of ["min", "max"]) if (Object.hasOwn(rule, key)) integer(rule[key], 1000);
    if ((rule.min ?? 0) > (rule.max ?? 1000)) invalid("invalid_policy_count");
    if (Object.hasOwn(rule, "proxy") && (rule.proxy !== true || rule.category !== "building" || !isProxyEligibleBuilding(rule.name))) invalid("invalid_policy_proxy");
  } else if (rule?.kind === "order" || rule?.kind === "first") {
    keys(rule, ["kind", "names", "category", "clock"]);
    if (!Array.isArray(rule.names) || rule.names.length < 2 || rule.names.length > 8 || new Set(rule.names).size !== rule.names.length) invalid("invalid_policy_order");
    rule.names.forEach(identifier);
  } else invalid("unknown_policy_condition");
  if (!["building", "unit", "upgrade"].includes(rule.category) || !["start", "completion"].includes(rule.clock)) invalid("invalid_policy_clock");
  if (rule.clock === "completion" && rule.category === "building") invalid("building_completion_unavailable");
}
/** @param {any} value @param {boolean} [verifyHash] @returns {any} */
function validatePolicy(value, verifyHash = true) {
  keys(value, ["schemaVersion", "evaluatorVersion", "revision", "entries"], ["hash"]);
  if (value.schemaVersion !== SCHEMA_VERSION || value.evaluatorVersion !== EVALUATOR_VERSION) invalid("incompatible_policy");
  integer(value.revision, 2147483647);
  if (!Array.isArray(value.entries) || value.entries.length > 512) invalid("invalid_policy_entries");
  const seen = new Set(); let total = 0;
  for (const entry of value.entries) {
    keys(entry, ["name", "priority", "enabled", "anyOf"], ["description", "steps", "mode"]);
    if (!NAMES.has(entry.name) || seen.has(entry.name)) invalid("unknown_or_duplicate_preset");
    seen.add(entry.name); integer(entry.priority, 1000000);
    if (typeof entry.enabled !== "boolean") invalid("invalid_policy_enabled");
    if (Object.hasOwn(entry, "description")) text(entry.description, 4000);
    if (Object.hasOwn(entry, "steps")) {
      if (!Array.isArray(entry.steps) || entry.steps.length > 200) invalid("invalid_policy_steps");
      for (const step of entry.steps) {
        keys(step, ["timeSeconds", "action"], ["supply"]);
        integer(step.timeSeconds); text(step.action, 280, 1);
        if (Object.hasOwn(step, "supply")) integer(step.supply, 1000);
      }
    }
    if (entry.mode !== undefined && !["replacement", "released"].includes(entry.mode)) invalid("invalid_policy_mode");
    if (entry.mode === "released" && (entry.enabled !== true || !Array.isArray(entry.anyOf) || entry.anyOf.length !== 0)) invalid("invalid_released_policy");
    if (!Array.isArray(entry.anyOf) || entry.enabled && entry.mode !== "released" && !entry.anyOf.length || entry.anyOf.length > 8) invalid("invalid_policy_alternatives");
    for (const group of entry.anyOf) {
      if (!Array.isArray(group) || !group.length || group.length > 30) invalid("invalid_policy_conditions");
      total += group.length; if (total > 4096) invalid("policy_too_complex");
      group.forEach(validateCondition);
    }
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 1048576) invalid("policy_too_large");
  const hash = policyHash(value);
  if (verifyHash && value.hash !== hash) invalid("policy_hash_mismatch");
  return { ...structuredClone(value), hash };
}

/** Raw recorded extractor/build-log timestamps only. Never feed a rewound timeline.
 * @param {any[]} events @param {any} [game] */
function prepare(events, game) {
  /** @type {Map<string,any[]>} */ const index = new Map();
  const buildings = events.filter((event) => event.type === "building" || event.is_building === true || event.category === "building");
  const main = buildings.filter((event) => ["Nexus", "Hatchery", "CommandCenter", "OrbitalCommand", "PlanetaryFortress"].includes(event.name)).sort((a, b) => a.time - b.time)[0];
  /** @type {Map<string,number>} */ const earliest = new Map();
  for (const event of buildings) {
    if (!Number.isFinite(event.time) || event.time < 0) continue;
    const started = toStartSeconds(event.name, event.time, { isBuilding: true, game });
    earliest.set(event.name, Math.min(earliest.get(event.name) ?? Infinity, started));
  }
  for (const event of events) {
    if (!event || typeof event.name !== "string" || !Number.isFinite(event.time) || event.time < 0) continue;
    const category = event.is_building === true ? "building" : event.type === "worker" ? "unit" : event.type || event.category;
    if (category === "building" && event.subtype && !["init", "morph"].includes(event.subtype) && !(event.time === 0 && ["Nexus", "CommandCenter", "Hatchery"].includes(event.name))) continue;
    if (category === "unit") {
      if (event.hallucinated === true) continue;
      const prereqs = UNIT_TECH_PREREQUISITES[event.name];
      if (prereqs && !prereqs.some((set) => set.every((name) => (earliest.get(name) ?? Infinity) <= event.time))) continue;
    }
    const key = `${category}:${event.name}`;
    if (!index.has(key)) index.set(key, []);
    index.get(key)?.push(event);
  }
  /** @type {Map<string,number[]|null>} */ const cache = new Map();
  /** @param {any} rule @param {string} name */
  return (rule, name) => {
    const key = `${rule.category}:${name}:${rule.clock}:${Boolean(rule.proxy)}`;
    if (!cache.has(key)) {
      const moments = [];
      for (const event of index.get(`${rule.category}:${name}`) || []) {
        if (rule.proxy) {
          let proxy = event.is_proxy;
          if (typeof proxy !== "boolean") {
            if (!main || ![main.x, main.y, event.x, event.y].every((value) => typeof value === "number" && Number.isFinite(value))) { cache.set(key, null); return null; }
            const far = ["Nexus", "Hatchery", "CommandCenter", "OrbitalCommand", "PlanetaryFortress", "Assimilator", "Extractor", "Refinery", "SpineCrawler", "SporeCrawler"].includes(name);
            proxy = Math.hypot(event.x - main.x, event.y - main.y) > (far ? 80 : 50);
          }
          if (!isProxyEligibleBuilding(name) || !proxy) continue;
        }
        moments.push(rule.clock === "completion" ? event.time : toStartSeconds(name, event.time, { isBuilding: rule.category === "building", category: rule.category, game }));
      }
      cache.set(key, moments);
    }
    return cache.get(key) ?? (cache.has(key) ? null : []);
  };
}
/** @param {any[]} conditions @param {ReturnType<typeof prepare>} times */
function evaluateConditions(conditions, times) {
  for (const rule of conditions) {
    if (rule.kind === "count") {
      const moments = times(rule, rule.name); if (moments === null) return false;
      const got = moments.filter((time) => time <= rule.beforeSeconds).length;
      if (got < (rule.min ?? 0) || got > (rule.max ?? Infinity)) return false;
    } else {
      const moments = rule.names.map((/** @type {string} */ name) => times(rule, name));
      if (moments.some((/** @type {number[]|null} */ values) => values === null)) return false;
      const earliest = moments.map((/** @type {number[]} */ values) => Math.min(...values));
      if (rule.kind === "first") {
        if (!Number.isFinite(earliest[0]) || earliest.slice(1).some((/** @type {number} */ value) => earliest[0] > value)) return false;
      } else if (earliest.some((/** @type {number} */ value) => !Number.isFinite(value)) || earliest.slice(1).some((/** @type {number} */ value, /** @type {number} */ i) => earliest[i] >= value)) return false;
    }
  }
  return true;
}
/** @param {string} name */
function presetScope(name) {
  const prefix = name.split(" - ", 1)[0];
  /** @type {Record<string,string>} */
  const races = { P: "Protoss", T: "Terran", Z: "Zerg" };
  if (/^[PTZ]v[PTZ]$/.test(prefix)) return [races[prefix[0]], races[prefix[2]]];
  return [prefix, null];
}
/** Call after private custom-rule precedence, using the detector label (never a check-in's display label).
 * @param {any} policy @param {string} baseline @param {string} race @param {string|null} opponentRace @param {any[]} events @param {any} [game] */
function applyPolicy(policy, baseline, race, opponentRace, events, game) {
  const times = prepare(events, game);
  const entries = [...policy.entries].sort((a, b) => a.priority - b.priority || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const [holder, partner] = presetScope(entry.name);
    if (holder !== race || partner !== null && partner !== opponentRace || !entry.enabled || entry.mode === "released") continue;
    if (entry.anyOf.some((/** @type {any[]} */ group) => evaluateConditions(group, times))) return entry.name;
  }
  return entries.some((entry) => entry.name === baseline && entry.mode !== "released") ? `Unclassified - ${race}` : baseline;
}
const BUNDLED_POLICY = validatePolicy({ schemaVersion: 1, evaluatorVersion: 1, revision: 0, entries: [] }, false);
module.exports = { SCHEMA_VERSION, EVALUATOR_VERSION, BUNDLED_POLICY, catalog, policyHash, validatePolicy, applyPolicy, evaluateConditions, prepare, presetScope };
