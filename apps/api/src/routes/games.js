"use strict";

const express = require("express");
const { validateGameRecord } = require("../validation/gameRecord");

/**
 * /v1/games — list, get, ingest from agent.
 *
 * Ingest accepts either a single game object or `{games: [...]}` for
 * batches. Each game is upserted by `gameId` so retries are safe.
 *
 * @param {{
 *   games: import('../services/types').GamesService,
 *   opponents: import('../services/types').OpponentsService,
 *   customBuilds?: import('../services/types').CustomBuildsService,
 *   io?: import('socket.io').Server,
 *   auth: import('express').RequestHandler,
 * }} deps
 */
function buildGamesRouter(deps) {
  const router = express.Router();
  router.use(deps.auth);

  router.get("/games", async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      const limit = parseLimit(req.query.limit);
      const before = parseDate(req.query.before);
      const oppPulseId = req.query.oppPulseId
        ? String(req.query.oppPulseId)
        : undefined;
      const result = await deps.games.list(auth.userId, {
        limit,
        before,
        oppPulseId,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.get("/games/:gameId", async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      const game = await deps.games.get(auth.userId, String(req.params.gameId));
      if (!game) {
        res.status(404).json({ error: { code: "not_found" } });
        return;
      }
      res.json(game);
    } catch (err) {
      next(err);
    }
  });

  router.post("/games", async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      const userId = auth.userId;
      const incoming = Array.isArray(req.body?.games)
        ? req.body.games
        : [req.body];
      const accepted = [];
      const rejected = [];
      for (const raw of incoming) {
        const validation = validateGameRecord(raw);
        if (!validation.valid) {
          rejected.push({
            gameId: raw?.gameId || null,
            errors: validation.errors,
          });
          continue;
        }
        const game = /** @type {any} */ (validation.value);
        const created = await deps.games.upsert(userId, game);
        if (game.opponent && game.opponent.pulseId) {
          await deps.opponents.recordGame(userId, {
            pulseId: game.opponent.pulseId,
            toonHandle: game.opponent.toonHandle,
            pulseCharacterId: game.opponent.pulseCharacterId,
            displayName: game.opponent.displayName || "",
            race: game.opponent.race || "U",
            mmr: game.opponent.mmr,
            leagueId: game.opponent.leagueId,
            result: game.result,
            opening: game.opponent.opening,
            playedAt: new Date(game.date),
          });
        }
        // Override the agent's built-in classifier when the user has a
        // saved custom build whose rules match this replay. Without this
        // the opponent profile / Recent games column always shows the
        // agent's auto label even after the user named their opener and
        // saved it — and a click-Reclassify pass would just be re-undone
        // by the next upload. Fail-soft: a thrown evaluator never blocks
        // the ingest itself.
        if (deps.customBuilds && typeof deps.customBuilds.tagSingleGame === "function") {
          try {
            await deps.customBuilds.tagSingleGame(userId, game);
          } catch (e) {
            if (req.log) {
              req.log.warn(
                { err: e, gameId: game.gameId, userId },
                "ingest_custom_build_tag_failed",
              );
            }
          }
        }
        accepted.push({ gameId: game.gameId, created });
      }
      // Realtime nudge so an open SPA tab refreshes without polling.
      if (deps.io && accepted.length > 0) {
        deps.io.to(`user:${userId}`).emit("games:changed", {
          count: accepted.length,
        });
      }
      res.status(202).json({ accepted, rejected });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/** @param {unknown} raw @returns {number|undefined} */
function parseLimit(raw) {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** @param {unknown} raw @returns {Date|undefined} */
function parseDate(raw) {
  if (!raw || typeof raw !== "string") return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

module.exports = { buildGamesRouter };
