"use strict";

const express = require("express");
const { validateCustomBuild } = require("../validation/customBuild");
const { evaluateRules } = require("../services/buildRulesEvaluator");

const PREVIEW_TRUNCATION_LIMIT = 200;
const PREVIEW_GAME_SCAN_CAP = 600;

/**
 * Permissive matchup filter mirroring the local SPA semantics: a game
 * is in-scope when the requested vsRace is "Any"/missing, when the
 * stored opponent race matches, when no opponent race is recorded
 * (legacy imports), or when the build bucket name's prefix encodes the
 * matchup (e.g. "PvT — …"). Same for myRace.
 *
 * Strict matching here was the cause of the editor showing
 * "0 games scanned" when the user clearly had games — agents that
 * predate the race-normalisation pass leave myRace/opponent.race
 * blank.
 *
 * @param {{myRace?: string|null, oppRace?: string|null, myBuild?: string|null}} g
 * @param {string|undefined} race
 * @param {string|undefined} vsRace
 * @returns {boolean}
 */
function gameMatchesMatchup(g, race, vsRace) {
  return raceMatches(g.myRace, race, g.myBuild, 0)
    && raceMatches(g.oppRace, vsRace, g.myBuild, 2);
}

/**
 * @param {string|null|undefined} actual
 * @param {string|undefined} requested
 * @param {string|null|undefined} buildName
 * @param {number} bucketPos  0 = my-race char of "PvT" bucket, 2 = vs-race char
 * @returns {boolean}
 */
function raceMatches(actual, requested, buildName, bucketPos) {
  if (!requested || requested === "Any") return true;
  if (!actual) {
    if (typeof buildName === "string" && /^[PTZ]v[PTZ]/.test(buildName)) {
      const letter = requested.charAt(0).toUpperCase();
      if (buildName.charAt(bucketPos) === letter) return true;
    }
    // Legacy import without race info — be permissive so the user
    // doesn't see "0 games scanned" on a brand new build.
    return true;
  }
  const a = actual.charAt(0).toUpperCase();
  const r = requested.charAt(0).toUpperCase();
  return a === r;
}

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
   * Body: {
   *   rules: BuildRule[],
   *   race?: string,           — saver's own race
   *   vsRace?: string,         — opposing race
   *   perspective?: 'you'|'opponent',
   *                            — which side of each replay to scan
   * }
   *
   * Scans the signed-in user's games (capped at PREVIEW_GAME_SCAN_CAP)
   * and returns which games match all rules vs which fail exactly one.
   * Used by the live preview band in the BuildEditor modal.
   *
   * Perspective handling: when "opponent", we evaluate rules against
   * `oppBuildLog`. The myRace / vsRace gate flips accordingly so the
   * filter still asks "is this game's matchup the one this build is
   * for", regardless of which side authored the build.
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
      const rawRules = Array.isArray(body.rules) ? body.rules : [];
      // Drop placeholder rules (empty name) so the user sees a useful
      // preview while typing instead of zero matches + a 500.
      const rules = rawRules.filter(
        (r) =>
          r &&
          typeof r === "object" &&
          typeof r.name === "string" &&
          r.name.trim().length > 0,
      );
      if (rules.length === 0) {
        res.json({
          matches: [],
          almost_matches: [],
          scanned_games: 0,
          truncated: false,
        });
        return;
      }
      const race = typeof body.race === "string" ? body.race : undefined;
      const vsRace = typeof body.vsRace === "string" ? body.vsRace : undefined;
      const perspective = body.perspective === "opponent" ? "opponent" : "you";
      const games = await deps.perGame.listForRulePreview(auth.userId, {
        limit: PREVIEW_GAME_SCAN_CAP,
      });
      /** @type {Array<{game_id: string, build_name: string, map: string|null, result: string|null, date: Date|null}>} */
      const matches = [];
      /** @type {Array<{game_id: string, build_name: string, failed_rule_name?: string, failed_reason: string, map: string|null, result: string|null, date: Date|null}>} */
      const almostMatches = [];
      let evalErrors = 0;
      let scanned = 0;
      for (const g of games) {
        // Build "what race is on each side of this game" relative to
        // the build's perspective, then ask `gameMatchesMatchup` whether
        // the rule's race + vs match.
        const sideRace = perspective === "opponent" ? g.oppRace : g.myRace;
        const otherRace = perspective === "opponent" ? g.myRace : g.oppRace;
        if (
          !gameMatchesMatchup(
            { myRace: sideRace, oppRace: otherRace, myBuild: g.myBuild },
            race,
            vsRace,
          )
        ) {
          continue;
        }
        const events =
          perspective === "opponent" ? g.oppEvents || [] : g.events || [];
        if (events.length === 0) continue;
        scanned++;
        let evalRes;
        try {
          evalRes = evaluateRules(rules, events);
        } catch (e) {
          // One bad game shouldn't fail the whole preview. Log + skip.
          evalErrors++;
          if (req.log) {
            req.log.warn(
              { err: e, gameId: g && g.gameId },
              "preview_eval_failed",
            );
          }
          continue;
        }
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
        scanned_games: scanned,
        truncated:
          matches.length >= PREVIEW_TRUNCATION_LIMIT ||
          almostMatches.length >= PREVIEW_TRUNCATION_LIMIT,
        eval_errors: evalErrors > 0 ? evalErrors : undefined,
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

  /**
   * GET /v1/custom-builds/stats
   *
   * Aggregate W/L/winRate per saved build by re-running each build's
   * rules against the user's recent games. Lets the BuildsLibrary card
   * grid show real numbers immediately after save, instead of waiting
   * for the agent to reclassify and tag games with `myBuild`.
   */
  router.get("/custom-builds/stats", async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      if (!deps.perGame) {
        res.status(503).json({ error: { code: "stats_unavailable" } });
        return;
      }
      const items = await deps.customBuilds.evaluateAllStats(auth.userId);
      res.json(items);
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /v1/custom-builds/:slug/matches
   *
   * Per-build detail mirroring /v1/builds/:name shape. Same totals/
   * byMatchup/byMap/byStrategy/recent fields, but driven by the saved
   * rules so newly-saved builds show their matched games right away.
   */
  router.get("/custom-builds/:slug/matches", async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      if (!deps.perGame) {
        res.status(503).json({ error: { code: "stats_unavailable" } });
        return;
      }
      const result = await deps.customBuilds.evaluateBuild(
        auth.userId,
        String(req.params.slug),
      );
      if (!result) {
        res.status(404).json({ error: { code: "not_found" } });
        return;
      }
      res.json(result);
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

  /**
   * POST /v1/custom-builds/:slug/reclassify
   *
   * Re-evaluate the saved build's rules against every stored game and
   * write `myBuild = build.name` on each match (and clear the tag from
   * games that previously matched but no longer do, unless the body
   * sets `replace: false`). Returns counts so the UI can show
   * "Tagged 12, cleared 0".
   *
   * This is the "no-agent reclassify" path: the cloud already has the
   * parsed buildLog/oppBuildLog for every uploaded game, so this is a
   * single Mongo updateMany loop — not a round-trip to the desktop
   * agent.
   */
  router.post("/custom-builds/:slug/reclassify", async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      if (!deps.perGame) {
        res.status(503).json({ error: { code: "reclassify_unavailable" } });
        return;
      }
      const body = req.body || {};
      const result = await deps.customBuilds.reclassify(
        auth.userId,
        String(req.params.slug),
        { replace: body.replace !== false },
      );
      if (!result) {
        res.status(404).json({ error: { code: "not_found" } });
        return;
      }
      res.json({ ok: true, ...result });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /v1/custom-builds/reclassify-all
   *
   * Re-evaluate every saved build against every stored game in one
   * pass. Useful after editing several builds at once, or after the
   * user adds many new replays. First-write-wins on conflicts, ranked
   * by the build's most recent edit timestamp.
   */
  router.post("/custom-builds/reclassify-all", async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      if (!deps.perGame) {
        res.status(503).json({ error: { code: "reclassify_unavailable" } });
        return;
      }
      const body = req.body || {};
      const out = await deps.customBuilds.reclassifyAll(auth.userId, {
        clearUnmatched: !!body.clearUnmatched,
      });
      res.json({ ok: true, ...out });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { buildCustomBuildsRouter };
