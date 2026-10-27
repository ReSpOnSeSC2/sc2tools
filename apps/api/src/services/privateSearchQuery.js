"use strict";

// Bounded owner/_id search shapes, verified against proposal02 (6209087f...).
// No DDL or fallback: absent fixed indices make the group unavailable.
const HINTS = Object.freeze({ opponents: "b2_probe_owner_id_v1",
  customBuilds: "admin_custom_build_catalog", games: "b2_probe_owner_id_v1" });
/** @typedef {import("mongodb").Document} Expression */
/** @typedef {{collection:string,pipeline:Expression[],options:import('mongodb').AggregateOptions,
 * kind:string,sourceOwnerMaximum:number,sourceLimit:number,resultLimit:number,visibleLimit:number}} SearchShape */
const { hasControls, hasUnpairedSurrogates } = require("./privateSearchText");
const { validId: validIdentifier } = require("./privateSearchText");
const OWNER_ROWS = 4096;
const SOURCE_LIMIT = OWNER_ROWS + 1; // NEW experimental sentinel bound, not old admission.
const RESULT_LIMIT = 9;
const VISIBLE_LIMIT = 8;
const MAX_DATE_MS = 8640000000000000;
const BASE_OPTIONS = Object.freeze({
  maxTimeMS: 300, allowDiskUse: false, collation: { locale: "simple" }, batchSize: 1,
});
const CONTROL = "[\\x00-\\x1f\\x7f-\\x9f]"; // Full Unicode Cc: C0 plus C1.
const ASTRAL = "[\\x{10000}-\\x{10FFFF}]";
/** @param {string} value */
const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** @param {string} query */
const prefix = query => new RegExp("^" + escaped(query), "i");
/** @param {unknown} value */
const literal = value => ({ $literal: value });
/** @param {string} field @param {string} type */
const isType = (field, type) => ({ $eq: [{ $type: field }, type] });
/** @param {...unknown} values */
const both = (...values) => ({ $and: values });
/** @param {unknown} value */
const not = value => ({ $not: [value] });
/** @param {string} field */
const safeString = field => ({ $cond: [isType(field, "string"), field, ""] });

// Guard before strLenCP: legacy arrays/objects must not throw or be expanded.
// Keep the original value, never a truncated valid-looking destination label.
/** @param {string} field @param {number} max */
function bounded(field, max) {
  return { $cond: [isType(field, "string"), {
    $cond: [{ $lte: [{ $strLenCP: field }, max] }, field, null],
  }, null] };
}

// UTF-16 units = code points + astral code points, for valid BSON UTF-8 strings.
// Run only on already bounded scalar projections. This fixed PCRE expression
// is metadata validation, not query normalization. Its Mongo 7 behavior still
// needs explicit synthetic astral/boundary evidence before any admission.
/** @param {string} field @param {number} max @param {boolean} [required] */
function validText(field, max, required = true) {
  const value = safeString(field);
  const length = { $strLenCP: value };
  const units = { $add: [length, { $size: { $regexFindAll: { input: value, regex: ASTRAL } } }] };
  const present = both(isType(field, "string"), { $lte: [units, max] },
    not({ $regexMatch: { input: value, regex: CONTROL } }),
    ...(required ? [{ $gt: [length, 0] }] : []));
  return required ? present : { $or: [{ $eq: [field, null] }, present] };
}

/** @param {string} field @param {number} max */
function validId(field, max) {
  return both(validText(field, max), not({ $in: [field, [".", ".."]] }));
}

/** @param {string} field */
function validDate(field) {
  const ms = { $convert: { input: field, to: "long", onError: null, onNull: null } };
  return both(isType(field, "date"), { $gte: [ms, -MAX_DATE_MS] }, { $lte: [ms, MAX_DATE_MS] });
}
/** @param {string} field */
const dateOrNull = field => ({ $cond: [validDate(field), field, null] });
/** @param {string} field */
const projectedOptionalDate = field => ({ $or: [{ $eq: [field, null] }, validDate(field)] });
/** @param {string} owner */
const ownerValid = owner => both(isType("$userId", "string"), { $eq: ["$userId", literal(owner)] });

// Only missing/null/bool flags are understood. Arrays or other legacy flag
// types are explicit invalid-scope data, never silently treated as eligible.
/** @param {string} field */
const validFlag = field => ({ $in: [{ $type: field }, ["missing", "null", "bool"]] });
/** @param {string} field */
const flagNotTrue = field => ({ $ne: [{ $ifNull: [field, null] }, true] });

/** @param {string} owner @param {string} query */
function validateInput(owner, query) {
  if (typeof owner !== "string" || !owner || owner.length > 200
    || hasControls(owner) || hasUnpairedSurrogates(owner)) {
    throw new TypeError("invalid_owner");
  }
  if (typeof query !== "string" || query !== query.trim() || hasControls(query) || hasUnpairedSurrogates(query)) {
    throw new TypeError("invalid_query");
  }
  const points = Array.from(query);
  if (points.length < 2 || points.length > 80) {
    throw new TypeError("invalid_query");
  }
  // At most 80 valid Unicode code points implies at most 320 UTF-8 bytes.
}

/** @param {keyof typeof HINTS} collection */
function hintFor(collection) {
  const name = HINTS[collection];
  if (!name) throw new TypeError("unsupported_collection");
  return name;
}

/** @param {unknown} condition */
function invalidWhen(condition) { return { $sum: { $cond: [condition, 1, 0] } }; }

function sourceMetadata() {
  const eligible = both("$_ownerValid", "$_scopeValid", "$_eligible");
  return [{ $group: {
    _id: null,
    sourceCount: { $sum: 1 },
    invalidOwner: invalidWhen(not("$_ownerValid")),
    invalidScope: invalidWhen(both("$_ownerValid", not("$_scopeValid"))),
    invalidRequired: invalidWhen(both(eligible, not("$_requiredValid"))),
    invalidDate: invalidWhen(both(eligible, not("$_dateValid"))),
    invalidOptional: invalidWhen(both(eligible, not("$_optionalValid"))),
  } }, { $project: {
    _id: 0, sourceCount: 1, invalidOwner: 1, invalidScope: 1,
    invalidRequired: 1, invalidDate: 1, invalidOptional: 1,
  } }];
}

/** @param {keyof typeof HINTS} collection @param {Expression} projection
 * @param {Expression} validation @param {Expression[]} matches @param {string} owner
 * @returns {SearchShape} */
function makeShape(collection, projection, validation, matches, owner) {
  return {
    collection, kind: "aggregate",
    sourceOwnerMaximum: OWNER_ROWS, sourceLimit: SOURCE_LIMIT,
    resultLimit: RESULT_LIMIT, visibleLimit: VISIBLE_LIMIT,
    pipeline: [
      // Array userId may match here; scalar/exact-owner validation is AFTER cap.
      { $match: { userId: owner } },
      { $sort: { _id: 1 } },
      { $limit: SOURCE_LIMIT },
      { $project: { _id: 0, ...projection } },
      { $set: validation },
      { $facet: {
        source: sourceMetadata(),
        rows: [
          { $match: { $expr: both("$_ownerValid", "$_scopeValid", "$_eligible",
            "$_requiredValid", "$_dateValid", "$_optionalValid") } },
          ...matches,
        ],
      } },
      { $project: { _id: 0, source: 1, rows: 1 } },
    ],
    options: { ...BASE_OPTIONS, hint: hintFor(collection) },
  };
}

/** @param {string} owner @param {string} query */
function opponents(owner, query) {
  validateInput(owner, query);
  return makeShape("opponents", {
    _ownerValid: ownerValid(owner), _scopeValid: literal(true), _eligible: literal(true),
    pulseId: bounded("$pulseId", 64), displayNameSample: bounded("$displayNameSample", 200),
    race: bounded("$race", 16), lastSeen: dateOrNull("$lastSeen"),
  }, {
    _requiredValid: both(validId("$pulseId", 64), validText("$displayNameSample", 200)),
    _dateValid: projectedOptionalDate("$lastSeen"), _optionalValid: validText("$race", 16, false),
  }, [
    { $match: { displayNameSample: prefix(query) } },
    { $sort: { lastSeen: -1, pulseId: 1 } }, { $limit: RESULT_LIMIT },
    { $project: { _id: 0, pulseId: 1, displayNameSample: 1, race: 1, lastSeen: 1 } },
  ], owner);
}

/** @param {string} owner @param {string} query */
function customBuilds(owner, query) {
  validateInput(owner, query);
  return makeShape("customBuilds", {
    _ownerValid: ownerValid(owner), _scopeValid: literal(true),
    _eligible: isType("$deletedAt", "missing"),
    slug: bounded("$slug", 120), name: bounded("$name", 200),
    race: bounded("$race", 16), vsRace: bounded("$vsRace", 16),
    perspective: bounded("$perspective", 16), updatedAt: dateOrNull("$updatedAt"),
  }, {
    _requiredValid: both(validId("$slug", 120), validText("$name", 200)),
    _dateValid: projectedOptionalDate("$updatedAt"),
    _optionalValid: both(validText("$race", 16, false), validText("$vsRace", 16, false),
      validText("$perspective", 16, false)),
  }, [
    { $match: { name: prefix(query) } },
    { $sort: { updatedAt: -1, slug: 1 } }, { $limit: RESULT_LIMIT },
    { $project: { _id: 0, slug: 1, name: 1, race: 1, vsRace: 1, perspective: 1, updatedAt: 1 } },
  ], owner);
}

/** @param {string} owner @param {string} query */
function maps(owner, query) {
  validateInput(owner, query);
  const flags = ["$isResumedFromReplay", "$_deleted", "$_deletionPending", "$excluded"];
  return makeShape("games", {
    _ownerValid: ownerValid(owner),
    _scopeValid: both(...flags.map(validFlag)),
    _eligible: both(...flags.map(flagNotTrue)),
    map: bounded("$map", 200),
  }, {
    _requiredValid: validText("$map", 200), _dateValid: literal(true), _optionalValid: literal(true),
  }, [
    { $match: { map: prefix(query) } },
    { $group: { _id: "$map" } }, { $sort: { _id: 1 } }, { $limit: RESULT_LIMIT },
    { $project: { _id: 0, map: "$_id" } },
  ], owner);
}

/** Fresh selected-ID projection, including the ninth sentinel. The actual
 * identity and publication plans are checked by the app integration tests.
 * @param {'opponents'|'customBuilds'} group @param {string} owner @param {string} query
 * @param {string[]} ids @returns {SearchShape} */
function publication(group, owner, query, ids) {
  const maximum = group === "opponents" ? 64 : 120;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > RESULT_LIMIT
    || ids.some(id => !validIdentifier(id, maximum)) || new Set(ids).size !== ids.length) {
    throw new TypeError("invalid_data");
  }
  const shape = group === "opponents" ? opponents(owner, query) : customBuilds(owner, query);
  const field = group === "opponents" ? "pulseId" : "slug";
  shape.pipeline.splice(0, 3, { $match: { userId: owner, [field]: { $in: ids } } }, { $limit: 10 });
  shape.options.hint = group === "opponents" ? "userId_1_pulseId_1" : "userId_1_slug_1";
  shape.sourceLimit = 10;
  return shape;
}

module.exports = { OWNER_ROWS, SOURCE_LIMIT, RESULT_LIMIT, VISIBLE_LIMIT,
  BASE_OPTIONS, opponents, customBuilds, maps, publication };
