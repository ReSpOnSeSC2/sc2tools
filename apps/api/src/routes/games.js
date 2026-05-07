"use strict";

const express = require("express");
const { validateGameRecord } = require("../validation/gameRecord");

/**
 * /v1/games — list, get, ingest from agent.
 *
 * Ingest accepts either a single game object or `{games: [...]}` for
 * batches. Each game is upserted by `gameId` so retries are safe.
 *
 * After a successful ingest this route also pushes:
 *   - ``games:changed`` to the user's room so an open SPA tab refreshes;
 *   - ``overlay:session`` to each connected overlay socket so the
 *     session-record widget ticks immediately;
 *   - ``overlay:live`` to the user's overlay tokens with a derived
 *     ``LiveGamePayload`` so every other widget renders the new game
 *     without the agent needing its own socket connection.
 *
 * @param {{
 *   games: import('../services/types').GamesService,
 *   opponents: import('../services/types').OpponentsService,
 *   customBuilds?: import('../services/types').CustomBuildsService,
 *   overlayLive?: import('../services/overlayLive').OverlayLiveService,
 *   overlayTokens?: import('../services/types').OverlayTokensService,
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
        // v0.4.3 storage trim: drop the redundant earlyBuildLog /
        // oppEarlyBuildLog fields if the agent (or a back-compat
        // caller) still sends them. They are derivable from
        // buildLog / oppBuildLog at read time and were costing ~6 kB
        // of redundant storage per document. Done at the route layer
        // so every ingest path benefits without each service having
        // to remember to strip them.
        if ("earlyBuildLog" in game) delete game.earlyBuildLog;
        if ("oppEarlyBuildLog" in game) delete game.oppEarlyBuildLog;
        // GamesService.upsert now writes the slim row to ``games``
        // and forwards the heavy fields to GameDetailsService. A
        // detail-store failure (R2 down, Mongo gameDetails write
        // refused, etc.) propagates here — we mark the game rejected
        // rather than silently shipping a broken inspector experience.
        // The slim row is left in place if the upsert wrote it before
        // the detail store call failed; the next agent re-upload
        // recovers, so this is a transient failure mode.
        let created;
        try {
          created = await deps.games.upsert(userId, game);
        } catch (err) {
          if (req.log) {
            req.log.warn(
              { err, gameId: game.gameId, userId },
              "ingest_upsert_failed",
            );
          }
          rejected.push({
            gameId: game.gameId || null,
            errors: [
              `upsert_failed: ${
                err && err.message ? err.message : String(err)
              }`,
            ],
          });
          continue;
        }
        if (game.opponent && game.opponent.pulseId) {
          // Only update the opponent doc when this is a brand-new
          // game (created === true). Re-uploads of an existing
          // gameId would otherwise double-count: ``recordGame``
          // does $inc on gameCount/wins/losses/openings.<X> and
          // doesn't dedupe on gameId, so a Resync — which clears
          // the agent's local ``state.uploaded`` and re-walks the
          // entire replay folder — would inflate every opponent's
          // counters by exactly the number of times their replay
          // was re-uploaded. The slim ``games`` row dedupes on
          // ``(userId, gameId)`` so the actual game-count truth
          // always lives there; the opponent counter is just a
          // cached aggregate, and we only bump it when the
          // canonical row was actually inserted.
          if (created) {
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
          } else if (deps.opponents.refreshMetadata) {
            // Existing game re-upload: still refresh the per-opponent
            // metadata that legitimately drifts between encounters
            // (display name, MMR, league, lastSeen, identity-link
            // resolution) without touching any counter.
            await deps.opponents.refreshMetadata(userId, {
              pulseId: game.opponent.pulseId,
              toonHandle: game.opponent.toonHandle,
              pulseCharacterId: game.opponent.pulseCharacterId,
              displayName: game.opponent.displayName || "",
              race: game.opponent.race || "U",
              mmr: game.opponent.mmr,
              leagueId: game.opponent.leagueId,
              playedAt: new Date(game.date),
            });
          }
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
        // Recompute the session card per connected overlay socket and
        // push the fresh aggregate. We can't broadcast to the whole
        // user room because each overlay carries its own timezone in
        // ``socket.data.timezone`` — "today" depends on the streamer's
        // wall clock, not on UTC. Best-effort: a transient resolveSocket
        // failure for one overlay must not block the ingest response.
        emitSessionUpdate(deps.io, deps.games, userId).catch((err) => {
          if (req.log) {
            req.log.warn(
              { err, userId },
              "overlay_session_emit_failed",
            );
          }
        });
        // Derive and broadcast the full LiveGamePayload for every
        // widget that depends on ``overlay:live``. Built off the LAST
        // accepted game so a batch upload (Resync, large catch-up)
        // doesn't fan out one event per game in the burst — the
        // overlay only renders the current state, not the play-by-
        // play. ``incoming`` is the validated, non-stripped game
        // body; we still pass it through buildFromGame because the
        // service hydrates H2H / streak / topbuilds from cloud
        // history.
        if (deps.overlayLive && deps.overlayTokens) {
          const lastAcceptedId = accepted[accepted.length - 1].gameId;
          const lastGame = incoming.find(
            (g) => g && g.gameId === lastAcceptedId,
          );
          if (lastGame) {
            emitOverlayLive(
              deps.io,
              deps.overlayLive,
              deps.overlayTokens,
              userId,
              lastGame,
            ).catch((err) => {
              if (req.log) {
                req.log.warn(
                  { err, userId },
                  "overlay_live_emit_failed",
                );
              }
            });
          }
        }
      }
      res.status(202).json({ accepted, rejected });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/**
 * Push a fresh ``overlay:session`` event to every overlay Browser
 * Source currently subscribed to this user's socket room. The session
 * widget is cloud-driven (today's W-L derived from the games
 * collection) so it must update the moment a new game lands —
 * otherwise the OBS panel sits on a stale W-L count until the streamer
 * reloads the Browser Source.
 *
 * Per-socket rather than room-broadcast because each overlay's "today"
 * boundary depends on its own ``socket.data.timezone`` — a streamer
 * mid-day in PT and a co-host's overlay in CET need different
 * aggregates. Broadcasting one UTC bucket would mis-align both.
 *
 * Concurrency is bounded: the session aggregation is a single
 * 48-hour-window find against ``games`` per overlay, and a typical
 * user has 1–3 overlay sockets connected at once. We compute
 * sequentially to keep Mongo load predictable; a streamer with many
 * dozens of overlays would still complete inside the request handler's
 * window without contending with the ingest itself (we already returned
 * 202 to the agent).
 *
 * @param {import('socket.io').Server} io
 * @param {import('../services/types').GamesService} games
 * @param {string} userId
 */
async function emitSessionUpdate(io, games, userId) {
  if (!io || !games || !userId) return;
  /** @type {any[]} */
  const sockets = await io.in(`user:${userId}`).fetchSockets();
  for (const socket of sockets) {
    if (socket?.data?.kind !== "overlay") continue;
    /** @type {string|undefined} */
    const tz = socket.data.timezone;
    try {
      const session = await games.todaySession(userId, tz);
      if (session) socket.emit("overlay:session", session);
    } catch {
      // Per-overlay failure is non-fatal — keep walking the list so
      // one bad socket doesn't starve the others of their update.
    }
  }
}

/**
 * Push a derived ``overlay:live`` payload to every active overlay
 * token belonging to ``userId``. The cloud derivation closes the gap
 * the agent's never-called ``push_overlay_live`` left open — every
 * widget that historically needed an agent connection now renders off
 * the cloud copy of the same data.
 *
 * Per-token (not per-room) emission is deliberate: we'd like to
 * eventually include the token's enabled-widgets list when filtering
 * the payload, and we already need the per-token loop for that future
 * step. Today the same payload goes to every active token of the
 * user — the overlay client's per-widget gating still hides anything
 * the streamer disabled.
 *
 * Non-fatal: a transient Mongo blip or a missing opponents row
 * shouldn't block the agent's ingest reply. We swallow the error
 * after logging at the route layer; the next game's emit is
 * independent.
 *
 * @param {import('socket.io').Server} io
 * @param {import('../services/overlayLive').OverlayLiveService} overlayLive
 * @param {import('../services/types').OverlayTokensService} overlayTokens
 * @param {string} userId
 * @param {Record<string, any>} game
 */
async function emitOverlayLive(io, overlayLive, overlayTokens, userId, game) {
  if (!io || !overlayLive || !overlayTokens || !userId || !game) return;
  const payload = await overlayLive.buildFromGame(userId, game);
  if (!payload) return;
  // ``list`` returns *all* tokens for the user (active + revoked).
  // Filter the revoked ones out so a leaked-then-revoked token can't
  // still receive live data after revocation.
  const items = await overlayTokens.list(userId);
  for (const t of items) {
    if (!t || !t.token) continue;
    if (t.revokedAt) continue;
    io.to(`overlay:${t.token}`).emit("overlay:live", payload);
  }
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
