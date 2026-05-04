"use strict";

const crypto = require("crypto");

/**
 * HMAC-SHA256 a value with the server pepper. Used to keep PII (battle
 * tags, opponent display names) out of the cloud DB while still allowing
 * deterministic per-user lookup. Lookup callers HMAC the same input
 * they receive on the wire and query by the resulting digest.
 *
 * @param {Buffer} pepper - 32-byte server-side secret
 * @param {string} value
 * @returns {string} lowercase hex digest, 64 chars
 *
 * Example:
 *   hmac(serverPepper, "ReSpOnSe#1234") === hmac(serverPepper, "ReSpOnSe#1234")
 */
function hmac(pepper, value) {
  return crypto
    .createHmac("sha256", pepper)
    .update(value, "utf8")
    .digest("hex");
}

/**
 * Random URL-safe token. Used for device tokens, overlay tokens, etc.
 *
 * @param {number} bytes
 * @returns {string} base64url, no padding
 */
function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

/**
 * Random N-digit pairing code, zero-padded.
 *
 * @param {number} length
 * @returns {string}
 */
function randomDigits(length = 6) {
  const max = 10 ** length;
  const n = crypto.randomInt(0, max);
  return String(n).padStart(length, "0");
}

/**
 * Hash a token for storage. Tokens are random, so SHA-256 (no pepper
 * needed for collision resistance) is enough. Always store the hash,
 * never the raw token.
 *
 * @param {string} token
 * @returns {string} hex digest
 */
function sha256(token) {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

module.exports = { hmac, randomToken, randomDigits, sha256 };
