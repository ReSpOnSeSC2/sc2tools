"use strict";

const { createHash } = require("node:crypto");
const { instant, validGap } = require("./sessions");
const { requestKey } = require("./trendsRequests");
const HEX = /^[a-f0-9]{64}$/;
const MAX_TOKEN = 2048;

/** @param {string} code @param {number} [status] */
function historyError(code, status = 400) { return Object.assign(new Error(code), { code, status }); }
/** @returns {never} */
function invalid() { throw historyError("session_history_request_invalid"); }
/** @returns {never} */
function stale() { throw historyError("session_view_changed", 409); }
/** @param {unknown} value @returns {Record<string,unknown>} */
function record(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return /** @type {Record<string,unknown>} */ (value);
}
/** @param {unknown} value @returns {string} */
function iso(value) {
  if (typeof value !== "string") return invalid();
  const time = instant(value);
  if (time === null) return invalid();
  return new Date(time).toISOString();
}
/** @param {unknown} value @param {number} min @param {number} max @returns {number} */
function integer(value, min, max) {
  const n = typeof value === "string" && /^(0|[1-9]\d*)$/.test(value) ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) return invalid();
  return n;
}
/** @param {unknown} value @returns {string} */
function digest(value) {
  const encoded = requestKey(value);
  if (encoded === null) return invalid();
  return createHash("sha256").update("session-history:v1\n").update(encoded).digest("hex");
}
/** @param {object} value */
function encode(value) {
  const token = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  if (token.length > MAX_TOKEN) return invalid();
  return token;
}
/** @param {unknown} raw @param {string[]} keys */
function decode(raw, keys) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_TOKEN || !/^[A-Za-z0-9_-]+$/.test(raw)) return invalid();
  try {
    const text = Buffer.from(raw, "base64url").toString("utf8");
    if (Buffer.from(text).toString("base64url") !== raw) return invalid();
    const value = record(JSON.parse(text));
    if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) return invalid();
    return value;
  } catch { return invalid(); }
}
/** @param {unknown} value @returns {string} */
function hash(value) { return typeof value === "string" && HEX.test(value) ? value : invalid(); }
/** @param {unknown} raw @returns {import('./sessionHistoryTypes').SessionDescriptor} */
function parseSessionDescriptor(raw) {
  const x = decode(raw, ["v", "k", "s", "g", "a", "f", "e", "h"]);
  if (x.v !== 1 || (x.k !== "natural" && x.k !== "current") || !validGap(x.g)) return invalid();
  const a = x.a === null ? null : iso(x.a), f = iso(x.f), e = iso(x.e);
  if (Date.parse(f) > Date.parse(e) || (x.k === "natural" && a !== null)) return invalid();
  /** @type {import('./sessionHistoryTypes').SessionDescriptor} */
  const value = { v: 1, k: x.k, s: hash(x.s), g: Number(x.g), a, f, e, h: hash(x.h) };
  if (encode(value) !== raw) return invalid();
  return value;
}
/** @param {unknown} raw @returns {import('./sessionHistoryTypes').PageDescriptor} */
function parsePageDescriptor(raw) {
  const x = decode(raw, ["v", "k", "s", "g", "f", "t", "n", "c", "z", "h", "b"]);
  if (x.v !== 1 || x.k !== "before" || !validGap(x.g) || typeof x.z !== "string" || x.z.length > 100 || typeof x.b !== "string") return invalid();
  const boundary = parseSessionDescriptor(x.b);
  if (boundary.k !== "natural" || boundary.s !== x.s || boundary.g !== x.g) return invalid();
  const value = { v: /** @type {const} */ (1), k: /** @type {const} */ ("before"), s: hash(x.s), g: Number(x.g),
    f: iso(x.f), t: iso(x.t), n: iso(x.n), c: integer(x.c, 0, 30), z: x.z, h: hash(x.h), b: x.b };
  if (Date.parse(value.f) >= Date.parse(value.t) || encode(value) !== raw) return invalid();
  return value;
}
/** @param {unknown} raw @returns {import('./sessionHistoryTypes').GamePageDescriptor} */
function parseGamePageDescriptor(raw) {
  const x = decode(raw, ["v", "k", "s", "p"]);
  if (x.v !== 1 || x.k !== "games" || typeof x.s !== "string") return invalid();
  parseSessionDescriptor(x.s);
  const value = { v: /** @type {const} */ (1), k: /** @type {const} */ ("games"), s: x.s, p: integer(x.p, 1, 5000) };
  if (encode(value) !== raw) return invalid();
  return value;
}

module.exports = { historyError, invalid, stale, record, iso, integer, digest, encode,
  parseSessionDescriptor, parsePageDescriptor, parseGamePageDescriptor, MAX_TOKEN };
