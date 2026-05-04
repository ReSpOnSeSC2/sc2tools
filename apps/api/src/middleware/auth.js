"use strict";

const { verifyToken } = require("@clerk/backend");
const { sha256 } = require("../util/hash");

const BEARER_PREFIX = "Bearer ";

/**
 * Build the auth middleware. Accepts EITHER a Clerk session JWT (web
 * users) or a long-lived device token (the local agent).
 *
 * On success, attaches `req.auth = { userId, source }` where `source`
 * is "clerk" or "device".
 *
 * @param {{
 *   secretKey: string,
 *   issuer?: string,
 *   audience?: string,
 *   getDeviceToken: (tokenHash: string) => Promise<{userId: string}|null>,
 *   ensureUser: (clerkUserId: string) => Promise<{userId: string}>,
 * }} deps
 * @returns {import('express').RequestHandler}
 */
function buildAuth(deps) {
  return async (req, _res, next) => {
    try {
      const raw = extractBearer(req);
      if (!raw) {
        next(httpError(401, "missing_token"));
        return;
      }
      // Clerk JWTs are short and look like xxx.yyy.zzz; device tokens
      // are random base64url. Try device token first when length suggests
      // it (cheaper — DB hit only, no signature verify).
      if (looksLikeDeviceToken(raw)) {
        const hit = await deps.getDeviceToken(sha256(raw));
        if (hit) {
          req.auth = { userId: hit.userId, source: "device" };
          next();
          return;
        }
      }
      // Fall through to Clerk verify for everything else.
      const claims = await verifyToken(
        raw,
        /** @type {any} */ ({
          secretKey: deps.secretKey,
          ...((deps.issuer ? { issuer: deps.issuer } : {})),
          ...((deps.audience ? { audience: deps.audience } : {})),
        }),
      );
      if (!claims || !claims.sub) {
        next(httpError(401, "invalid_token"));
        return;
      }
      const user = await deps.ensureUser(claims.sub);
      req.auth = { userId: user.userId, source: "clerk" };
      next();
    } catch (err) {
      next(httpError(401, "auth_failed", err instanceof Error ? err : undefined));
    }
  };
}

/**
 * Pull a Bearer token from the Authorization header.
 * @param {import('express').Request} req
 * @returns {string|null}
 */
function extractBearer(req) {
  const auth = req.headers["authorization"];
  if (typeof auth !== "string" || !auth.startsWith(BEARER_PREFIX)) return null;
  const tok = auth.slice(BEARER_PREFIX.length).trim();
  return tok.length > 0 ? tok : null;
}

/**
 * Heuristic: device tokens are 43 chars (32 bytes base64url), no dots.
 * Clerk JWTs always contain dots (header.payload.signature).
 *
 * @param {string} tok
 * @returns {boolean}
 */
function looksLikeDeviceToken(tok) {
  return !tok.includes(".") && tok.length >= 32 && tok.length <= 80;
}

/**
 * @param {number} status
 * @param {string} code
 * @param {Error} [cause]
 * @returns {Error & {status: number, code: string}}
 */
function httpError(status, code, cause) {
  const err = /** @type {Error & {status: number, code: string}} */ (
    new Error(code)
  );
  err.status = status;
  err.code = code;
  if (cause) err.cause = cause;
  return err;
}

module.exports = { buildAuth };
