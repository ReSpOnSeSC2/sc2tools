"use strict";

const express = require("express");
const { validateGameRecord } = require("../validation/gameRecord");
const {
  buildClassifierSet,
  isLadderMap,
  LADDER_CLASSIFY_VERSION,
} = require("../util/isLadderMap");

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
 *     without the agent needing its own socket connection. The
 *     payload is stamped with ``gameKey`` (taken from the broker's
 *     latest envelope when it correlates by opponent name, falling
 *     back to ``game.gameId``) so the overlay client's
 *     ``useClearStalePostGameOnGameKeyChange`` effect can detect a
 *     match transition and drop stale ``live`` state.
 *
 * @param {{
 *   games: import('../services/types').GamesService,
 *   opponents: import('../services/types').OpponentsService,
 *   users?: {
 *     addPulseId: (userId: string, pulseId: string) => Promise<boolean>,
 *     repairLastKnownMmrAfterResumedReplay?: (userId: string) => Promise<boolean>,
 *   },
 *   customBuilds?: import('../services/types').CustomBuildsService,
 *   overlayLive?: import('../services/overlayLive').OverlayLiveService,
 *   overlayTokens?: import('../services/types').OverlayTokensService,
 *   liveGameBroker?: import('../services/liveGameBroker').LiveGameBroker,
 *   engagement?: import('../services/multichatEngagement').MultichatEngagementService,
 *   gameVods?: {
 *     resolveForGames: (userId: string, games: Array<Record<string, any>>, opts?: {includeOpponent?: boolean}) => Promise<{
 *       configuredPlatforms: string[],
 *       linksByGameId: Record<string, Array<Record<string, any>>>,
 *     }>,
 *   },
 *   ladderMapPool?: { get(): Promise<{ maps: string[], teamMaps?: string[] }> },
 *   io?: import('socket.io').Server,
 *   auth: import('express').RequestHandler,
 * }} deps
 */
function buildGamesRouter(deps) {
  // Fail loudly at boot if the OpponentsService doesn't expose
  // ``refreshMetadata``. The earlier "fail-soft" guard quietly skipped
  // the metadata refresh on every re-upload when the method was
  // missing, which is exactly how a stuck "TOON id" opponent (one
  // whose pulseCharacterId never landed on the first ingest) would
  // never get healed by a subsequent re-upload that DID carry the
  // resolved id. We'd rather find out at deploy time than at
  // 3-am-this-streamer-can't-link-to-nephest time.
  if (
    !deps.opponents
    || typeof deps.opponents.refreshMetadata !== "function"
  ) {
    throw new Error(
      "buildGamesRouter: deps.opponents.refreshMetadata is required",
    );
  }
  const router = express.Router();
  router.use(deps.auth);
  // Within a single batch the same myToonHandle will repeat for every
  // game; track which ones we've already attempted to merge so a
  // 200-replay Resync doesn't generate 200 ``users.findOne`` round
  // trips for one toon. Reset per request.
  /** @type {(req: import('express').Request) => Set<string>} */
  const handlesSeenInRequest = (req) => {
    if (!req._mergedToonHandles) req._mergedToonHandles = new Set();
    return req._mergedToonHandles;
  };

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

  /**
   * Resolve timestamped Twitch / YouTube VOD links for a game or a
   * visible date range.  This is intentionally a separate, fail-soft
   * read from the core games list: an expired/private provider archive
   * must never make replay history itself slow or unavailable.
   *
   * The range form lets the all-games table pay one HTTP request (and,
   * behind the service cache, one provider lookup) instead of issuing a
   * request per row.  The gameId form is used by the single-game page.
   */
  router.get("/games/vod-links", async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");

      /** @type {Array<Record<string, any>>} */
      let games = [];
      const gameId =
        typeof req.query.gameId === "string"
          ? req.query.gameId.trim().slice(0, 200)
          : "";

      if (gameId) {
        const game = await deps.games.get(auth.userId, gameId);
        if (game) games = [game];
      } else {
        const since = parseDate(req.query.since);
        const until = parseDate(req.query.until);
        if (!since || !until || since.getTime() > until.getTime()) {
          res.status(400).json({ error: { code: "invalid_date_range" } });
          return;
        }
        // GamesService's cursor is exclusive. Move the upper bound one
        // millisecond forward so a replay whose date exactly equals the
        // visible table's newest row is included.
        const before = new Date(until.getTime() + 1);
        const page = await deps.games.list(auth.userId, {
          before,
          // Bounded independently of the ordinary list default. This is
          // enough for even a very large visible dossier without letting
          // a crafted range turn provider matching into an unbounded scan.
          limit: 2000,
        });
        const pageItems = /** @type {Array<Record<string, any>>} */ (
          Array.isArray(page?.items) ? page.items : []
        );
        games = pageItems.filter((game) => {
          const at = new Date(game?.date).getTime();
          return (
            Number.isFinite(at)
            && at >= since.getTime()
            && at <= until.getTime()
          );
        });
      }

      if (!deps.gameVods) {
        res.json({ configuredPlatforms: [], linksByGameId: {} });
        return;
      }
      const includeOpponent = gameId
        ? true
        : req.query.includeOpponent === "1"
          || req.query.includeOpponent === "true";
      res.json(
        await deps.gameVods.resolveForGames(auth.userId, games, {
          includeOpponent,
        }),
      );
    } catch (err) {
      next(err);
    }
  });

  /**
   * Exact bulk form used by the opponent dossier. A dossier may merge
   * several SC2Pulse identities, which makes a date or single-opponent
   * filter an imprecise proxy for the rows actually on screen. Sending
   * the visible ids keeps provider work bounded and avoids leaking links
   * for games the client did not request.
   */
  router.post("/games/vod-links", async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      const rawIds = req.body?.gameIds;
      if (!Array.isArray(rawIds) || rawIds.length > 1000) {
        res.status(400).json({ error: { code: "invalid_game_ids" } });
        return;
      }
      if (
        rawIds.some(
          (id) =>
            typeof id !== "string"
            || !id.trim()
            || id.trim().length > 200,
        )
      ) {
        res.status(400).json({ error: { code: "invalid_game_ids" } });
        return;
      }
      const gameIds = Array.from(
        new Set(
          /** @type {string[]} */ (rawIds).map((id) => id.trim()),
        ),
      );
      if (gameIds.length !== rawIds.length || gameIds.length === 0) {
        res.status(400).json({ error: { code: "invalid_game_ids" } });
        return;
      }

      const games = typeof deps.games.findMany === "function"
        ? await deps.games.findMany(auth.userId, gameIds)
        : /** @type {Array<Record<string, any>>} */ ((
            await Promise.all(
              gameIds.map((id) => deps.games.get(auth.userId, id)),
            )
          ).filter(Boolean));

      if (!deps.gameVods) {
        res.json({ configuredPlatforms: [], linksByGameId: {} });
        return;
      }
      res.json(
        await deps.gameVods.resolveForGames(auth.userId, games, {
          includeOpponent: req.body?.includeOpponent === true,
        }),
      );
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
      /** @type {Array<{gameId: string, created: boolean, quarantined?: boolean}>} */
      const accepted = [];
      const competitiveAccepted = [];
      const competitiveIncoming = [];
      /** @type {Array<{gameId: string, created: boolean, quarantined?: boolean}>} */
      const quarantinedAccepted = [];
      const rejected = [];
      // Build the historical map classifier once per batch for the
      // legacy ``isLadderMap`` compatibility stamp. The analyzer's
      // ranked/custom filter now uses canonical ``isLadderGame`` only;
      // this proxy remains for older readers and diagnostics. The set is
      // the all-seasons historical list
      // (baked into the util) UNIONed with the live current pool when
      // reachable — so it spans 1v1 AND team maps from every season, and
      // still classifies correctly even if the pool lookup fails. The
      // 1v1-only ``maps`` field stays the Bingo / season-catalog pool.
      /** @type {string[]} */
      let livePoolMaps = [];
      if (deps.ladderMapPool && typeof deps.ladderMapPool.get === "function") {
        try {
          const pool = await deps.ladderMapPool.get();
          livePoolMaps = [
            ...((pool && pool.maps) || []),
            ...((pool && pool.teamMaps) || []),
          ];
        } catch (err) {
          const e = /** @type {{ message?: unknown }} */ (err);
          if (req.log) {
            req.log.warn(
              { err: e && e.message ? e.message : String(err) },
              "ingest_ladder_pool_unavailable",
            );
          }
        }
      }
      const ladderMapSet = buildClassifierSet(livePoolMaps);
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
        // SC2's resume-from-replay feature writes a new replay whose result
        // is synthetic. Quarantine it before classification and every
        // competitive side effect. The marker remains queryable for the
        // build dossier's opt-in audit view, but cannot affect W/L, session,
        // opponent, custom-build, or overlay state.
        if (game.isResumedFromReplay === true) {
          try {
            const marked = await deps.games.quarantineResumedReplay(
              userId,
              game,
            );
            const outcome = {
              gameId: game.gameId,
              created: marked.created,
              quarantined: true,
            };
            accepted.push(outcome);
            quarantinedAccepted.push(outcome);
          } catch (err) {
            const e = /** @type {{ message?: unknown }} */ (err);
            if (req.log) {
              req.log.warn(
                { err, gameId: game.gameId, userId },
                "ingest_resume_quarantine_failed",
              );
            }
            rejected.push({
              gameId: game.gameId || null,
              retryable: true,
              errors: [
                `quarantine_failed: ${
                  e && e.message ? e.message : String(err)
                }`,
              ],
            });
          }
          continue;
        }
        competitiveIncoming.push(game);
        // Maintain the legacy ``isLadderMap`` compatibility field. Mirror
        // the agent's authoritative matchmaking flag when present;
        // otherwise use the historical map-name proxy for old readers.
        // Strict analyzer filters deliberately do not treat that proxy as
        // proof of ladder, because custom lobbies can use ladder maps.
        // ``isLadderMapV`` records which classifier version produced it.
        game.isLadderMap =
          typeof game.isLadderGame === "boolean"
            ? game.isLadderGame
            : isLadderMap(game.map, ladderMapSet);
        game.isLadderMapV = LADDER_CLASSIFY_VERSION;
        // GamesService.upsert commits heavy fields through
        // GameDetailsService before it creates the slim ``games`` row. A
        // detail-store failure (R2 down, Mongo gameDetails write refused,
        // etc.) therefore propagates without consuming the ``created=true``
        // result that gates the exactly-once opponent aggregate below. The
        // agent retries this game; once detail storage succeeds, the slim
        // insert and OpponentsService.recordGame still run exactly once.
        // ``myMmr`` is historical data: it must describe the rating at
        // game time. Never substitute SC2Pulse's current rating when a
        // replay omits it. A history resync spans months or years, so a
        // current-value fallback turns every old game in a region into
        // the same flat MMR line. Current MMR remains available to the
        // session overlay through its separate profile/Pulse fallback.
        let created;
        try {
          created = await deps.games.upsert(userId, game);
        } catch (err) {
          const e = /** @type {{ message?: unknown }} */ (err);
          if (req.log) {
            req.log.warn(
              { err, gameId: game.gameId, userId },
              "ingest_upsert_failed",
            );
          }
          rejected.push({
            gameId: game.gameId || null,
            // Validation already passed; this is an infrastructure/storage
            // failure (for example a transient R2 detail-store outage).
            // The desktop queue must retry this one game instead of writing
            // a permanent local "rejected" cursor.
            retryable: true,
            errors: [
              `upsert_failed: ${
                e && e.message ? e.message : String(err)
              }`,
            ],
          });
          continue;
        }
        if (game.opponent && game.opponent.pulseId) {
          // Only bump counters on a brand-new ``games`` row
          // (``created === true``). Re-uploads of an existing
          // gameId would otherwise double-count: ``recordGame``
          // does $inc on gameCount/wins/losses/openings.<X> and
          // doesn't dedupe on gameId, so a Resync — which clears
          // the agent's local ``state.uploaded`` and re-walks the
          // entire replay folder — would inflate every opponent's
          // counters by exactly the number of times their replay
          // was re-uploaded. The slim ``games`` row dedupes on
          // ``(userId, gameId)`` so the actual game-count truth
          // always lives there; the opponent counter is just a
          // cached aggregate.
          //
          // refreshMetadata runs on EVERY ingest (created or not).
          // It $sets fields that legitimately drift between
          // encounters (displayName, mmr, leagueId, toonHandle,
          // pulseCharacterId) without touching counters. Running
          // it on the created path too is harmless — the same
          // values were just $set by recordGame — and it ensures
          // a re-upload that finally carries a freshly-resolved
          // pulseCharacterId always lands it on the row, fixing
          // the "stuck on TOON id" failure mode for opponents
          // whose first ingest happened during a transient
          // SC2Pulse outage.
          const opponentPayload = {
            // gameId travels through so OpponentsService can stamp
            // the SC2Pulse-resolved MMR / region back onto THIS
            // game's opponent sub-document — the bingo MMR predicates
            // read from games, not opponents. Without it the cells
            // never tick.
            gameId: game.gameId,
            pulseId: game.opponent.pulseId,
            toonHandle: game.opponent.toonHandle,
            pulseCharacterId: game.opponent.pulseCharacterId,
            pulseLookupAttempted: game.opponent.pulseLookupAttempted === true,
            displayName: game.opponent.displayName || "",
            race: game.opponent.race || "U",
            mmr: game.opponent.mmr,
            leagueId: game.opponent.leagueId,
            playedAt: new Date(game.date),
          };
          let recordResult = null;
          let refreshResult = null;
          try {
            if (created) {
              recordResult = await deps.opponents.recordGame(userId, {
                ...opponentPayload,
                result: game.result,
                opening: game.opponent.opening,
              });
            } else {
              refreshResult = await deps.opponents.refreshMetadata(
                userId,
                opponentPayload,
              );
            }
          } catch (err) {
            // Metadata writes are advisory — never fail the ingest
            // over them. The slim ``games`` row already landed; a
            // future ingest or the backfill cron will heal the
            // opponents collection.
            if (req.log) {
              req.log.warn(
                { err, gameId: game.gameId, userId, pulseId: game.opponent.pulseId },
                "ingest_opponent_metadata_failed",
              );
            }
          }
          const upgraded = Boolean(
            (recordResult && recordResult.upgraded)
            || (refreshResult && refreshResult.upgraded),
          );
          if (upgraded && req.log) {
            req.log.info(
              {
                userId,
                pulseId: game.opponent.pulseId,
                gameId: game.gameId,
                created,
              },
              "ingest_opponent_pulse_character_id_upgraded",
            );
          }
        }
        // Auto-detect: backfill the user's own toon handle into their
        // ``pulseIds`` array. The agent forwards ``myToonHandle`` on
        // every game from v0.5.x onward; before this hook the streamer
        // had to manually paste their toon handle into Settings →
        // Profile for the session widget's SC2Pulse fallback to work.
        // Now we just copy the handle the moment we see it. Fail-soft:
        // a write failure here must never reject the game ingest.
        if (
          deps.users &&
          typeof deps.users.addPulseId === "function" &&
          typeof game.myToonHandle === "string" &&
          game.myToonHandle.trim()
        ) {
          const handle = game.myToonHandle.trim();
          const seen = handlesSeenInRequest(req);
          if (!seen.has(handle)) {
            seen.add(handle);
            try {
              await deps.users.addPulseId(userId, handle);
            } catch (err) {
              if (req.log) {
                req.log.warn(
                  { err, userId, handle },
                  "ingest_pulse_id_merge_failed",
                );
              }
            }
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
        const outcome = { gameId: game.gameId, created };
        accepted.push(outcome);
        competitiveAccepted.push(outcome);
      }
      // Always finish durable quarantine repairs after a stored marker,
      // including on a retry where the rows were already sticky-flagged.
      // Counter reversals are targeted and exactly-once; sticky MMR repair is
      // journaled on the quarantined rows and compare-and-swapped so it cannot
      // roll back a concurrently uploaded legitimate game.
      if (quarantinedAccepted.length > 0) {
        try {
          if (
            !deps.opponents
            || typeof deps.opponents.repairResumedReplayCountersForUser !== "function"
          ) {
            throw new Error("opponent quarantine repair unavailable");
          }
          await deps.opponents.repairResumedReplayCountersForUser(userId);
          if (
            !deps.users
            || typeof deps.users.repairLastKnownMmrAfterResumedReplay !== "function"
          ) {
            throw new Error("sticky MMR quarantine repair unavailable");
          }
          await deps.users.repairLastKnownMmrAfterResumedReplay(userId);
        } catch (err) {
          if (req.log) {
            req.log.warn(
              { err, userId },
              "ingest_resume_repair_failed",
            );
          }
          const quarantineOutcomes = new Set(quarantinedAccepted);
          for (let i = accepted.length - 1; i >= 0; i -= 1) {
            if (quarantineOutcomes.has(accepted[i])) accepted.splice(i, 1);
          }
          const e = /** @type {{ message?: unknown }} */ (err);
          for (const item of quarantinedAccepted) {
            rejected.push({
              gameId: item.gameId,
              retryable: true,
              errors: [
                `quarantine_repair_failed: ${
                  e && e.message ? e.message : String(err)
                }`,
              ],
            });
          }
        }
      }
      // Realtime nudge so an open SPA tab refreshes without polling.
      if (deps.io && accepted.length > 0) {
        // Reuse the same freshness gate for the session MMR refresh and
        // the post-game overlay fan-out. Historical resync batches must
        // not bypass the Pulse cache, while a genuinely new match must
        // not inherit the pre-game rating for another five minutes.
        const freshGame = pickFreshOverlayGame(
          competitiveIncoming,
          competitiveAccepted,
        );
        deps.io.to(`user:${userId}`).emit("games:changed", {
          count: accepted.length,
        });
        // Recompute the session card per connected overlay socket and
        // push the fresh aggregate. We can't broadcast to the whole
        // user room because each overlay carries its own timezone in
        // ``socket.data.timezone`` — "today" depends on the streamer's
        // wall clock, not on UTC. Best-effort: a transient resolveSocket
        // failure for one overlay must not block the ingest response.
        if (competitiveAccepted.length > 0) {
          emitSessionUpdate(deps.io, deps.games, userId, {
            refreshCurrentMmr: !!freshGame,
          }).catch((err) => {
            if (req.log) {
              req.log.warn(
                { err, userId },
                "overlay_session_emit_failed",
              );
            }
          });
        }
        // Derive and broadcast the full LiveGamePayload for every
        // widget that depends on ``overlay:live`` — but ONLY for a
        // game the streamer just finished. Re-uploads of historical
        // replays (full resync, the Builds-page reclassify, the Macro
        // backfill, bulk imports) flow through this same ingest in
        // 25-game batches; pre-gate, each batch fan-out fired the
        // post-game widgets for a years-old game and overwrote the
        // broker's cached payload with it, so the streamer's scene
        // re-ran stale widgets for the whole duration of a backfill
        // (and the resync replay kept re-showing the last one for
        // 30 min after). ``date`` is the replay's UTC end time
        // (sc2reader's replay.date, normalised with a Z by the
        // agent), so a tight window cleanly separates "just played"
        // from "re-uploaded history". We pick the FRESHEST accepted
        // game of the batch (not the last array element) so a real
        // game finishing mid-backfill still reaches the stream.
        if (deps.overlayLive && deps.overlayTokens) {
          if (freshGame) {
            emitOverlayLive(
              deps.io,
              deps.overlayLive,
              deps.overlayTokens,
              userId,
              freshGame,
              deps.liveGameBroker || null,
              deps.engagement || null,
            ).catch((err) => {
              if (req.log) {
                req.log.warn(
                  { err, userId },
                  "overlay_live_emit_failed",
                );
              }
            });
          } else if (req.log) {
            req.log.debug(
              { userId, accepted: accepted.length },
              "overlay_live_skipped_stale_batch",
            );
          }
          // Invalidate the pre-game scouting cache for every opponent
          // touched by this ingest. Without this, a rematch against the
          // same opponent inside the 5-minute enrichment cache window
          // would render its LAST GAMES list missing the just-uploaded
          // encounter. Per accepted game (not just the last) so a
          // batch upload also clears every opponent it touched.
          //
          // We pass the opponent's ``pulseCharacterId`` (when available)
          // so the region-aware cache flushes BOTH the
          // ``pulse:<pcid>`` and the name-keyed entries together — a
          // streamer who switched servers and re-faced the same
          // opponent gets their freshly-uploaded encounter reflected on
          // the very next envelope tick on either keying scheme.
          if (typeof deps.overlayLive.invalidateEnrichmentForOpponent === "function") {
            const seen = new Set();
            for (const g of competitiveIncoming) {
              const name = g?.opponent?.displayName;
              if (typeof name !== "string" || !name) continue;
              const key = name.toLowerCase();
              if (seen.has(key)) continue;
              seen.add(key);
              const pcid = g?.opponent?.pulseCharacterId;
              try {
                deps.overlayLive.invalidateEnrichmentForOpponent(
                  userId,
                  name,
                  pcid,
                );
              } catch (err) {
                if (req.log) {
                  req.log.warn(
                    { err, userId, name },
                    "overlay_enrichment_invalidate_failed",
                  );
                }
              }
            }
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
 * @param {{refreshCurrentMmr?: boolean}} [opts]
 */
async function emitSessionUpdate(io, games, userId, opts = {}) {
  if (!io || !games || !userId) return;
  /** @type {any[]} */
  const sockets = await io.in(`user:${userId}`).fetchSockets();
  let refreshCurrentMmr = !!opts.refreshCurrentMmr;
  for (const socket of sockets) {
    if (socket?.data?.kind !== "overlay") continue;
    /** @type {string|undefined} */
    const tz = socket.data.timezone;
    try {
      const session = await games.todaySession(userId, tz, {
        refreshCurrentMmr,
      });
      // The first successful resolve bypasses and repopulates the
      // process-wide Pulse cache. Remaining overlay sockets can reuse
      // that fresh value instead of issuing one network request each.
      refreshCurrentMmr = false;
      if (session) socket.emit("overlay:session", session);
    } catch {
      // Per-overlay failure is non-fatal — keep walking the list so
      // one bad socket doesn't starve the others of their update.
    }
  }
  // A Browser Source can be disconnected while the match finishes
  // (scene unloaded, OBS restart). Still repopulate the Pulse cache for
  // a fresh game so reconnecting seconds later cannot resurrect the
  // pre-game rating. This remains fire-and-forget with the ingest route.
  if (refreshCurrentMmr) {
    try {
      await games.todaySession(userId, undefined, {
        refreshCurrentMmr: true,
      });
    } catch {
      // Best-effort cache warm; the next connect/refresher retries.
    }
  }
}

// How recently a game must have ENDED for its ingest to fan out an
// ``overlay:live`` post-game payload. A real game's upload lands
// within seconds-to-a-couple-minutes of the score screen (file
// settle + parse + POST); anything older is a historical re-upload
// that must never hit the live stream. Generous enough to absorb a
// slow parse queue on a potato PC, tight enough that backfill batches
// (whole ladder histories) never qualify.
const OVERLAY_LIVE_FRESHNESS_MS = 15 * 60 * 1000;

/**
 * Pick the game whose ingest should drive the ``overlay:live``
 * fan-out: the most recently PLAYED accepted game of the batch,
 * provided it ended within the freshness window. Returns null when
 * the whole batch is historical (resync / reclassify / import) —
 * the caller then skips the overlay entirely.
 *
 * @param {Array<Record<string, any>>} incoming  validated game bodies
 * @param {Array<{gameId: string, created: boolean}>} accepted upsert outcomes
 * @returns {Record<string, any> | null}
 */
function pickFreshOverlayGame(incoming, accepted) {
  // A retry or second agent can re-upload the same just-finished replay
  // inside the 15-minute window. Only the insert owns the one post-game
  // fan-out; accepted updates must not re-fire widgets or poison cache.
  const acceptedIds = new Set(
    accepted.filter((a) => a.created === true).map((a) => a.gameId),
  );
  let best = null;
  let bestTime = -Infinity;
  for (const g of incoming) {
    if (!g || !acceptedIds.has(g.gameId)) continue;
    const t = Date.parse(g.date);
    if (!Number.isFinite(t)) continue;
    if (t > bestTime) {
      best = g;
      bestTime = t;
    }
  }
  if (!best) return null;
  if (Date.now() - bestTime > OVERLAY_LIVE_FRESHNESS_MS) return null;
  return best;
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
 * The payload is stamped with a ``gameKey`` field so the overlay
 * client can correlate against the agent's pre-game envelope:
 *
 *   * If the broker's latest envelope is for the SAME opponent we
 *     just ingested, reuse its ``gameKey`` — that way the post-game
 *     payload carries exactly the key the loading screen showed and
 *     the client treats them as one match.
 *   * Otherwise (agent offline at game-start, or a mismatched
 *     opponent because the agent missed the live phase entirely),
 *     fall back to ``game.gameId`` — still unique per game, just not
 *     name-derivable.
 *
 * @param {import('socket.io').Server} io
 * @param {import('../services/overlayLive').OverlayLiveService} overlayLive
 * @param {import('../services/types').OverlayTokensService} overlayTokens
 * @param {string} userId
 * @param {Record<string, any>} game
 * @param {import('../services/liveGameBroker').LiveGameBroker|null} broker
 * @param {import('../services/multichatEngagement').MultichatEngagementService|null} [engagement]
 */
async function emitOverlayLive(
  io,
  overlayLive,
  overlayTokens,
  userId,
  game,
  broker,
  engagement = null,
) {
  if (!io || !overlayLive || !overlayTokens || !userId || !game) return;
  // ``buildFromGame`` is declared ``Promise<object|null>`` on the
  // service; this route stamps/reads dynamic fields (``gameKey``,
  // ``oppName``), so hold it as a string-keyed record locally.
  /** @type {Record<string, any> | null} */
  const payload = await overlayLive.buildFromGame(userId, game);
  if (!payload) return;
  payload.gameKey = pickGameKey(broker, userId, game, payload);
  // Cache the post-game payload on the broker so an
  // ``overlay:resync`` from a reconnected Browser Source can replay
  // it without re-running the full Mongo aggregation. Best-effort —
  // a missing broker just skips the cache.
  if (broker && typeof broker.setLatestOverlayLive === "function") {
    try {
      broker.setLatestOverlayLive(userId, payload);
    } catch {
      /* caching is advisory; never break the fan-out */
    }
  }
  // ``list`` returns *all* tokens for the user (active + revoked).
  // Filter the revoked ones out so a leaked-then-revoked token can't
  // still receive live data after revocation.
  const items = await overlayTokens.list(userId);
  const activeTokens = [];
  for (const t of items) {
    if (!t || !t.token) continue;
    if (t.revokedAt) continue;
    activeTokens.push(t.token);
    io.to(`overlay:${t.token}`).emit("overlay:live", payload);
  }
  // Engagement hooks — settle Crystal Ball predictions against the
  // replay-verified result, and flag clip-worthy game moments. Both
  // best-effort: engagement must never break the live fan-out.
  if (engagement && activeTokens.length > 0) {
    const eng = engagement;
    try {
      await eng.settlePrediction(activeTokens, {
        gameKey: payload.gameKey,
        result: payload.result,
      });
      const delta = Number(payload.mmrDelta);
      const streak = payload.streak;
      const reasons = [];
      if (Number.isFinite(delta) && Math.abs(delta) >= 30) {
        reasons.push(`${delta > 0 ? "+" : ""}${delta} MMR swing`);
      }
      if (streak && streak.kind === "win" && Number(streak.count) >= 3) {
        reasons.push(`${streak.count}-game win streak`);
      }
      if (Number(payload.durationSec) >= 1200) {
        reasons.push("marathon game");
      }
      if (reasons.length > 0) {
        for (const token of activeTokens) {
          await eng.recordMoment(token, {
            kind: "game-event",
            reason: `${payload.result === "win" ? "Victory" : "Defeat"} vs ${payload.oppName ?? "opponent"} — ${reasons.join(", ")}`,
            gameKey: payload.gameKey,
          });
        }
      }
    } catch {
      /* engagement is advisory */
    }
  }
}

/**
 * Pick the gameKey to stamp on a freshly-derived ``overlay:live``
 * payload. Prefers the broker's current envelope key when the
 * envelope's opponent matches the ingested game's opponent (the
 * common case — agent ran through the whole match). Falls back to
 * ``game.gameId`` so every payload always carries SOME gameKey.
 *
 * @param {import('../services/liveGameBroker').LiveGameBroker|null} broker
 * @param {string} userId
 * @param {Record<string, any>} game
 * @param {Record<string, any>} payload
 * @returns {string}
 */
function pickGameKey(broker, userId, game, payload) {
  if (broker && typeof broker.latest === "function") {
    try {
      // ``latest()`` returns a loosely-typed ``Record<string, unknown>``
      // envelope; view the two fields this correlation reads through a
      // typed lens (runtime guards below stay unchanged).
      const latest =
        /** @type {{ gameKey?: unknown, opponent?: { name?: unknown } } | null} */ (
          broker.latest(userId)
        );
      const latestKey =
        latest && typeof latest.gameKey === "string" ? latest.gameKey : null;
      const latestOppName =
        latest
        && latest.opponent
        && typeof latest.opponent.name === "string"
          ? latest.opponent.name.trim().toLowerCase()
          : null;
      const ingestOppName =
        payload && typeof payload.oppName === "string"
          ? payload.oppName.trim().toLowerCase()
          : null;
      if (latestKey && latestOppName && ingestOppName === latestOppName) {
        return latestKey;
      }
    } catch {
      /* fall through to gameId */
    }
  }
  return String(game.gameId);
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
