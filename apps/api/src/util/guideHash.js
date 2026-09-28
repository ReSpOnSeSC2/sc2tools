"use strict";

const { hmac } = require("./hash");

/**
 * Pseudonymous keys for ``guide_samples`` rows.
 *
 * Guide samples are cross-user aggregate inputs, so they never carry the
 * internal ``userId`` or the agent's ``gameId`` (which embeds the
 * opponent's name). Instead each row is keyed by two domain-separated
 * HMACs under the server pepper:
 *
 *   - ``userHash`` — stable per user: the per-user cap, GDPR deletion and
 *     the signed-in "compare with me" endpoint recompute it from userId;
 *   - ``gameHash`` — stable per (user, game): makes re-uploads idempotent
 *     and lets a ranged history wipe delete exactly its games' samples.
 *
 * Ingest, GDPR and the /me endpoints MUST all go through these helpers so
 * the digests agree. The NUL separators keep ("ab","c") and ("a","bc")
 * from colliding.
 */

const USER_DOMAIN = "guide-sample-user-v1\0";
const GAME_DOMAIN = "guide-sample-game-v1\0";
const FIELD_SEPARATOR = "\0";

/**
 * Example: `guideUserHash(config.serverPepper, "u_123")` → 64 hex chars.
 *
 * @param {Buffer} pepper 32-byte server pepper (config.serverPepper)
 * @param {string} userId internal users.userId
 * @returns {string} lowercase hex HMAC-SHA256
 */
function guideUserHash(pepper, userId) {
  return hmac(pepper, USER_DOMAIN + userId);
}

/**
 * Example: `guideGameHash(config.serverPepper, "u_123", "2026-05-09T12:00:00|Foe|Map|620")`.
 *
 * @param {Buffer} pepper 32-byte server pepper (config.serverPepper)
 * @param {string} userId internal users.userId
 * @param {string} gameId the agent's per-user game id
 * @returns {string} lowercase hex HMAC-SHA256
 */
function guideGameHash(pepper, userId, gameId) {
  return hmac(pepper, GAME_DOMAIN + userId + FIELD_SEPARATOR + gameId);
}

module.exports = { guideUserHash, guideGameHash };
