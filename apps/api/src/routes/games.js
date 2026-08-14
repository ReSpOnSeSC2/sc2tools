"use strict";

const express = require("express");
const { validateGameRecord } = require("../validation/gameRecord");
const {
  buildClassifierSet,
  isLadderMap,
  LADDER_CLASSIFY_VERSION,
} = require("../util/isLadderMap");
const {
  claimReplayIngestAdmission,
  releaseReplayIngestAdmission,
} = require("../middleware/replayIngestAdmission");

const ANALYSIS_CORPUS_MAX_CONCURRENT = 1;
const ANALYSIS_CORPUS_MAX_WAITERS = 6;
const ANALYSIS_CORPUS_RETRY_AFTER_SEC = 1;
const ANALYSIS_CORPUS_RESPONSE_TIMEOUT_MS = 30_000;
const REPLAY_INGEST_MAX_GAMES = 50;

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
 *   replayFiles?: {
 *     verifyAvailableMarker: (
 *       userId: string,
 *       gameId: string,
 *       marker: Record<string, any>,
 *     ) => Promise<boolean>,
 *   },
 *   io?: import('socket.io').Server,
 *   auth: import('express').RequestHandler,
 *   testOnlyAllowMissingReplayIngestAdmission?: boolean,
 *   runtimeCapacityRegistry?: import('../services/runtimeCapacity').RuntimeCapacityRegistry,
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
  // Skip stale Full Resync batches at the call site below, then keep one
  // worker per user and collapse any burst of genuinely fresh uploads into
  // at most one trailing refresh. Session aggregation may refresh SC2Pulse
  // MMR, so overlapping fire-and-forget calls must remain bounded.
  const scheduleSessionUpdate = createSessionUpdateScheduler(
    deps.io,
    deps.games,
  );
  // One narrowly projected page can still hold thousands of objects plus its
  // JSON serialization buffer. Admit only one page at a time per API process;
  // a small cancellable queue keeps concurrent Arcade users responsive without
  // letting dashboard traffic multiply retained corpus pages during ingest.
  const analysisCorpusAdmission = createAnalysisCorpusAdmission();
  deps.runtimeCapacityRegistry?.register(
    "analysisCorpus",
    () => analysisCorpusAdmission.capacitySnapshot(),
  );
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
   * Memory-bounded complete-history feed for Daily Pulse and Arcade. Unlike
   * the general games list, each response is a strict analysis projection and
   * has a small per-page ceiling; the opaque cursor safely continues through
   * identical replay timestamps.
   */
  router.get("/games/analysis-corpus", async (req, res, next) => {
    const requestAbort = analysisCorpusRequestAbort(req, res);
    /** @type {(() => void) | null} */
    let release = null;
    /** @type {{ markComputeSettled: () => void } | null} */
    let permitGuard = null;
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      release = await analysisCorpusAdmission.acquire(requestAbort.signal);
      if (!release) {
        if (!requestAbort.signal.aborted && !res.headersSent) {
          res.set("Retry-After", String(ANALYSIS_CORPUS_RETRY_AFTER_SEC));
          res.status(503).json({ error: { code: "analysis_corpus_busy" } });
        }
        return;
      }
      // A disconnect can race with the admission hand-off: the waiter is
      // resolved, then the socket closes before the response-lifetime guard
      // installs its listeners. Never strand the sole corpus permit in that
      // window.
      if (
        requestAbort.signal.aborted
        || res.destroyed
        || res.writableEnded
      ) {
        release();
        release = null;
        return;
      }
      // Keep the memory permit until Node has handed the serialized page to
      // the response stream (or the connection closes). Releasing immediately
      // after `res.json()` allows a slow client to retain one large JSON buffer
      // while the next request allocates another. The timeout prevents a
      // stalled authenticated client from monopolizing the only corpus lane.
      permitGuard = holdAnalysisCorpusPermit(res, release);
      release = null;
      const result = await deps.games.listAnalysisCorpus(auth.userId, {
        limit: parseLimit(req.query.limit),
        cursor:
          typeof req.query.cursor === "string"
            ? req.query.cursor
            : undefined,
        signal: requestAbort.signal,
      });
      if (!requestAbort.signal.aborted && !res.headersSent) res.json(result);
    } catch (err) {
      if (requestAbort.signal.aborted || isAbortError(err)) return;
      next(err);
    } finally {
      // A closed socket aborts the Mongo query, but cancellation is not
      // instantaneous. Do not hand the sole memory permit to another request
      // until this page's computation has actually unwound as well.
      if (permitGuard) permitGuard.markComputeSettled();
      if (release) release();
      requestAbort.cleanup();
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
    // A client can disconnect while asynchronous auth is resolving. The
    // pre-route close handler then releases its slot; never start heavy ingest
    // work after that release or concurrency would become unbounded again.
    if (!claimReplayIngestAdmission(res, {
      allowMissing: deps.testOnlyAllowMissingReplayIngestAdmission === true,
    })) {
      // A closed socket needs no response. A live request with no admission
      // state means this router was mounted unsafely; fail visibly instead of
      // running unbounded or leaving the caller hanging.
      if (!res.headersSent && !res.destroyed) {
        res.status(503).json({
          error: {
            code: "replay_ingest_admission_unavailable",
            message: "Replay ingest admission is unavailable.",
            retryable: true,
          },
        });
      }
      return;
    }
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      const userId = auth.userId;
      if (
        Array.isArray(req.body?.games)
        && req.body.games.length > REPLAY_INGEST_MAX_GAMES
      ) {
        // Reject before validation/result arrays or any Mongo/R2 work. The
        // desktop agent already batches at this ceiling; this protects the
        // JSON route from a tiny-item array that expands into a huge rejection
        // response or monopolizes the single ingest lane.
        req.body = undefined;
        res.status(413).json({
          error: {
            code: "replay_batch_too_large",
            message: `Replay batches are limited to ${REPLAY_INGEST_MAX_GAMES} games.`,
            retryable: false,
            maxGames: REPLAY_INGEST_MAX_GAMES,
          },
        });
        return;
      }
      const incoming = Array.isArray(req.body?.games)
        ? req.body.games
        : [req.body];
      // ``incoming`` now owns the only references the ingest loop needs.
      // Drop Express's wrapper immediately so singleton uploads do not retain
      // a second request-level reference to their heavy object.
      req.body = undefined;
      /** @type {Array<{
       *   gameId: string,
       *   created: boolean,
       *   quarantined?: boolean,
       *   replayArchive?: {
       *     available: boolean,
       *     sizeBytes?: number,
       *     sha256?: string,
       *     storedAt?: Date|string,
       *   },
       * }>} */
      const accepted = [];
      const competitiveAccepted = [];
      const competitiveIncoming = [];
      /** @type {Array<{
       *   gameId: string,
       *   created: boolean,
       *   quarantined?: boolean,
       *   replayArchive?: {
       *     available: boolean,
       *     sizeBytes?: number,
       *     sha256?: string,
       *     storedAt?: Date|string,
       *   },
       * }>} */
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
      // Consume by index and clear each heavy parsed item after it is durably
      // handled. This lets V8 reclaim earlier build/macro/playback arrays while
      // later games are still doing sequential R2/Mongo work, instead of
      // pinning the whole 5 MB body until the response.
      for (let incomingIndex = 0; incomingIndex < incoming.length; incomingIndex += 1) {
        const raw = incoming[incomingIndex];
        // Clear the body-array reference immediately. ``raw``/``game`` owns
        // this one item until the loop advances; compact realtime metadata is
        // copied separately before then.
        incoming[incomingIndex] = undefined;
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
        // Realtime work needs only a few scalar identity/result fields. Never
        // retain another reference to this game's heavy build/macro/playback
        // arrays for the rest of the batch: req.body is already holding them.
        competitiveIncoming.push(compactGameForRealtime(game));
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
        let customBuildRevision = null;
        try {
          if (typeof deps.games.upsertWithRevision === "function") {
            const stored = await deps.games.upsertWithRevision(userId, game);
            created = stored.created;
            customBuildRevision = stored.customBuildRevision;
          } else {
            created = await deps.games.upsert(userId, game);
          }
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
            // Preserve the tri-state contract: true = fresh agent already
            // tried, false = historical agent deliberately deferred to the
            // bounded cloud backfill, undefined = legacy client behavior.
            pulseLookupAttempted: game.opponent.pulseLookupAttempted,
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
        // by the next upload. A storage failure here must remain retryable:
        // GamesService intentionally invalidates old custom provenance before
        // this hook evaluates the fresh payload. Acknowledging the replay in
        // that gap would make the agent advance permanently while the replay
        // disappears from authoritative custom/community totals.
        if (deps.customBuilds && typeof deps.customBuilds.tagSingleGame === "function") {
          try {
            await deps.customBuilds.tagSingleGame(userId, game, {
              expectedRevision: customBuildRevision,
            });
          } catch (e) {
            if (req.log) {
              req.log.warn(
                { err: e, gameId: game.gameId, userId },
                "ingest_custom_build_tag_failed",
              );
            }
            rejected.push({
              gameId: game.gameId,
              retryable: true,
              errors: ["custom_build_tag_retry_required"],
            });
            continue;
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
      // Full Re-sync used to follow every accepted game with a replay-upload
      // prepare call. Fetch all marker identities in one Mongo query, then
      // verify each candidate object with a bounded, sequential HEAD before a
      // current agent is allowed to skip its normal repair path. Sequential
      // verification preserves the existing per-request R2 pressure ceiling.
      // On any uncertainty we omit the additive field, which makes the agent
      // fall back to the idempotent prepare/upload flow instead of falsely
      // acknowledging a missing private backup.
      if (
        accepted.length > 0
        && typeof deps.games.replayArchiveMarkers === "function"
        && deps.replayFiles
        && typeof deps.replayFiles.verifyAvailableMarker === "function"
      ) {
        try {
          const markers = await deps.games.replayArchiveMarkers(
            userId,
            accepted.map((item) => item.gameId),
          );
          let archiveVerificationAvailable = true;
          for (const item of accepted) {
            const marker = markers.get(item.gameId) || { available: false };
            if (marker.available !== true) {
              item.replayArchive = marker;
              continue;
            }
            if (!archiveVerificationAvailable) continue;
            try {
              const verified = await deps.replayFiles.verifyAvailableMarker(
                userId,
                item.gameId,
                marker,
              );
              item.replayArchive = verified
                ? marker
                : { available: false };
            } catch (err) {
              // A thrown HEAD error is normally an object-store outage, not
              // a per-game absence (missing objects return false). Stop the
              // batch here so one R2 incident cannot multiply SDK retries by
              // 50 and hold the ingest request open for minutes. Omitted
              // fields make the durable archive lane repair these later.
              archiveVerificationAvailable = false;
              if (req.log) {
                req.log.warn(
                  { err, userId, gameId: item.gameId },
                  "ingest_replay_archive_verify_failed",
                );
              }
            }
          }
        } catch (err) {
          if (req.log) {
            req.log.warn(
              { err, userId, accepted: accepted.length },
              "ingest_replay_archive_markers_failed",
            );
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
        // Recompute the session card immediately only for a genuinely new,
        // just-finished match. Existing-row reuploads do not change W-L, and
        // historical inserts from Full Resync cannot belong to the active
        // four-hour session. Scheduling every stale batch used to launch
        // overlapping Mongo/Pulse work until the small production instance
        // ran out of memory. The periodic session refresher remains the
        // safety net for an unusually delayed fresh upload.
        //
        // We can't broadcast to the whole user room because each overlay
        // carries its own timezone in ``socket.data.timezone`` — "today"
        // depends on the streamer's wall clock, not UTC. Best-effort: a
        // transient socket lookup failure must not block the ingest response.
        if (freshGame) {
          scheduleSessionUpdate(
            userId,
            { refreshCurrentMmr: true },
            (err) => {
              if (req.log) {
                req.log.warn(
                  { err, userId },
                  "overlay_session_emit_failed",
                );
              }
            },
          );
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
    } finally {
      // Fire-and-forget realtime callbacks may outlive this response. They use
      // compact payloads above, so drop the large parsed batch from the request
      // before handing control back to Express rather than retaining it via a
      // request-scoped logger closure.
      req.body = undefined;
      // The global admission gate is acquired before JSON parsing. Release it
      // only after every Mongo/R2 operation above has stopped; disconnecting a
      // client does not cancel this handler's async work.
      releaseReplayIngestAdmission(res);
    }
  });

  return router;
}

/**
 * Build a per-user single-flight scheduler around ``emitSessionUpdate``.
 *
 * Ingest requests deliberately do not await overlay work, so a resync may
 * enqueue another batch while the previous session aggregate is still
 * resolving. For each user this scheduler permits exactly one active run and
 * one coalesced trailing run. Calls received during either active run only
 * mark that one trailing slot; memory and Mongo/Pulse concurrency therefore
 * stay bounded no matter how long the resync lasts.
 *
 * A fresh post-game upload must still invalidate the cached current MMR. The
 * trailing slot promotes ``refreshCurrentMmr`` with boolean OR, ensuring one
 * fresh update cannot dilute another queued fresh update.
 *
 * Different users retain independent workers so one user's long refresh does
 * not delay another user's live session update.
 *
 * @param {import('socket.io').Server|undefined} io
 * @param {import('../services/types').GamesService} games
 * @returns {(
 *   userId: string,
 *   opts?: {refreshCurrentMmr?: boolean},
 *   onError?: (err: unknown) => void,
 * ) => Promise<void>}
 */
function createSessionUpdateScheduler(io, games) {
  /** @type {Map<string, {
   *   trailing: boolean,
   *   trailingRefreshCurrentMmr: boolean,
   *   onError?: (err: unknown) => void,
   *   done?: Promise<void>,
   * }>} */
  const activeByUser = new Map();

  return function scheduleSessionUpdate(userId, opts = {}, onError) {
    if (!io || !games || !userId) return Promise.resolve();
    const refreshCurrentMmr = !!opts.refreshCurrentMmr;
    const active = activeByUser.get(userId);
    if (active) {
      active.trailing = true;
      active.trailingRefreshCurrentMmr =
        active.trailingRefreshCurrentMmr || refreshCurrentMmr;
      // Retain only the latest request logger instead of every request
      // closure in a long resync burst.
      if (onError) active.onError = onError;
      return active.done || Promise.resolve();
    }

    const state = {
      trailing: false,
      trailingRefreshCurrentMmr: false,
      onError,
      /** @type {Promise<void>|undefined} */
      done: undefined,
    };
    activeByUser.set(userId, state);

    state.done = (async () => {
      let refresh = refreshCurrentMmr;
      while (true) {
        try {
          await emitSessionUpdate(io, games, userId, {
            refreshCurrentMmr: refresh,
          });
        } catch (err) {
          try {
            if (state.onError) state.onError(err);
          } catch {
            // Logging is advisory; a broken request logger cannot wedge the
            // user's single-flight state forever.
          }
        }

        if (!state.trailing) return;
        refresh = state.trailingRefreshCurrentMmr;
        state.trailing = false;
        state.trailingRefreshCurrentMmr = false;
      }
    })().finally(() => {
      if (activeByUser.get(userId) === state) {
        activeByUser.delete(userId);
      }
    });

    return state.done;
  };
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
        reuseRecent: true,
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
        reuseRecent: true,
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
 * Copy only fields consumed by OverlayLiveService and cache invalidation.
 * Keeping full validated objects here used to retain every batch member's
 * heavy analysis arrays until the final game and archive checks completed.
 *
 * @param {Record<string, any>} game
 * @returns {Record<string, any>}
 */
function compactGameForRealtime(game) {
  const opponent = game?.opponent;
  return {
    gameId: game.gameId,
    date: game.date,
    result: game.result,
    myRace: game.myRace,
    myLadderRace: game.myLadderRace,
    myMmr: game.myMmr,
    myToonHandle: game.myToonHandle,
    map: game.map,
    durationSec: game.durationSec,
    opponent: opponent && typeof opponent === "object"
      ? {
          pulseId: opponent.pulseId,
          pulseCharacterId: opponent.pulseCharacterId,
          displayName: opponent.displayName,
          race: opponent.race,
          mmr: opponent.mmr,
          strategy: opponent.strategy,
        }
      : undefined,
  };
}

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

/**
 * Small abort-aware semaphore for analysis-corpus pages. A released slot is
 * handed directly to the oldest live waiter, so active work never exceeds the
 * configured ceiling even when a new request races the wake-up.
 *
 * @param {{maxActive?: number, maxWaiters?: number}} [opts]
 */
function createAnalysisCorpusAdmission(opts = {}) {
  const maxActive = Math.max(
    1,
    Math.floor(Number(opts.maxActive)) || ANALYSIS_CORPUS_MAX_CONCURRENT,
  );
  const maxWaiters = Math.max(
    0,
    Number.isFinite(Number(opts.maxWaiters))
      ? Math.floor(Number(opts.maxWaiters))
      : ANALYSIS_CORPUS_MAX_WAITERS,
  );
  let active = 0;
  /** @type {Array<{signal: AbortSignal, resolve: (release: (() => void) | null) => void}>} */
  const waiters = [];

  function releaseSlot() {
    while (waiters.length > 0) {
      const next = waiters.shift();
      if (!next || next.signal.aborted) continue;
      next.resolve(makeRelease());
      return;
    }
    active = Math.max(0, active - 1);
  }

  function makeRelease() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseSlot();
    };
  }

  /** @param {AbortSignal} signal */
  function acquire(signal) {
    if (signal.aborted) return Promise.resolve(null);
    if (active < maxActive) {
      active += 1;
      return Promise.resolve(makeRelease());
    }
    if (waiters.length >= maxWaiters) return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      /** @type {() => void} */
      let onAbort = () => {};
      /** @param {(() => void) | null} slot */
      const finish = (slot) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(slot);
      };
      const waiter = { signal, resolve: finish };
      onAbort = () => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        finish(null);
      };
      waiters.push(waiter);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  function capacitySnapshot() {
    return {
      activeRequests: active,
      queuedRequests: waiters.length,
      maxActiveRequests: maxActive,
      maxQueuedRequests: maxWaiters,
    };
  }

  return { acquire, capacitySnapshot };
}

/**
 * Tie queued/active corpus work to the HTTP connection.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
function analysisCorpusRequestAbort(req, res) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const close = () => {
    if (!res.writableEnded) abort();
  };
  req.once("aborted", abort);
  res.once("close", close);
  return {
    signal: controller.signal,
    cleanup() {
      req.removeListener("aborted", abort);
      res.removeListener("close", close);
    },
  };
}

/**
 * Transfer an acquired corpus permit to the HTTP response lifetime.
 * @param {import('express').Response} res
 * @param {() => void} release
 * @param {number} [timeoutMs]
 * @returns {{ markComputeSettled: () => void }}
 */
function holdAnalysisCorpusPermit(
  res,
  release,
  timeoutMs = ANALYSIS_CORPUS_RESPONSE_TIMEOUT_MS,
) {
  let released = false;
  let responseSettled = false;
  let computeSettled = false;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  const releaseWhenSafe = () => {
    if (released || !responseSettled || !computeSettled) return;
    released = true;
    if (timer) clearTimeout(timer);
    res.removeListener("finish", responseDone);
    res.removeListener("close", responseDone);
    release();
  };
  const responseDone = () => {
    responseSettled = true;
    releaseWhenSafe();
  };
  // The response may already have closed before this helper is entered.
  // Record that side of the latch synchronously rather than waiting for a
  // close event that Node has already emitted. The computation must still
  // settle before the permit is transferred.
  if (res.destroyed || res.writableEnded) {
    responseSettled = true;
  } else {
    timer = setTimeout(() => {
      if (!res.writableEnded) res.destroy();
      responseDone();
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    res.once("finish", responseDone);
    res.once("close", responseDone);
  }
  return {
    markComputeSettled() {
      computeSettled = true;
      releaseWhenSafe();
    },
  };
}

/** @param {unknown} err */
function isAbortError(err) {
  return !!(
    err
    && typeof err === "object"
    && /** @type {{name?: unknown}} */ (err).name === "AbortError"
  );
}

module.exports = {
  buildGamesRouter,
  createSessionUpdateScheduler,
  createAnalysisCorpusAdmission,
  holdAnalysisCorpusPermit,
};
