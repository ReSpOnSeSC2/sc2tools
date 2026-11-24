"use strict";

// Seconds to wait before retrying when a credential could not be checked.
// The desktop agent honors Retry-After between its own attempts.
const AUTH_RETRY_AFTER_SEC = 5;
// Rejections a credential read raises as a decision about the caller rather
// than a failure to decide.
const VERDICT_CODES = new Set(["account_deleted"]);

/** A credential read threw before it decided anything about the caller. */
class AuthUnavailableError extends Error {
  /** @param {unknown} failure */
  constructor(failure) {
    super("auth_unavailable");
    this.status = 503;
    this.code = "auth_unavailable";
    // Only the failure's kind is kept: a driver message can name the
    // database host or carry query detail, and no log or client may see a
    // token, its hash or that detail.
    this.cause = failureKind(failure);
  }
}

/** Run one database-backed credential read (device token, overlay token or
 * Clerk user). A verdict such as account_deleted passes through; any other
 * failure means the credential could not be checked.
 * Example: `await readCredential(() => pairings.findTokenByHash(hash))`.
 * @template T @param {() => Promise<T>} read @returns {Promise<T>} */
async function readCredential(read) {
  try {
    return await read();
  } catch (err) {
    if (VERDICT_CODES.has(/** @type {any} */ (err)?.code)) throw err;
    throw new AuthUnavailableError(err);
  }
}

/** Log-safe kind of a failed read, e.g. `{ type: "MongoServerSelectionError" }`.
 * @param {unknown} err */
function failureKind(err) {
  const e = /** @type {any} */ (err);
  return {
    type: typeof e?.name === "string" ? e.name : typeof err,
    ...(typeof e?.code === "string" || Number.isInteger(e?.code) ? { code: e.code } : {}),
    ...(typeof e?.codeName === "string" ? { codeName: e.codeName } : {}),
  };
}

module.exports = { AUTH_RETRY_AFTER_SEC, AuthUnavailableError, readCredential };
