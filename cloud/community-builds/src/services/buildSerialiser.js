"use strict";

const { LIMITS, DEFAULTS } = require("../constants");

/**
 * Convert a validated request body into the canonical stored document.
 *
 * @param {Record<string, any>} body - Already-validated request body.
 * @param {{ clientId: string, now: number, version?: number }} ctx
 * @returns {Record<string, any>} - Storable doc (no _id).
 */
function toStored(body, ctx) {
  return {
    id: body.id,
    name: body.name,
    race: body.race,
    vsRace: body.vsRace,
    tier: normaliseTier(body.tier),
    description: body.description ?? "",
    winConditions: body.winConditions ?? [],
    losesTo: body.losesTo ?? [],
    transitionsInto: body.transitionsInto ?? [],
    signature: body.signature,
    toleranceSec: body.toleranceSec ?? DEFAULTS.TOLERANCE_SEC,
    minMatchScore: body.minMatchScore ?? DEFAULTS.MIN_MATCH_SCORE,
    authorClientId: ctx.clientId,
    authorDisplay: body.authorDisplay || "anon",
    createdAt: ctx.now,
    updatedAt: ctx.now,
    deletedAt: null,
    upvotes: 0,
    downvotes: 0,
    flagged: 0,
    version: ctx.version ?? 1,
  };
}

/**
 * Strip Mongo internals before returning to clients.
 *
 * @param {Record<string, any>|null} doc
 * @returns {Record<string, any>|null}
 */
function toPublic(doc) {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return rest;
}

/** @param {string|null|undefined} tier @returns {string|null} */
function normaliseTier(tier) {
  if (tier === undefined) return DEFAULTS.TIER;
  return tier;
}

/**
 * Clamp a page size to the allowed range, defaulting to PAGE_SIZE_DEFAULT.
 *
 * @param {unknown} raw
 * @returns {number}
 */
function clampPageSize(raw) {
  const n = Number.parseInt(String(raw ?? LIMITS.PAGE_SIZE_DEFAULT), 10);
  if (!Number.isFinite(n) || n <= 0) return LIMITS.PAGE_SIZE_DEFAULT;
  return Math.min(n, LIMITS.PAGE_SIZE_MAX);
}

module.exports = { toStored, toPublic, clampPageSize };
