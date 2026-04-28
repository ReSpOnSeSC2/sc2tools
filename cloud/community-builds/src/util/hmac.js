"use strict";

const crypto = require("crypto");

const HEX_BYTES_PER_CHAR = 2;
const HEX_REGEX = /^[0-9a-fA-F]*$/;

/**
 * Compute HMAC-SHA256 hex digest over the given body using the server pepper.
 *
 * @param {Buffer} pepper       - 32-byte server pepper.
 * @param {Buffer|string} body  - Raw request body.
 * @returns {string}            - lowercase hex digest.
 *
 * Example:
 *   const sig = signHmac(pepper, '{"id":"abc"}');
 */
function signHmac(pepper, body) {
  return crypto.createHmac("sha256", pepper).update(body).digest("hex");
}

/**
 * Constant-time comparison of two hex strings.
 * Returns false on type, format, or length mismatch.
 *
 * @param {string} expected
 * @param {string} provided
 * @returns {boolean}
 */
function safeHexEqual(expected, provided) {
  if (!isHex(expected) || !isHex(provided)) return false;
  if (expected.length !== provided.length) return false;
  if (expected.length % HEX_BYTES_PER_CHAR !== 0) return false;
  const expectedBuf = Buffer.from(expected, "hex");
  const providedBuf = Buffer.from(provided, "hex");
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

/** @param {unknown} value @returns {boolean} */
function isHex(value) {
  return typeof value === "string" && HEX_REGEX.test(value);
}

/**
 * Verify a request signature.
 *
 * @param {{ pepper: Buffer, body: Buffer|string, signature: string }} args
 * @returns {boolean}
 */
function verifyHmac({ pepper, body, signature }) {
  const expected = signHmac(pepper, body);
  return safeHexEqual(expected, signature);
}

module.exports = { signHmac, safeHexEqual, verifyHmac };
