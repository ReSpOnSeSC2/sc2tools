"use strict";

const express = require("express");
const { validateCustomBuild } = require("../validation/customBuild");
const { evaluateRules } = require("../services/buildRulesEvaluator");

const PREVIEW_TRUNCATION_LIMIT = 200;
const PREVIEW_GAME_SCAN_CAP = 600;

/**
 * /v1/custom-builds — user's private build library.
 *
 * @param {{
 *   customBuilds: import('../services/types').CustomBuildsService,
 *   perGame?: import('../services/types').PerGameComputeService,
 *   auth: import('express').RequestHandler,
 * }} deps
 */
function buildCustomBuildsRouter(deps) {
  const router = express.Router();
  router.use(deps.auth);

  /**
   * POST /v1/custom-builds/preview-matches
   *
   * Body: { rules: BuildRule[], race?: string, vsRace?: string, limit?: number }
   *
   * Scans the signed-in user's games (capped at PREVIEW_GAME_SCAN_CAP)
   * and returns which games match all rules vs which fail exactly one.
   * Used by the live preview band in the BuildEditor modal.
   */
  router.post("/custom-builds/preview-matches", async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      if (!deps.perGame) {
        res.status(503).json({ error: { code: "preview_unavailable" } });
        return;
      }
      const body = req.body || {};
      const rules = Array.isArray(body.rules) ? body.rules : [];
      if (rules.length === 0) {
        res.json({
          matches: [],
          almost_matches: [],
          scanned_games: 0,
          truncated: false,
        });
        return;
      }
      const games = await deps.perGame.listForRulePreview(auth.userId, {
        race: typeof body.race === "string" ? body.race : undefined,
        vsRace: typeof body.vsRace === "string" ? body.vsRace : undefined,
        limit: PREVIEW_GAME_SCAN_CAP,
      });
      /** @type {Array<{game_id: string, build_name: string, map: string|null, result: string|null, date: Date|null}>} */
      const matches = [];
      /** @type {Array<{game_id: string, build_name: string, failed_rule_name?: string, failed_reason: string, map: string|null, result: string|null, date: Date|null}>} */
      const almostMatches = [];
      for (const g of games) {
        const evalRes = evaluateRules(rules, g.events);
        const summary = {
          game_id: g.gameId,
          build_name: g.myBuild || `${g.myRace || "?"} vs ${g.oppRace || "?"}`,
          map: g.map,
          result: g.result,
          date: g.date,
        };
        if (evalRes.pass) {
          if (matches.length < PREVIEW_TRUNCATION_LIMIT) matches.push(summary);
          continue;
        }
        if (
          evalRes.almost &&
          almostMatches.length < PREVIEW_TRUNCATION_LIMIT
        ) {
          almostMatches.push({
            ...summary,
            failed_rule_name: evalRes.failedRule
              ? evalRes.failedRule.name
              : undefined,
            failed_reason: evalRes.failedReason || "rule failed",
          });
        }
      }
      res.json({
        matches,
        almost_matches: almostMatches,
        scanned_games: games.length,
        truncated:
          matches.length >= PREVIEW_TRUNCATION_LIMIT ||
          almostMatches.length >= PREVIEW_TRUNCATION_LIMIT,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/custom-builds", async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      const items = await deps.customBuilds.list(auth.userId);
      res.json({ items });
    } catch (err) {
      next(err);
    }
  });

  router.get("/custom-builds/:slug", async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      const item = await deps.customBuilds.get(
        auth.userId,
        String(req.params.slug),
      );
      if (!item) {
        res.status(404).json({ error: { code: "not_found" } });
        return;
      }
      res.json(item);
    } catch (err) {
      next(err);
    }
  });

  router.put("/custom-builds/:slug", async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      const slug = String(req.params.slug);
      const validation = validateCustomBuild({ ...req.body, slug });
      if (!validation.valid) {
        res.status(400).json({
          error: { code: "bad_request", details: validation.errors },
        });
        return;
      }
      await deps.customBuilds.upsert(
        auth.userId,
        /** @type {any} */ (validation.value),
      );
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.delete("/custom-builds/:slug", async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      await deps.customBuilds.softDelete(auth.userId, String(req.params.slug));
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { buildCustomBuildsRouter };
