"use strict";

const { verifyToken } = require("@clerk/backend");
const { sha256 } = require("../util/hash");

const BEARER_PREFIX = "Bearer ";

/**
 * Build the auth middleware. Accepts EITHER a Clerk session JWT (web
 * users) or a long-lived device token (the local agent).
 *
 * On success, attaches `req.auth = { userId, source, clerkUserId? }`.
 * `clerkUserId` is present only when `source === "clerk"` — it's the raw
 * Clerk identifier (e.g. `user_2abc...`), needed for env-var gates like
 * SC2TOOLS_ADMIN_USER_IDS where admins paste IDs straight from the Clerk
 * dashboard rather than the internal UUID.
 *
 * @param {{
 *   secretKey: string,
 *   issuer?: string,
 *   audience?: string,
 *   getDeviceToken: (tokenHash: string) => Promise<{userId: string}|null>,
 *   deviceTokenReuse?: {prepare:(hash:string)=>Promise<object|null>,consume:(hash:string,ticket:object|null)=>{userId:string}|null},
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
      if (looksLikeDeviceToken(raw) && await tryDeviceAuth(deps, raw, req, next)) return;
      // Fall through to Clerk verify for everything else.
      const claims = await verifyToken(
        raw,
        /** @type {any} */ (clerkOptions(deps)),
      );
      if (!claims || !claims.sub) {
        next(httpError(401, "invalid_token"));
        return;
      }
      const user = await deps.ensureUser(claims.sub);
      req.auth = {
        userId: user.userId,
        clerkUserId: claims.sub,
        source: "clerk",
      };
      next();
    } catch (err) {
      if (/** @type {any} */ (err)?.code === "account_deleted") { next(httpError(401, "account_deleted")); return; }
      next(httpError(401, "auth_failed", err instanceof Error ? err : undefined));
    }
  };
}

/** @param {any} deps */
function clerkOptions(deps) {
  return { secretKey: deps.secretKey,
    ...(deps.issuer ? { issuer: deps.issuer } : {}),
    ...(deps.audience ? { audience: deps.audience } : {}),
  };
}

/** This helper performs its final consume, auth assignment and next without
 * an await between them. A rejected cache result is never the fallback.
 * @param {any} deps @param {string} raw @param {any} req @param {any} next */
async function tryDeviceAuth(deps, raw, req, next) {
  const tokenHash = sha256(raw);
  const ticket = deps.deviceTokenReuse ? await prepareDeviceAdmission(deps.deviceTokenReuse, tokenHash) : null;
  const retained = ticket ? consumeDeviceAdmission(deps.deviceTokenReuse, tokenHash, ticket) : null;
  if (retained) { req.auth = { userId: retained.userId, source: "device", tokenHash }; next(); return true; }
  // New independent original query with original options and error behavior.
  const original = await deps.getDeviceToken(tokenHash);
  if (!original) return false;
  req.auth = { userId: original.userId, source: "device", tokenHash }; next(); return true;
}

/** Cache failures affect reuse only. @param {any} reuse @param {string} hash */
async function prepareDeviceAdmission(reuse, hash) {
  if (!reuse) return null;
  try { return await reuse.prepare(hash); } catch { return null; }
}

/** No await, clock IO or fallback occurs after this final admission check.
 * @param {any} reuse @param {string} hash @param {object} ticket */
function consumeDeviceAdmission(reuse, hash, ticket) {
  try { return reuse?.consume(hash, ticket) || null; } catch { return null; }
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
