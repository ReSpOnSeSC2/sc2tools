"use strict";

// Adapted from reviewed owner/_id proposal02 (6209087f...). The strict public
// v2 projection is retained; validated all-nine candidates stay server-only.
const { validText, validId } = require("./privateSearchText");
const MAX_BYTES = 65536, MAX_SOURCE = 4097, SUPPORTED_SOURCE = 4096;
const RAW_ROWS = 9, VISIBLE_ROWS = 8, MAX_DATE_MS = 8640000000000000;
const GROUPS = ["opponents", "customBuilds", "maps"];
const COUNTERS = ["invalidOwner", "invalidScope", "invalidRequired", "invalidDate", "invalidOptional"];
const REASONS = ["source_budget_exceeded", "invalid_data", "deferred", "missing_access_path",
  "deadline", "busy", "retired"];
/** @type {Record<string,string[]>} */
const ROW_KEYS = { opponents: ["pulseId", "displayNameSample", "race", "lastSeen"],
  customBuilds: ["slug", "name", "race", "vsRace", "perspective", "updatedAt"], maps: ["map"] };
/** @typedef {Record<string,string|null>} Row */
/** @typedef {{value:Row,key:string,time:number|null}} CheckedRow */

/** @param {unknown} condition @returns {asserts condition} */
function check(condition) { if (!condition) throw new TypeError("invalid_data"); }
/** @param {string} reason */
const unavailable = reason => ({ status: "unavailable", reason, items: [], hasMore: null });

/** Exact own enumerable data fields only; no accessors or unknown keys.
 * @param {unknown} value @param {string[]} keys @returns {Record<string,unknown>} */
function record(value, keys) {
  check(value !== null && typeof value === "object" && !Array.isArray(value));
  const prototype = Object.getPrototypeOf(value);
  check(prototype === Object.prototype || prototype === null);
  const actual = Reflect.ownKeys(value);
  check(actual.length === keys.length && actual.every(key => typeof key === "string" && keys.includes(key)));
  /** @type {Record<string,unknown>} */ const copy = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    check(descriptor && descriptor.enumerable && Object.hasOwn(descriptor, "value"));
    copy[key] = descriptor.value;
  }
  return copy;
}

/** @param {unknown} value @param {number} maximum @param {number} [exactLength] */
function array(value, maximum, exactLength) {
  check(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype);
  check(Number.isSafeInteger(value.length) && value.length >= 0 && value.length <= maximum);
  if (exactLength !== undefined) check(value.length === exactLength);
  const expected = ["length", ...Array.from({ length: value.length }, (_, index) => String(index))];
  const actual = Reflect.ownKeys(value);
  check(actual.length === expected.length && actual.every(key => typeof key === "string" && expected.includes(key)));
  /** @type {unknown[]} */ const copy = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    check(descriptor && descriptor.enumerable && Object.hasOwn(descriptor, "value"));
    copy.push(descriptor.value);
  }
  return copy;
}

/** @param {unknown} value @param {number} units @returns {string|null} */
function optionalText(value, units) { check(value === null || validText(value, units, true)); return value; }

/** @param {unknown} value @param {boolean} wireMode */
function nullableDate(value, wireMode) {
  if (value === null) return { value: null, time: null };
  let date = value;
  if (wireMode) { check(validText(value, 32)); date = new Date(value); }
  else check(value !== null && typeof value === "object" && Reflect.ownKeys(value).length === 0);
  let time, iso;
  try {
    time = Date.prototype.getTime.call(date);
    check(Number.isFinite(time) && Math.abs(time) <= MAX_DATE_MS);
    iso = Date.prototype.toISOString.call(date);
  } catch { throw new TypeError("invalid_data"); }
  if (wireMode) check(iso === value);
  return { value: iso, time };
}

/** @param {string} group @param {unknown} raw @param {boolean} [wireMode] @returns {CheckedRow} */
function checkedRow(group, raw, wireMode = false) {
  const row = record(raw, ROW_KEYS[group]);
  if (group === "maps") {
    check(validText(row.map, 200)); return { value: { map: row.map }, key: row.map, time: null };
  }
  if (group === "opponents") {
    check(validId(row.pulseId, 64) && validText(row.displayNameSample, 200));
    const date = nullableDate(row.lastSeen, wireMode);
    return { key: row.pulseId, time: date.time, value: { pulseId: row.pulseId,
      displayNameSample: row.displayNameSample, race: optionalText(row.race, 16), lastSeen: date.value } };
  }
  check(validId(row.slug, 120) && validText(row.name, 200));
  const date = nullableDate(row.updatedAt, wireMode);
  return { key: row.slug, time: date.time, value: { slug: row.slug, name: row.name, race: optionalText(row.race, 16),
    vsRace: optionalText(row.vsRace, 16), perspective: optionalText(row.perspective, 16), updatedAt: date.value } };
}

/** @param {string} group @param {CheckedRow} left @param {CheckedRow} right */
function rowOrder(group, left, right) {
  if (group !== "maps") {
    if (left.time === null && right.time !== null) return 1;
    if (left.time !== null && right.time === null) return -1;
    if (left.time !== null && right.time !== null && left.time !== right.time) return right.time - left.time;
  }
  return Buffer.compare(Buffer.from(left.key, "utf8"), Buffer.from(right.key, "utf8"));
}

/** @param {string} group @param {unknown} raw @param {number} maximum @param {boolean} [wireMode] */
function checkedRows(group, raw, maximum, wireMode = false) {
  const rows = array(raw, maximum).map(value => checkedRow(group, value, wireMode));
  const seen = new Set();
  for (let index = 0; index < rows.length; index += 1) {
    check(!seen.has(rows[index].key)); seen.add(rows[index].key);
    if (index) check(rowOrder(group, rows[index - 1], rows[index]) <= 0);
  }
  return rows;
}

/** @param {unknown} value */
function boundedJson(value) {
  const encoded = JSON.stringify(value); check(typeof encoded === "string");
  check(Buffer.byteLength(encoded, "utf8") <= MAX_BYTES); return encoded;
}

/** @param {unknown} raw @param {number} rows */
function sourceMetadata(raw, rows) {
  const source = array(raw, 1);
  if (source.length === 0) { check(rows === 0); return null; }
  const metadata = record(source[0], ["sourceCount", ...COUNTERS]);
  const count = metadata.sourceCount;
  check(typeof count === "number" && Number.isSafeInteger(count) && count >= 1 && count <= MAX_SOURCE);
  for (const counter of COUNTERS) {
    const value = metadata[counter];
    check(typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= count);
  }
  check(rows <= count); return metadata;
}

/** Validate all nine raw rows before invalid/overflow disposition. rawBsonBytes
 * is supplied only by the actual raw facet reader, never the request body.
 * @param {string} group @param {unknown} rawEnvelopes @param {number} rawBsonBytes */
function decodeCandidates(group, rawEnvelopes, rawBsonBytes) {
  try {
    check(GROUPS.includes(group));
    check(Number.isSafeInteger(rawBsonBytes) && rawBsonBytes > 0 && rawBsonBytes <= MAX_BYTES);
    const [raw] = array(rawEnvelopes, 1, 1), envelope = record(raw, ["source", "rows"]);
    const rows = checkedRows(group, envelope.rows, RAW_ROWS), metadata = sourceMetadata(envelope.source, rows.length);
    const count = metadata ? Number(metadata.sourceCount) : 0;
    const candidates = rows.map(row => row.value);
    boundedJson([{ source: metadata ? [metadata] : [], rows: candidates }]);
    if (metadata && COUNTERS.some(counter => Number(metadata[counter]) > 0)) {
      return { dto: unavailable("invalid_data"), candidates: [], sourceCount: count };
    }
    if (count > SUPPORTED_SOURCE) {
      return { dto: unavailable("source_budget_exceeded"), candidates: [], sourceCount: count };
    }
    const dto = { status: "ready", items: candidates.slice(0, VISIBLE_ROWS), hasMore: rows.length === RAW_ROWS };
    boundedJson(dto); return { dto, candidates, sourceCount: count };
  } catch { return { dto: unavailable("invalid_data"), candidates: [], sourceCount: 0 }; }
}

/** @param {string} group @param {unknown} envelopes @param {number} rawBsonBytes */
function decodeEnvelope(group, envelopes, rawBsonBytes) { return decodeCandidates(group, envelopes, rawBsonBytes).dto; }

/** Final exact v2 public projection with an independent whole-response64KiB cap.
 * @param {unknown} rawGroups */
function serializeResponse(rawGroups) {
  const groups = record(rawGroups, GROUPS);
  /** @type {Record<string,unknown>} */ const result = Object.create(null);
  for (const group of GROUPS) {
    const status = Object.getOwnPropertyDescriptor(groups[group] || {}, "status");
    check(status && Object.hasOwn(status, "value"));
    if (status.value === "ready") {
      const dto = record(groups[group], ["status", "items", "hasMore"]);
      const items = checkedRows(group, dto.items, VISIBLE_ROWS, true).map(row => row.value);
      check(typeof dto.hasMore === "boolean" && (!dto.hasMore || items.length === VISIBLE_ROWS));
      result[group] = { status: "ready", items, hasMore: dto.hasMore };
    } else {
      const dto = record(groups[group], ["status", "reason", "items", "hasMore"]);
      check(dto.status === "unavailable" && typeof dto.reason === "string" && REASONS.includes(dto.reason));
      check(dto.hasMore === null); array(dto.items, 0, 0); result[group] = unavailable(dto.reason);
    }
  }
  return boundedJson({ version: 2, groups: result });
}

module.exports = { MAX_BYTES, decodeEnvelope, decodeCandidates, serializeResponse, unavailable, record, array };
