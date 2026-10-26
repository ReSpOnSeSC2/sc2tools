"use strict";

const express = require("express");
const rateLimitModule = require("express-rate-limit");
const { validPlayerSlug, PLAYER_UUID_RE } = require("../util/publicPlayerConfig");

const rateLimit =
  /** @type {any} */ (rateLimitModule).default || rateLimitModule;

/**
 * Default per-IP cap for the public profile read. Generous (these are
 * cheap cached DB reads, unlike the Python-spawning preview-replay
 * route) but still bounded so the unauthenticated endpoint can't be
 * turned into an amplification lever.
 */
const PUBLIC_PROFILE_RATE_LIMIT_PER_MIN = 60;

/**
 * /v1/public/profile/:handle — public, unauthenticated, rate-limited
 * SSR data source for the opt-in player page at ``/p/:handle``.
 *
 * Returns ``{ profile }`` (200) for an opted-in user, or a neutral 404
 * (``profile_not_found``) for a malformed handle, an unknown user, OR a
 * user who has not opted in — the three are indistinguishable to the
 * caller on purpose, so a deliberately-private user is never outed.
 *
 * No auth middleware: treat every input as hostile. The service
 * validates the handle shape before touching Mongo and only ever emits
 * non-sensitive aggregates (never opponent identities or raw rows).
 *
 * @param {{
 *   publicProfile: import('../services/publicProfile').PublicProfileService,
 *   players?: import('../services/publicPlayer').PublicPlayerService,
 *   rateLimitPerMinute?: number,
 * }} deps
 */
function buildPublicProfileRouter(deps) {
  const router = express.Router();

  const max =
    typeof deps.rateLimitPerMinute === "number" && deps.rateLimitPerMinute > 0
      ? deps.rateLimitPerMinute
      : PUBLIC_PROFILE_RATE_LIMIT_PER_MIN;

  const limiter = rateLimit({
    windowMs: 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (/** @type {import('express').Request} */ req) =>
      `${req.ip}:${String(req.params.handle || "").toLowerCase()}`,
    message: { error: { code: "rate_limited", message: "rate_limited" } },
  });

  router.get(
    "/public/profile/:handle",
    limiter,
    async (req, res, next) => {
      try {
        res.set("Cache-Control", "no-store");
        const handle = String(req.params.handle);
        // Old API clients also used short internal handles. Preserve that
        // guarded legacy reader without widening new canonical URL aliases.
        const canonical = validPlayerSlug(handle) || PLAYER_UUID_RE.test(handle);
        const profile = deps.players && canonical ? (await deps.players.get(handle))?.profile : await deps.publicProfile.getPublicProfile(handle);
        if (!profile) {
          res.status(404).json({
            error: {
              code: "profile_not_found",
              message: "This profile is private or doesn't exist.",
            },
          });
          return;
        }
        res.json({ profile });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

module.exports = {
  buildPublicProfileRouter,
  PUBLIC_PROFILE_RATE_LIMIT_PER_MIN,
};
