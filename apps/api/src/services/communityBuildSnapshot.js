"use strict";

const {
  SIGNATURE_MAX_ITEMS,
  RULES_MAX_ITEMS,
  STRATEGY_NOTES_MAX_ITEMS,
  LEGACY_STEPS_MAX_ITEMS,
} = require("../validation/customBuild");

/**
 * Helpers for turning a private custom-build doc into the public copy
 * stored in the community collection. Extracted from community.js so the
 * service file stays under the 800-line cap and the
 * what's-safe-to-publish whitelist lives in one obvious place.
 */

/**
 * Fields from a private custom-build doc that are safe to expose on the
 * public community copy. A whitelist (not a blacklist) so a newly-added
 * private field can never silently leak into the public snapshot:
 * anything not listed here is dropped. Notably absent — ``notes``
 * (personal scouting notes), ``sourceGameId`` (links to a private
 * replay), ``userId`` / ``_id`` (internal), the private build ``slug``,
 * and the share/visibility flags (``isPublic`` /
 * ``shareWithCommunity``). The public community document has its own
 * stable slug outside this nested snapshot.
 */
const PUBLIC_BUILD_FIELDS = Object.freeze([
  "name",
  "race",
  "vsRace",
  "matchup",
  "description",
  "signature",
  "rules",
  "schemaVersion",
  "skillLevel",
  "winConditions",
  "losesTo",
  "transitionsInto",
  "perspective",
  "steps",
]);

const PUBLIC_BUILD_LEAF_FIELDS = Object.freeze([
  "name",
  "race",
  "vsRace",
  "matchup",
  "description",
  "signature.unit",
  "signature.count",
  "signature.beforeSec",
  "signature.proxy",
  "rules.type",
  "rules.name",
  "rules.time_lt",
  "rules.count",
  "rules.proxy",
  "schemaVersion",
  "skillLevel",
  "winConditions",
  "losesTo",
  "transitionsInto",
  "perspective",
  "steps.supply",
  "steps.time",
  "steps.action",
]);

const RACES = new Set(["Protoss", "Terran", "Zerg", "Random"]);
const VS_RACES = new Set([...RACES, "Any"]);
const PERSPECTIVES = new Set(["you", "opponent"]);
const SKILL_LEVELS = new Set([
  "bronze",
  "silver",
  "gold",
  "platinum",
  "diamond",
  "master",
  "grandmaster",
]);
const RULE_TYPES = new Set([
  "before",
  "not_before",
  "count_max",
  "count_exact",
  "count_min",
]);

/**
 * Build the public snapshot stored under a community build's ``build``
 * field. See {@link PUBLIC_BUILD_FIELDS}.
 *
 * @param {Record<string, any>} priv
 * @returns {Record<string, any>}
 */
function publicBuildSnapshot(priv) {
  /** @type {Record<string, any>} */
  const out = {};
  if (!priv || typeof priv !== "object") return out;
  copyString(out, "name", priv.name, 120);
  copyEnum(out, "race", priv.race, RACES);
  copyEnum(out, "vsRace", priv.vsRace, VS_RACES);
  copyString(out, "matchup", priv.matchup, 16);
  copyString(out, "description", priv.description, 4000);
  copyEnum(out, "perspective", priv.perspective, PERSPECTIVES);
  if (priv.skillLevel === null) out.skillLevel = null;
  else copyEnum(out, "skillLevel", priv.skillLevel, SKILL_LEVELS);
  if (Number.isInteger(priv.schemaVersion)
      && priv.schemaVersion >= 1 && priv.schemaVersion <= 10) {
    out.schemaVersion = priv.schemaVersion;
  }
  copySignature(out, priv.signature);
  copyRules(out, priv.rules);
  copyStringArray(out, "winConditions", priv.winConditions);
  copyStringArray(out, "losesTo", priv.losesTo);
  copyStringArray(out, "transitionsInto", priv.transitionsInto);
  copyLegacySteps(out, priv.steps);
  return out;
}

/**
 * Inclusion projection for a community document's nested build. Every path is
 * a leaf: Mongo never sends a legacy `build` object (or an unknown giant child
 * inside one of its array items) to the Node process.
 *
 * @param {string} [prefix]
 * @returns {Record<string, 1>}
 */
function publicBuildMongoLeafProjection(prefix = "build") {
  /** @type {Record<string, 1>} */
  const out = {};
  for (const leaf of PUBLIC_BUILD_LEAF_FIELDS) {
    out[prefix ? `${prefix}.${leaf}` : leaf] = 1;
  }
  return out;
}

/**
 * A bounded nested build expression for aggregation pipelines. Unlike
 * projecting `build: "$build"`, this maps only known item leaves and slices
 * arrays before Mongo returns the row to Node.
 *
 * @param {string} [path]
 * @returns {Record<string, any>}
 */
function publicBuildMongoExpression(path = "$build") {
  return {
    name: mongoBoundedString(`${path}.name`, 120),
    race: mongoBoundedString(`${path}.race`, 16),
    vsRace: mongoBoundedString(`${path}.vsRace`, 16),
    matchup: mongoBoundedString(`${path}.matchup`, 16),
    description: mongoBoundedString(`${path}.description`, 4000),
    signature: mongoObjectArray(
      `${path}.signature`,
      SIGNATURE_MAX_ITEMS,
      ["unit", "count", "beforeSec", "proxy"],
    ),
    rules: mongoObjectArray(
      `${path}.rules`,
      RULES_MAX_ITEMS,
      ["type", "name", "time_lt", "count", "proxy"],
    ),
    schemaVersion: mongoBoundedNumber(`${path}.schemaVersion`),
    skillLevel: mongoBoundedString(`${path}.skillLevel`, 32),
    winConditions: mongoScalarArray(
      `${path}.winConditions`,
      STRATEGY_NOTES_MAX_ITEMS,
    ),
    losesTo: mongoScalarArray(
      `${path}.losesTo`,
      STRATEGY_NOTES_MAX_ITEMS,
    ),
    transitionsInto: mongoScalarArray(
      `${path}.transitionsInto`,
      STRATEGY_NOTES_MAX_ITEMS,
    ),
    perspective: mongoBoundedString(`${path}.perspective`, 16),
    steps: mongoObjectArray(
      `${path}.steps`,
      LEGACY_STEPS_MAX_ITEMS,
      ["supply", "time", "action"],
    ),
  };
}

/** @param {string} path @param {number} max @param {readonly string[]} fields */
function mongoObjectArray(path, max, fields) {
  /** @type {Record<string, any>} */
  const item = {};
  for (const field of fields) {
    const leaf = `$$item.${field}`;
    switch (field) {
      case "unit":
      case "name":
        item[field] = mongoBoundedString(leaf, 80);
        break;
      case "type":
        item[field] = mongoBoundedString(leaf, 24);
        break;
      case "action":
        item[field] = mongoBoundedString(leaf, 280);
        break;
      case "time":
        item[field] = mongoBoundedStringOrNumber(leaf, 20);
        break;
      case "proxy":
        item[field] = mongoBoundedBoolean(leaf);
        break;
      default:
        item[field] = mongoBoundedNumber(leaf, field === "supply");
        break;
    }
  }
  return {
    $map: {
      input: boundedMongoArray(path, max),
      as: "item",
      in: item,
    },
  };
}

/** @param {string} path @param {number} max */
function mongoScalarArray(path, max) {
  return {
    $map: {
      input: boundedMongoArray(path, max),
      as: "item",
      in: mongoBoundedString("$$item", 280),
    },
  };
}

/** @param {string} path @param {number} max */
function boundedMongoArray(path, max) {
  return {
    $slice: [
      { $cond: [{ $isArray: path }, path, []] },
      max,
    ],
  };
}

/** @param {string} path @param {number} max */
function mongoBoundedString(path, max) {
  return {
    $cond: [
      { $eq: [{ $type: path }, "string"] },
      { $substrCP: [path, 0, max] },
      null,
    ],
  };
}

/** @param {string} path @param {boolean} [allowNull] */
function mongoBoundedNumber(path, allowNull = false) {
  return {
    $cond: [
      {
        $or: [
          { $in: [{ $type: path }, ["int", "long", "double", "decimal"]] },
          ...(allowNull ? [{ $eq: [{ $type: path }, "null"] }] : []),
        ],
      },
      path,
      null,
    ],
  };
}

/** @param {string} path */
function mongoBoundedBoolean(path) {
  return {
    $cond: [
      { $eq: [{ $type: path }, "bool"] },
      path,
      null,
    ],
  };
}

/** @param {string} path @param {number} max */
function mongoBoundedStringOrNumber(path, max) {
  return {
    $switch: {
      branches: [
        {
          case: { $eq: [{ $type: path }, "string"] },
          then: { $substrCP: [path, 0, max] },
        },
        {
          case: {
            $in: [{ $type: path }, ["int", "long", "double", "decimal"]],
          },
          then: path,
        },
      ],
      default: null,
    },
  };
}

/** @param {Record<string, any>} out @param {string} key @param {unknown} value @param {number} max */
function copyString(out, key, value, max) {
  const safe = boundedPublicString(value, max);
  if (safe !== undefined) out[key] = safe;
}

/** @param {Record<string, any>} out @param {string} key @param {unknown} value @param {Set<string>} values */
function copyEnum(out, key, value, values) {
  if (typeof value === "string" && values.has(value)) out[key] = value;
}

/**
 * Copy a bounded string into its own backing store. The Buffer round-trip is
 * deliberate: a substring view must not retain a legacy multi-megabyte value.
 * @param {unknown} value
 * @param {number} max
 */
function boundedPublicString(value, max) {
  if (typeof value !== "string") return undefined;
  return Buffer.from(value.slice(0, max), "utf8").toString("utf8");
}

/** @param {Record<string, any>} out @param {unknown} value */
function copySignature(out, value) {
  if (!Array.isArray(value)) return;
  const rows = [];
  for (let i = 0; i < Math.min(value.length, SIGNATURE_MAX_ITEMS); i += 1) {
    const raw = value[i];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    /** @type {Record<string, any>} */
    const row = {};
    copyString(row, "unit", raw.unit, 80);
    copyInteger(row, "count", raw.count, 1, 200);
    copyInteger(row, "beforeSec", raw.beforeSec, 0, 24 * 60 * 60);
    if (typeof raw.proxy === "boolean") row.proxy = raw.proxy;
    rows.push(row);
  }
  out.signature = rows;
}

/** @param {Record<string, any>} out @param {unknown} value */
function copyRules(out, value) {
  if (!Array.isArray(value)) return;
  const rows = [];
  for (let i = 0; i < Math.min(value.length, RULES_MAX_ITEMS); i += 1) {
    const raw = value[i];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    /** @type {Record<string, any>} */
    const row = {};
    copyEnum(row, "type", raw.type, RULE_TYPES);
    copyString(row, "name", raw.name, 80);
    copyInteger(row, "time_lt", raw.time_lt, 1, 1800);
    copyInteger(row, "count", raw.count, 0, 200);
    if (typeof raw.proxy === "boolean") row.proxy = raw.proxy;
    rows.push(row);
  }
  out.rules = rows;
}

/** @param {Record<string, any>} out @param {string} key @param {unknown} value */
function copyStringArray(out, key, value) {
  if (!Array.isArray(value)) return;
  const rows = [];
  for (let i = 0; i < Math.min(value.length, STRATEGY_NOTES_MAX_ITEMS); i += 1) {
    const safe = boundedPublicString(value[i], 280);
    if (safe !== undefined) rows.push(safe);
  }
  out[key] = rows;
}

/** @param {Record<string, any>} out @param {unknown} value */
function copyLegacySteps(out, value) {
  if (!Array.isArray(value)) return;
  const rows = [];
  for (let i = 0; i < Math.min(value.length, LEGACY_STEPS_MAX_ITEMS); i += 1) {
    const raw = value[i];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    /** @type {Record<string, any>} */
    const row = {};
    copyNumber(row, "supply", raw.supply, 0, 1000, true);
    if (typeof raw.time === "string") copyString(row, "time", raw.time, 20);
    else copyNumber(row, "time", raw.time, 0, 24 * 60 * 60, false);
    copyString(row, "action", raw.action, 280);
    rows.push(row);
  }
  out.steps = rows;
}

/** @param {Record<string, any>} out @param {string} key @param {unknown} value @param {number} min @param {number} max */
function copyInteger(out, key, value, min, max) {
  if (typeof value === "number" && Number.isInteger(value)
      && value >= min && value <= max) out[key] = value;
}

/** @param {Record<string, any>} out @param {string} key @param {unknown} value @param {number} min @param {number} max @param {boolean} allowNull */
function copyNumber(out, key, value, min, max, allowNull) {
  if (allowNull && value === null) {
    out[key] = null;
  } else if (typeof value === "number" && Number.isFinite(value)
      && value >= min && value <= max) {
    out[key] = value;
  }
}

/**
 * Derive a "PvT"-style matchup tag from a build's own race + target
 * race. v3 custom builds store ``race`` / ``vsRace`` rather than a
 * ``matchup`` string; without this the community listing's matchup
 * facet would be blank for every editor-authored build. Returns "" when
 * either side isn't a concrete race (e.g. vsRace "Any" or "Random"),
 * matching how the matchup filter treats unclassified rows.
 *
 * @param {string|undefined|null} race
 * @param {string|undefined|null} vsRace
 * @returns {string}
 */
function matchupFromRaces(race, vsRace) {
  const a = raceLetter(race);
  const b = raceLetter(vsRace);
  if (!a || !b) return "";
  return `${a}v${b}`;
}

/**
 * First letter of a concrete race (P/T/Z), or "" for
 * Random / Any / unknown — those don't define a matchup bucket.
 *
 * @param {string|undefined|null} race
 * @returns {string}
 */
function raceLetter(race) {
  if (typeof race !== "string") return "";
  const c = race.charAt(0).toUpperCase();
  return c === "P" || c === "T" || c === "Z" ? c : "";
}

module.exports = {
  PUBLIC_BUILD_FIELDS,
  PUBLIC_BUILD_LEAF_FIELDS,
  publicBuildSnapshot,
  publicBuildMongoLeafProjection,
  publicBuildMongoExpression,
  boundedPublicString,
  matchupFromRaces,
};
