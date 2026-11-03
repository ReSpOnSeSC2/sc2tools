"use strict";

const { createHash, createHmac, createSecretKey, KeyObject, timingSafeEqual } = require("crypto");
const { ObjectId } = require("mongodb");
const { parseFilters } = require("../util/parseQuery");
const { buildReplayLibraryMatch } = require("./replayLibrary");
const { decodeReplayLibraryCursor, encodeReplayLibraryCursor } = require("./replayLibraryCursor");

const CURSOR_LIFETIME_MS = 24 * 60 * 60 * 1000;
const QUERY_KEYS = new Set(["since", "until", "patch_era", "race", "opp_race", "map", "map_exact", "mmr_min", "mmr_max",
  "opp_strategy", "group_by_race_played", "build", "leak", "macro_min", "macro_max", "min_minutes", "max_minutes",
  "exclude_too_short", "regions", "accounts", "map_pool", "game_size", "result", "matchup", "search", "sort", "continuation_token"]);

class BuildOrderExportError extends Error {
  /** @param {number} status @param {string} code */
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
function invalidOptions() { return new BuildOrderExportError(400, "invalid_export_options"); }
function invalidCursor() { return new BuildOrderExportError(400, "invalid_export_cursor"); }
function unavailable() { return new BuildOrderExportError(503, "export_unavailable"); }

/** Encode the effective match, not client spellings or RegExp's empty JSON form.
 * Only Mongo set/logical arrays are unordered; other arrays retain their order.
 * @param {any} value @param {string} [key] @returns {any} */
function canonicalMatch(value, key = "") {
  if (value instanceof Date) return { date: value.toISOString() };
  if (value instanceof ObjectId) return { objectId: value.toHexString() };
  if (value instanceof RegExp) return { regexp: value.source, flags: value.flags };
  if (Array.isArray(value)) {
    const values = value.map(item => canonicalMatch(item));
    if (!["$in", "$nin", "$and", "$or", "$nor", "$type"].includes(key)) return values;
    return [...new Set(values.map(item => JSON.stringify(item)))].sort().map(item => JSON.parse(item));
  }
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(name => [name, canonicalMatch(value[name], name)]));
  return value;
}

/** Capture the validated production key without retaining a caller-owned buffer.
 * @param {Buffer} pepper @returns {import('crypto').KeyObject} */
function buildOrderSigningKey(pepper) {
  if (!Buffer.isBuffer(pepper) || pepper.length !== 32) throw unavailable();
  return createSecretKey(Buffer.from(pepper));
}

/** @param {import('crypto').KeyObject} pepper @param {string} domain @param {string} value */
function mac(pepper, domain, value) {
  return createHmac("sha256", pepper).update(`build-order-export:v1:${domain}\0`).update(value).digest("base64url");
}

/** Validate all request primitives before admission/quota and bind the effective base scope.
 * @param {string} owner @param {Record<string,unknown>} query @param {'csv'|'ndjson'} format @param {Buffer|import('crypto').KeyObject} pepper @param {number} [now] */
function prepareBuildOrderRequest(owner, query, format, pepper, now = Date.now()) {
  if (typeof owner !== "string" || !owner || owner.length > 128 || /[\u0000-\u001f\u007f]/u.test(owner)) throw invalidOptions();
  const key = Buffer.isBuffer(pepper) ? buildOrderSigningKey(pepper) : pepper;
  if (!(key instanceof KeyObject) || key.type !== "secret" || key.symmetricKeySize !== 32 || !Number.isSafeInteger(now) || now < 0) throw unavailable();
  if (format !== "csv" && format !== "ndjson") throw invalidOptions();
  if (!query || typeof query !== "object" || Array.isArray(query)) throw invalidOptions();
  for (const [key, value] of Object.entries(query)) {
    if (!QUERY_KEYS.has(key)) throw invalidOptions();
    if (key === "continuation_token") {
      if (typeof value !== "string" || value.length > 2048) throw invalidCursor();
      continue;
    }
    if (key === "accounts" && Array.isArray(value) && value.length <= 20 && value.every(item => typeof item === "string" && item.length <= 64)) continue;
    if (key === "regions" && Array.isArray(value) && value.length <= 12 && value.every(item => typeof item === "string" && item.length <= 8)) continue;
    if (typeof value !== "string" || value.length > 2048) throw invalidOptions();
  }
  if (query.sort !== undefined && query.sort !== "date_desc") throw invalidOptions();
  let match;
  try {
    const filters = parseFilters(query);
    // The shared region matcher also builds a regex string from this set.
    // Normalize its order before building, rather than rewriting regex text.
    if (filters.regions) filters.regions.sort();
    const search = typeof query.search === "string" ? query.search.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 100).toLowerCase() : undefined;
    match = buildReplayLibraryMatch(owner, { filters, search,
      result: query.result, matchup: typeof query.matchup === "string" ? query.matchup.trim().toUpperCase() : undefined });
  } catch { throw invalidOptions(); }
  const scope = createHash("sha256").update(JSON.stringify(canonicalMatch(match))).digest("hex");
  const ownerTag = mac(key, "owner", owner);
  let issuedAt = now;
  /** @type {ReturnType<typeof decodeReplayLibraryCursor>} */ let position = null;
  if (query.continuation_token !== undefined) {
    const decoded = readCursor(query.continuation_token, ownerTag, scope, format, key, now);
    issuedAt = decoded.issuedAt; position = decoded.position;
  }
  return { owner, match, scope, format, issuedAt, position,
    /** @param {{date:unknown,_id:unknown}} last */
    next: last => signCursor({ v: 1, o: ownerTag, h: scope, f: format, i: issuedAt, e: issuedAt + CURSOR_LIFETIME_MS,
      p: encodeReplayLibraryCursor(last.date, last._id, "date_desc") }, key) };
}

/** @param {Record<string,any>} payload @param {import('crypto').KeyObject} pepper */
function signCursor(payload, pepper) {
  const text = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${text}.${mac(pepper, "cursor", text)}`;
}

/** @param {unknown} token @param {string} owner @param {string} scope @param {'csv'|'ndjson'} format @param {import('crypto').KeyObject} pepper @param {number} now */
function readCursor(token, owner, scope, format, pepper, now) {
  try {
    if (typeof token !== "string" || token.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(token)) throw invalidCursor();
    const [text, signature] = token.split(".");
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(mac(pepper, "cursor", text)))) throw invalidCursor();
    const raw = Buffer.from(text, "base64url");
    if (raw.toString("base64url") !== text) throw invalidCursor();
    const data = JSON.parse(raw.toString("utf8"));
    if (!data || Object.keys(data).sort().join(",") !== "e,f,h,i,o,p,v" || data.v !== 1 || data.o !== owner || data.h !== scope || data.f !== format
      || !Number.isSafeInteger(data.i) || data.i < 0 || data.i > now || data.e !== data.i + CURSOR_LIFETIME_MS) throw invalidCursor();
    const position = decodeReplayLibraryCursor(data.p);
    if (!position || position.sort !== "date_desc" || encodeReplayLibraryCursor(position.date, position.id, position.sort) !== data.p) throw invalidCursor();
    if (now >= data.e) throw new BuildOrderExportError(410, "export_cursor_expired");
    return { issuedAt: data.i, position };
  } catch (error) {
    if (error instanceof BuildOrderExportError) throw error;
    throw invalidCursor();
  }
}

/** Three admission timestamps implement a rolling hour on the Mongo server clock.
 * An absent new field is initialized; null/invalid/versioned/corrupt fields fail closed.
 * No denied/failed command is retried or refunded. No user or GDPR-locked row is created.
 * @param {import('mongodb').Collection} users @param {string} owner @param {AbortSignal} signal */
async function chargeBuildOrderQuota(users, owner, signal) {
  signal.throwIfAborted();
  const field = "$buildOrderExportQuota", times = `${field}.t`;
  const safeTimes = { $cond: [{ $isArray: times }, times, []] };
  const recent = { $filter: { input: safeTimes, as: "at", cond: { $gt: ["$$at", { $subtract: ["$$NOW", 60 * 60 * 1000] }] } } };
  const valid = { $or: [{ $eq: [{ $type: field }, "missing"] }, { $cond: [
    { $eq: [{ $type: field }, "object"] }, { $and: [
      { $setEquals: [{ $map: { input: { $objectToArray: field }, as: "pair", in: "$$pair.k" } }, ["v", "t"]] },
      { $eq: [{ $type: `${field}.v` }, "int"] }, { $eq: [`${field}.v`, 1] }, { $isArray: times },
      { $lte: [{ $size: safeTimes }, 3] }, { $allElementsTrue: [{ $map: { input: safeTimes, as: "at", in: {
        $and: [{ $eq: [{ $type: "$$at" }, "date"] }, { $lte: ["$$at", "$$NOW"] }],
      } } }] },
    ] }, false,
  ] }] };
  let admitted;
  try {
    admitted = await users.findOneAndUpdate({ userId: owner, _gdprMutation: { $exists: false },
      $expr: { $and: [valid, { $lt: [{ $size: recent }, 3] }] } }, [
      { $set: { buildOrderExportQuota: { v: { $literal: 1 }, t: { $concatArrays: [recent, ["$$NOW"]] } } } },
    ], { upsert: false, returnDocument: "after", projection: { _id: 1 }, maxTimeMS: 5000 });
  } catch { throw unavailable(); }
  signal.throwIfAborted();
  // A fixed denial also conceals missing/blocked/corrupt owner quota state.
  if (!admitted) throw new BuildOrderExportError(429, "export_rate_limited");
}

module.exports = { BuildOrderExportError, buildOrderSigningKey, prepareBuildOrderRequest, chargeBuildOrderQuota, unavailable };
