"use strict";
const { COLLECTIONS } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");
const LIMIT = 20;

/** Same legacy-list policy as the profile DTO: explicit arrays, including
 * an empty one, take precedence over the old singular field.
 * @param {any} doc @returns {string[]} */
function pulseIds(doc) {
  const raw = Array.isArray(doc.pulseIds) ? doc.pulseIds : typeof doc.pulseId === "string" ? [doc.pulseId] : [];
  /** @type {string[]} */ const out = [];
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 64 || out.includes(trimmed)) continue;
    out.push(trimmed);
    if (out.length === LIMIT) break;
  }
  return out;
}

/** @param {any} doc @param {string} field */
function unchanged(doc, field) {
  return Object.hasOwn(doc, field) ? { $eq: doc[field], $exists: true } : { $exists: false };
}

/** Append by bounded compare-and-set. Concurrent ingest/profile appends are
 * re-read rather than overwritten; only the two identity fields change.
 * @param {import('mongodb').Collection<any>} users @param {string} userId @param {unknown} raw
 * @returns {Promise<{code:'added'|'already_present'|'capacity'|'missing'|'busy'|'invalid', count:number}>} */
async function appendPulseId(users, userId, raw) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value || value.length > 64) return { code: "invalid", count: 0 };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const doc = await users.findOne({ userId }, { projection: { _id: 0, pulseIds: 1, pulseId: 1, _gdprMutation: 1 }, maxTimeMS: 5000 });
    if (!doc) return { code: "missing", count: 0 };
    if (doc._gdprMutation) return { code: "busy", count: 0 };
    const current = pulseIds(doc);
    if (current.includes(value)) return { code: "already_present", count: current.length };
    if (current.length >= LIMIT) return { code: "capacity", count: current.length };
    const next = current.concat(value);
    const set = stampVersion({ pulseIds: next, pulseId: next[0] }, COLLECTIONS.USERS);
    const result = await users.updateOne({ userId, _gdprMutation: { $exists: false },
      pulseIds: unchanged(doc, "pulseIds"), pulseId: unchanged(doc, "pulseId") }, { $set: set }, { maxTimeMS: 5000 });
    if (result.matchedCount) return { code: "added", count: next.length };
  }
  return { code: "busy", count: 0 };
}
module.exports = { appendPulseId, pulseIds, LIMIT };
