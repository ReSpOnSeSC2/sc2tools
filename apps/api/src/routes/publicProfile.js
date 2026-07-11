"use strict";

const express = require("express");
const rateLimitModule = require("express-rate-limit");

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
    message: { error: { code: "rate_limited", message: "rate_limited" } },
  });

  router.get(
    "/public/profile/:handle",
    limiter,
    async (req, res, next) => {
      try {
        const profile = await deps.publicProfile.getPublicProfile(
          String(req.params.handle),
        );
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
