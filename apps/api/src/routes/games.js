"use strict";

const express = require("express");
const { validateGameRecord } = require("../validation/gameRecord");
const { regionFromToonHandle } = require("../util/regionFromToonHandle");

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
 *     getProfile?: (userId: string) => Promise<{ pulseIds?: string[] }>,
 *   },
 *   pulseMmr?: {
 *     getCurrentMmr(pulseId: string): Promise<{ mmr: number, region: string|null } | null>,
 *     getCurrentMmrForAny?(
 *       ids: string[],
 *       opts?: { preferredRegion?: string|null },
 *     ): Promise<{ mmr: number, region: string|null } | null>,
 *   },
 *   customBuilds?: import('../services/types').CustomBuildsService,
 *   overlayLive?: import('../services/overlayLive').OverlayLiveService,
 *   overlayTokens?: import('../services/types').OverlayTokensService,
 *   liveGameBroker?: import('../services/liveGameBroker').LiveGameBroker,
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
      // Hoist the user's profile once per batch so a 100-replay
      // Resync that lands here doesn't make 100 round-trips to fetch
      // the same pulseIds. The myMmr filler below reads from it.
      const userProfile = await loadUserProfile(deps.users, userId);
      // Per-batch in-memory negative cache: once we've established
      // that Pulse has no team for this user's pulseIds in this
      // region, skip every subsequent game in the batch instead of
      // hitting Pulse for each. Keyed by ``${preferredRegion}`` since
      // a multi-region streamer's NA games can still benefit from a
      // null EU result and vice-versa.
      /** @type {Map<string, number|null>} */
      const myMmrPerRegion = new Map();
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
        // SC2Pulse fill for the streamer's own MMR. sc2reader usually
        // carries ``myMmr`` for the player's own row, but a sizable
        // cohort of replays (mods, certain build versions) ship with
        // it null — and the bingo MMR predicates (``win_vs_higher_mmr``
        // / ``win_close_mmr``) need it to compute the delta against
        // the opponent's MMR. Region-aware via the opponent's toon
        // handle (in 1v1 ladder both players are on the same server).
        // Cached per-region for the duration of this batch AND
        // per-character inside PulseMmrService's 5-minute LRU.
        if (
          typeof game.myMmr !== "number"
          && deps.pulseMmr
          && userProfile
          && Array.isArray(userProfile.pulseIds)
          && userProfile.pulseIds.length > 0
        ) {
          const preferredRegion = pickRegionForGame(game);
          const cacheKey = preferredRegion || "any";
          let mmr;
          if (myMmrPerRegion.has(cacheKey)) {
            mmr = myMmrPerRegion.get(cacheKey);
          } else {
            mmr = await fetchMyMmrFromPulse(
              deps.pulseMmr,
              userProfile.pulseIds,
              preferredRegion,
            );
            myMmrPerRegion.set(cacheKey, mmr);
          }
          if (typeof mmr === "number") {
            game.myMmr = mmr;
          }
        }
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
              deps.liveGameBroker || null,
            ).catch((err) => {
              if (req.log) {
                req.log.warn(
                  { err, userId },
                  "overlay_live_emit_failed",
                );
              }
            });
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
            for (const g of incoming) {
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
 */
async function emitOverlayLive(
  io,
  overlayLive,
  overlayTokens,
  userId,
  game,
  broker,
) {
  if (!io || !overlayLive || !overlayTokens || !userId || !game) return;
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
  for (const t of items) {
    if (!t || !t.token) continue;
    if (t.revokedAt) continue;
    io.to(`overlay:${t.token}`).emit("overlay:live", payload);
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
      const latest = broker.latest(userId);
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

/**
 * Load the user profile we need for the myMmr fill. Returns ``null``
 * when the UsersService isn't wired (unit tests) or the user has no
 * pulseIds — both cases short-circuit the fill caller to a no-op.
 *
 * @param {any} usersService
 * @param {string} userId
 * @returns {Promise<{pulseIds: string[]}|null>}
 */
async function loadUserProfile(usersService, userId) {
  if (!usersService || typeof usersService.getProfile !== "function") {
    return null;
  }
  try {
    const profile = await usersService.getProfile(userId);
    if (!profile) return null;
    const pulseIds = Array.isArray(profile.pulseIds) ? profile.pulseIds : [];
    return { pulseIds };
  } catch {
    return null;
  }
}

/**
 * Derive the region SC2Pulse should prefer for this game. 1v1 ladder
 * games have both players on the same server, so the opponent's
 * toon_handle is a reliable proxy. Falls back to the streamer's own
 * ``myToonHandle`` when the opponent's isn't present (rare, but the
 * agent emits this on v0.5.x+).
 *
 * @param {any} game
 * @returns {string|null}
 */
function pickRegionForGame(game) {
  const oppHandle = game && game.opponent && game.opponent.toonHandle;
  const myHandle = game && game.myToonHandle;
  return regionFromToonHandle(oppHandle) || regionFromToonHandle(myHandle);
}

/**
 * Best-effort SC2Pulse fetch for the streamer's current 1v1 MMR.
 * Region-aware via ``preferredRegion``. Returns the resolved integer
 * MMR, or ``null`` when:
 *   * the pulseMmr client is missing the multi-id ``getCurrentMmrForAny``
 *     method AND no pulseIds were supplied (defensive);
 *   * SC2Pulse has no team for any of the supplied character ids in
 *     the relevant region(s);
 *   * the call throws (rate-limited / network error / timeout).
 *
 * Trusted to mutate nothing — the caller is responsible for stamping
 * the result onto the game record.
 *
 * @param {any} pulseMmr
 * @param {string[]} pulseIds
 * @param {string|null} preferredRegion
 * @returns {Promise<number|null>}
 */
async function fetchMyMmrFromPulse(pulseMmr, pulseIds, preferredRegion) {
  if (!pulseMmr || !Array.isArray(pulseIds) || pulseIds.length === 0) {
    return null;
  }
  try {
    let result = null;
    if (typeof pulseMmr.getCurrentMmrForAny === "function") {
      result = await pulseMmr.getCurrentMmrForAny(pulseIds, {
        preferredRegion: preferredRegion || undefined,
      });
    } else if (typeof pulseMmr.getCurrentMmr === "function") {
      result = await pulseMmr.getCurrentMmr(pulseIds[0]);
    }
    if (!result) return null;
    const mmr = Number(result.mmr);
    if (!Number.isFinite(mmr) || mmr <= 0) return null;
    return Math.round(mmr);
  } catch {
    return null;
  }
}

module.exports = {
  buildGamesRouter,
  // Exported for unit tests of the myMmr fill path; not part of the
  // public service contract.
  _testing: { loadUserProfile, pickRegionForGame, fetchMyMmrFromPulse },
};
