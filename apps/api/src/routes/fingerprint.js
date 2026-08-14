"use strict";

const express = require("express");

/**
 * /v1/me/fingerprint — the Skill Fingerprint.
 *
 * GET /v1/me/fingerprint?matchup=PvZ returns the caller's replay-derived
 * build-repertoire and game-length tendencies for that matchup, plus the
 * shape of their win rates against all three opposing races for the selected
 * player race. See the fingerprint service for exact thresholds and the
 * deterministic archetype taxonomy.
 *
 * 400 ``bad_request``       — matchup missing / not two P|T|Z letters.
 * 404 ``not_enough_games``  — fewer than 10 qualifying games; the
 *                             client shows the friendly empty state.
 *
 * @param {{
 *   skillFingerprint: import('../services/skillFingerprint').SkillFingerprintService,
 *   auth: import('express').RequestHandler,
 * }} deps
 */
function buildFingerprintRouter(deps) {
  const router = express.Router();

  // Auth per-route (not router.use) so this router can never
  // intercept unauthenticated /v1/* endpoints mounted after it.
  router.get("/me/fingerprint", deps.auth, async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      const matchup = String(req.query.matchup || "").trim();
      // Case-insensitive on purpose — the service canonicalizes
      // ("pvz" → "PvZ") so deep links typed by hand still work.
      if (!/^[PTZ]v[PTZ]$/i.test(matchup)) {
        res.status(400).json({
          error: {
            code: "bad_request",
            message: "matchup (e.g. PvZ) required",
          },
        });
        return;
      }
      const fingerprint = await deps.skillFingerprint.compute(auth.userId, {
        matchup,
      });
      if (!fingerprint) {
        res.status(404).json({ error: { code: "not_enough_games" } });
        return;
      }
      res.json({ fingerprint });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { buildFingerprintRouter };
