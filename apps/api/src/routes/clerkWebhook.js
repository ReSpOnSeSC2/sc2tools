"use strict";

const express = require("express");
const crypto = require("crypto");

const { pickPrimaryEmail } = require("../services/clerkClient");

// Reject webhook payloads older than this (svix's recommended default).
// Anything older almost certainly indicates a replayed message.
const MAX_TIMESTAMP_SKEW_SEC = 5 * 60;

/**
 * Mount the Clerk webhook receiver at POST /webhooks/clerk. Clerk uses
 * Svix to sign webhooks: the body is bound to `${svix-id}.${svix-timestamp}.${rawBody}`
 * via HMAC-SHA256, and the resulting signature is base64-encoded into a
 * `v1,<sig>` token in the `svix-signature` header (multiple tokens may
 * be present during secret rotation — any one matching is sufficient).
 *
 * We only handle two events here: `user.created` and `user.updated`.
 * Both upsert the user's primary email onto the users collection so the
 * Settings → Foundation card has it without needing a Clerk round-trip.
 *
 * If `secret` is empty (e.g. local dev without a webhook configured),
 * the route returns 503 — it's still mounted so the failure is visible
 * in logs rather than silently 404ing in Clerk's dashboard.
 *
 * @param {{
 *   users: import('../services/types').UsersService,
 *   secret: string|null,
 *   logger?: import('pino').Logger,
 * }} deps
 */
function buildClerkWebhookRouter(deps) {
  const router = express.Router();

  router.post("/webhooks/clerk", async (req, res, next) => {
    try {
      if (!deps.secret) {
        res.status(503).json({ error: { code: "webhook_not_configured" } });
        return;
      }
      // The global express.json() parser stashed the raw bytes on
      // req.rawBody (configured in app.js) — we need the original buffer
      // for HMAC verification, since re-stringifying req.body would
      // canonicalize whitespace and break the signature.
      const rawBody = /** @type {any} */ (req).rawBody;
      if (!Buffer.isBuffer(rawBody)) {
        res.status(400).json({ error: { code: "missing_raw_body" } });
        return;
      }
      const id = headerStr(req, "svix-id");
      const timestamp = headerStr(req, "svix-timestamp");
      const signatureHeader = headerStr(req, "svix-signature");
      if (!id || !timestamp || !signatureHeader) {
        res.status(400).json({ error: { code: "missing_svix_headers" } });
        return;
      }
      if (!withinSkew(timestamp)) {
        res.status(400).json({ error: { code: "stale_timestamp" } });
        return;
      }
      if (!verifySignature(deps.secret, id, timestamp, rawBody, signatureHeader)) {
        res.status(401).json({ error: { code: "invalid_signature" } });
        return;
      }

      const evt = req.body;
      if (!evt || typeof evt !== "object") {
        res.status(400).json({ error: { code: "bad_payload" } });
        return;
      }
      const type = typeof evt.type === "string" ? evt.type : "";
      if (type !== "user.created" && type !== "user.updated") {
        // Other events (session.created, organization.*, etc.) get a
        // 200 so Clerk doesn't keep retrying — we just don't do
        // anything with them.
        res.status(200).json({ ignored: type });
        return;
      }
      const user = evt.data;
      if (!user || typeof user.id !== "string" || user.id.length === 0) {
        res.status(400).json({ error: { code: "bad_user_payload" } });
        return;
      }
      const email = pickPrimaryEmail(user);
      await deps.users.upsertFromWebhook(user.id, email);
      if (deps.logger) {
        deps.logger.info(
          { type, clerkUserId: user.id, hasEmail: Boolean(email) },
          "clerk_webhook_processed",
        );
      }
      res.status(200).json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/**
 * @param {import('express').Request} req
 * @param {string} name
 * @returns {string|null}
 */
function headerStr(req, name) {
  const v = req.headers[name];
  if (typeof v === "string" && v.length > 0) return v;
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string") return v[0];
  return null;
}

/**
 * Verify a Svix-format signature header against the raw body. The header
 * is space-separated `version,base64sig` tokens; we accept any version-1
 * match. Uses constant-time comparison to avoid timing leaks.
 *
 * @param {string} secret  The webhook secret. Clerk hands these out in
 *                         the form `whsec_<base64>` — we strip the prefix
 *                         and base64-decode the rest.
 * @param {string} id
 * @param {string} timestamp
 * @param {Buffer} rawBody
 * @param {string} header
 */
function verifySignature(secret, id, timestamp, rawBody, header) {
  const key = decodeSecret(secret);
  if (!key) return false;
  const signed = `${id}.${timestamp}.${rawBody.toString("utf8")}`;
  const expected = crypto.createHmac("sha256", key).update(signed).digest();
  for (const part of header.split(/\s+/)) {
    const eq = part.indexOf(",");
    if (eq <= 0) continue;
    const version = part.slice(0, eq);
    if (version !== "v1") continue;
    const candidate = part.slice(eq + 1);
    let provided;
    try {
      provided = Buffer.from(candidate, "base64");
    } catch {
      continue;
    }
    if (provided.length === expected.length &&
        crypto.timingSafeEqual(provided, expected)) {
      return true;
    }
  }
  return false;
}

/**
 * @param {string} secret
 * @returns {Buffer|null}
 */
function decodeSecret(secret) {
  if (typeof secret !== "string" || secret.length === 0) return null;
  // Svix secrets have a `whsec_` prefix and a base64 payload; some
  // local-dev setups paste the secret without the prefix, so we accept
  // either form.
  const base64 = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  try {
    const buf = Buffer.from(base64, "base64");
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}

/** @param {string} timestamp */
function withinSkew(timestamp) {
  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  return Math.abs(nowSec - ts) <= MAX_TIMESTAMP_SKEW_SEC;
}

module.exports = { buildClerkWebhookRouter };
