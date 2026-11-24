"use strict";

const { verifyToken } = require("@clerk/backend");
const { sha256 } = require("../util/hash");
const { AUTH_RETRY_AFTER_SEC, AuthUnavailableError, readCredential } = require("../util/credentialRead");

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
 * Only a decision about the credential is a 401: a missing, unknown,
 * revoked or invalid token, or a deleted account. When the database read
 * behind a device token or a Clerk user throws (unreachable, timed out,
 * pool closed), nothing was decided, so the request gets 503
 * `auth_unavailable` with Retry-After. The desktop agent treats repeated
 * 401s as a revoked token and unpairs, so an outage must never look like one.
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
  return async (req, res, next) => {
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
      const clerkUserId = claims.sub;
      const user = await readCredential(() => deps.ensureUser(clerkUserId));
      req.auth = {
        userId: user.userId,
        clerkUserId,
        source: "clerk",
      };
      next();
    } catch (err) {
      next(authError(err, res));
    }
  };
}

/** The error a failed authentication passes on. Retry-After is set here so
 * every error handler that renders the 503 carries it.
 * @param {unknown} err @param {import('express').Response} res */
function authError(err, res) {
  if (err instanceof AuthUnavailableError) {
    res.setHeader("Retry-After", String(AUTH_RETRY_AFTER_SEC));
    return err;
  }
  if (/** @type {any} */ (err)?.code === "account_deleted") return httpError(401, "account_deleted");
  return httpError(401, "auth_failed", err instanceof Error ? err : undefined);
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
  // New independent original query with original options. A read that
  // throws is a 503 (`auth_unavailable`), never a 401.
  const original = await readCredential(() => deps.getDeviceToken(tokenHash));
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
