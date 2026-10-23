"use strict";

const { createClerkClient } = require("@clerk/backend");

/**
 * Thin wrapper around the Clerk backend SDK. The rest of the API only
 * reads primary email best-effort and deletes identities after local erasure.
 * Email lookup failures return `null`; deletion failures remain retryable. The
 * /v1/me handler treats email as best-effort: if Clerk is unreachable or
 * mocked away in tests, the row simply renders as "—" until the next
 * request succeeds (or the Clerk webhook fills it in).
 *
 * @typedef {{
 *   getEmail: (clerkUserId: string) => Promise<string|null>,
 *   deleteUser: (clerkUserId: string) => Promise<void>,
 * }} ClerkClient
 */

/**
 * Build a real Clerk client from a secret key. Falls back to the no-op
 * client if `createClerkClient` is unavailable (e.g. narrow test mocks).
 * That fallback returns unknown email and rejects identity deletion so the
 * durable retry queue never mistakes an unavailable provider for success.
 *
 * @param {{secretKey: string, logger?: import('pino').Logger}} deps
 * @returns {ClerkClient}
 */
function buildClerkClient(deps) {
  if (typeof createClerkClient !== "function") {
    return noopClerkClient();
  }
  let client;
  try {
    client = createClerkClient({ secretKey: deps.secretKey });
  } catch (err) {
    if (deps.logger) {
      deps.logger.warn({ err }, "clerk_client_init_failed");
    }
    return noopClerkClient();
  }
  return {
    async deleteUser(clerkUserId) {
      try { await client.users.deleteUser(clerkUserId); }
      catch (error) {
        // Provider deletion and its webhook may race; already absent is done.
        if (/** @type {any} */ (error)?.status === 404 || /** @type {any} */ (error)?.statusCode === 404) return;
        throw error;
      }
    },
    async getEmail(clerkUserId) {
      try {
        const user = await client.users.getUser(clerkUserId);
        return pickPrimaryEmail(user);
      } catch (err) {
        if (deps.logger) {
          deps.logger.warn(
            { err, clerkUserId },
            "clerk_get_user_failed",
          );
        }
        return null;
      }
    },
  };
}

/**
 * A no-op client for tests / environments without a Clerk secret. Returns
 * null for every lookup so callers fall through to whatever they had on
 * disk.
 *
 * @returns {ClerkClient}
 */
function noopClerkClient() {
  return {
    async deleteUser() { throw Object.assign(new Error("clerk_unavailable"), { code: "clerk_unavailable" }); },
    async getEmail() {
      return null;
    },
  };
}

/**
 * Pull the primary email from a Clerk user object. Tries
 * `primaryEmailAddressId` first, falls back to the first verified email,
 * and finally to the first email of any status. Returns null if none.
 *
 * @param {any} user
 * @returns {string|null}
 */
function pickPrimaryEmail(user) {
  if (!user || !Array.isArray(user.emailAddresses)) return null;
  /** @type {any[]} */
  const list = user.emailAddresses;
  if (list.length === 0) return null;
  if (user.primaryEmailAddressId) {
    const hit = list.find(
      (/** @type {any} */ e) => e && e.id === user.primaryEmailAddressId,
    );
    if (hit && typeof hit.emailAddress === "string") return hit.emailAddress;
  }
  const verified = list.find(
    (/** @type {any} */ e) =>
      e && e.verification && e.verification.status === "verified",
  );
  if (verified && typeof verified.emailAddress === "string") {
    return verified.emailAddress;
  }
  const first = list[0];
  return first && typeof first.emailAddress === "string"
    ? first.emailAddress
    : null;
}

module.exports = { buildClerkClient, noopClerkClient, pickPrimaryEmail };
