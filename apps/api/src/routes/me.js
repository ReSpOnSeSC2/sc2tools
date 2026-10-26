"use strict";

const express = require("express");
const { buildDoctor, withReplayResyncState, emptyReplayArchiveCounts } = require("../services/doctor");
const { NOTIFICATIONS_PREF_TYPE, sanitizeNotificationPrefs } = require("../services/notificationPrefs");
const { validateProfile } = require("../validation/profile");
const { publicDataRetention } = require("../services/dataInventory");
const {
  claimReplayIngestAdmission,
  releaseReplayIngestAdmission,
} = require("../middleware/replayIngestAdmission");
const { browserUploadStatusOf } = require("../services/replayFilesCors");
const { sanitizeAnalyzerViews } = require("../util/analyzerViews");
const { sanitizeRivals } = require("../util/rivalsPreferences");
const { OPPONENT_SCOUTING_PREF_TYPE, sanitizeOpponentScouting } = require("../util/opponentScoutingPreferences");
const { PREF_TYPE: TWITCH_PREF_TYPE, sanitizeTwitchAutomation } = require("../services/twitchAutomationPolicy");
const { sanitizeChatCommands } = require("../services/chatCommands");
const {
  CHECKIN_PREF_TYPE,
  sanitizeCheckinPrefs,
} = require("../services/buildIntentPrefs");

// Hard cap on the per-request MMR fan-out. Profiles with many toons
// are rare but legitimate (smurf accounts, region-hoppers); we cap to
// keep the SC2Pulse outbound burst bounded and the payload small —
// the dashboard caller surfaces a "+N more" indicator from
// ``truncated`` when this kicks in.
const ME_MMR_MAX_TOONS = 8;

/**
 * /v1/me — sanity endpoint for the web app. Returns the user record
 * + last-sync timestamps so the SPA can render onboarding state.
 *
 * Also hosts:
 *   GET    /me/profile              — read battleTag/pulseId/region/preferredRace/displayName
 *   PUT    /me/profile              — replace those fields (also reachable via the
 *                                     agent's device-token, so the desktop app can
 *                                     read its handle from the cloud after pairing)
 *   GET    /me/preferences/:type    — read stored preferences ("misc" | "voice")
 *   PUT    /me/preferences/:type    — replace preferences for that type ("buildCheckin"
 *                                     also pings ``build-intent:changed {prefs: true}``)
 *   GET    /me/analyzer-default-view — one private selected-view/legacy-tab lookup
 *   GET    /me/doctor               — diagnostic warnings (no agent, no profile, etc.)
 *   GET    /me/replay-archive-status — one-time original replay backfill progress
 *   POST   /me/replay-archive-resync — agent acknowledges a full local re-sync
 *   GET    /me/export               — download every per-user record as JSON
 *   DELETE /me                      — permanently delete the account
 *   GET    /me/backups              — list manual snapshots
 *   POST   /me/backups              — take a manual snapshot
 *   POST   /me/backups/:id/restore  — restore from a snapshot
 *
 * @param {{
 *   users: import('../services/types').UsersService & Pick<import('../services/users').UsersService, 'getAnalyzerDefaultView'>,
 *   announcements?: import('../services/announcements').AnnouncementsService,
 *   games: import('../services/types').GamesService,
 *   gdpr: import('../services/gdpr').GdprService,
 *   backupStatus?: import('../services/backupStatus').BackupStatusService,
 *   dataRepairs?: import('../services/dataRepairs').DataRepairsService,
 *   pairings: import('../services/devicePairings').DevicePairingsService,
 *   imports?: import('../services/import').ImportService,
 *   multichatSounds?: import('../services/multichatSounds').MultichatSoundsService,
 *   replayArchiveEnabled?: boolean,
 *   browserUploadCors?: import('../services/replayFilesCors').BrowserUploadCorsStatus|null,
 *   clerk?: import('../services/clerkClient').ClerkClient,
 *   pulseMmr?: {
 *     getCurrentMmr(pulseId: string): Promise<{
 *       mmr: number,
 *       region: string | null,
 *       characterId?: string | null,
 *     } | null>,
 *     getBattleTags?(ids: string[]): Promise<string[]>,
 *   },
 *   auth: import('express').RequestHandler,
 *   isAdmin?: (req: import('express').Request) => boolean,
 *   isAdminEmail?: (email: string) => boolean,
 *   onAdminGranted?: (clerkUserId: string) => void,
 *   buildIntents?: { preferencesChanged(userId: string, type: string): void } | null,
 *   ghostConfig?: import('../services/ghostConfig').GhostConfigService,
 *   onRivalsChanged?: (userId:string) => void,
 *   onScoutingChanged?: (userId:string) => void,
 *   logger?: import('pino').Logger,
 * }} deps
 */
function buildMeRouter(deps) {
  const router = express.Router();
  const isAdmin = deps.isAdmin || (() => false);
  const isAdminEmail = deps.isAdminEmail || (() => false);
  const clerk = deps.clerk || null;

  router.get("/site/data-retention", async (_req, res, next) => {
    try {
      res.set("Cache-Control", "public, max-age=60");
      res.json(deps.backupStatus ? await publicDataRetention(deps.backupStatus) : { available: false, retention: [], checkedAt: null });
    } catch (error) { next(error); }
  });
  router.get("/me/data-inventory", deps.auth, async (req, res, next) => {
    try {
      if (!req.auth) throw new Error("auth_required");
      res.set("Cache-Control", "private, no-store");
      res.json(await deps.gdpr.inventory(req.auth.userId));
    } catch (error) { next(error); }
  });

  // Auth applied per-route, NOT via router.use(). Router-level middleware
  // here would intercept every /v1/* request that doesn't match an
  // earlier-mounted router, blocking unauthenticated endpoints like
  // /v1/device-pairings/start with a spurious 401.
  router.get("/me", deps.auth, async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      await deps.users.touch(auth.userId);
      await deps.announcements?.deliverMajors(auth.userId);
      const [stats, summary, agent, activeImportJob, onboarding] =
        await Promise.all([
          deps.games.stats(auth.userId),
          deps.users.getSummary(auth.userId),
          deps.pairings.latestAgent(auth.userId),
          // Optional deps so narrow tests (and older wiring) that don't
          // inject them keep working — the fields just come back null.
          deps.imports ? deps.imports.activeJob(auth.userId) : null,
          deps.users.getPreferences(auth.userId, "onboarding"),
        ]);
      // Lazy email backfill: if the row pre-dates the webhook (or no
      // webhook is configured), pull the email from Clerk on first read
      // and cache it. Best-effort — clerk.getEmail returns null on
      // failure and we just render "—" until the next request.
      let email = summary.email;
      if (!email && clerk && auth.source === "clerk" && auth.clerkUserId) {
        const fresh = await clerk.getEmail(auth.clerkUserId);
        if (fresh) {
          email = fresh;
          // Awaited so that subsequent requests in the same client
          // session see the cached value. setEmail is a no-op when the
          // value hasn't changed, so this stays cheap.
          try {
            await deps.users.setEmail(auth.userId, fresh);
          } catch (err) {
            if (deps.logger) {
              deps.logger.warn(
                { err, userId: auth.userId },
                "users_set_email_failed",
              );
            }
          }
        }
      }
      // Email-allowlist admin grant. When the caller's verified email is
      // on SC2TOOLS_ADMIN_EMAILS and they aren't an admin yet, persist
      // the role and push their Clerk id into the live allowlist so this
      // very response — and every later /v1/admin + socket check —
      // reports admin. Deterministic and operator-controlled: no email
      // is hard-coded, the grant is idempotent, and grantAdmin refuses
      // rows without a Clerk identity.
      let admin = isAdmin(req);
      if (!admin && email && isAdminEmail(email)) {
        try {
          const granted = await deps.users.grantAdmin(
            auth.userId,
            "email_allowlist",
          );
          if (granted) {
            if (typeof deps.onAdminGranted === "function") {
              deps.onAdminGranted(granted.clerkUserId);
            }
            admin = true;
          }
        } catch (err) {
          if (deps.logger) {
            deps.logger.warn(
              { err, userId: auth.userId },
              "email_admin_grant_failed",
            );
          }
        }
      }
      res.json({
        userId: auth.userId,
        source: auth.source,
        games: stats,
        email,
        agentVersion: agent.version,
        agentPaired: agent.paired,
        // "Agent online" signal for the onboarding checklist — fresh
        // within ~3min means the heartbeat is alive.
        agentLastSeenAt: agent.lastSeenAt || null,
        // Currently-active import job (if any) so the dashboard can
        // mount the progress card on first paint.
        activeImportJob: activeImportJob || null,
        // Client-only onboarding bits (downloadStartedAt, dismissedAt).
        onboarding: onboarding || {},
        isAdmin: admin,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/me/profile", deps.auth, async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      const profile = await deps.users.getProfile(auth.userId);
      // Decorate the response with auto-detected pulse IDs (the user's
      // own toon handles, derived from the games they've already
      // uploaded). The Settings UI renders these as one-click "add"
      // suggestions so the streamer doesn't have to copy/paste handles
      // by hand. Pure read-only — no DB write happens here; the actual
      // backfill into ``users.pulseIds`` runs on the games ingest
      // path and on demand via POST /v1/me/profile/pulse-ids/detect.
      /** @type {string[]} */
      let detectedPulseIds = [];
      if (deps.games && typeof deps.games.distinctMyToonHandles === "function") {
        try {
          detectedPulseIds = await deps.games.distinctMyToonHandles(auth.userId);
        } catch {
          // Detection is decorative — a games-collection hiccup must
          // never block the profile read.
        }
      }
      // Fold out the IDs the user already has so the SPA can render
      // detected/added states without a client-side diff.
      const known = new Set(
        Array.isArray(profile.pulseIds) ? profile.pulseIds : [],
      );
      const detectedNew = detectedPulseIds.filter((id) => !known.has(id));
      res.json({ ...profile, detectedPulseIds: detectedNew });
    } catch (err) {
      next(err);
    }
  });

  /**
   * One-shot endpoint: copy every auto-detected pulse ID (distinct
   * ``myToonHandle`` from the user's uploaded games) into the user's
   * stored ``pulseIds`` array, deduped against what's already there.
   * Returns the resulting profile.
   *
   * Used by the Settings UI's "Add all detected" button so the user
   * can populate their list without typing.
   */
  router.post(
    "/me/profile/pulse-ids/detect",
    deps.auth,
    async (req, res, next) => {
      try {
        const auth = req.auth;
        if (!auth) throw new Error("auth_required");
        if (!deps.games || typeof deps.games.distinctMyToonHandles !== "function") {
          res.json(await deps.users.getProfile(auth.userId));
          return;
        }
        const detected = await deps.games.distinctMyToonHandles(auth.userId);
        let added = 0;
        for (const id of detected) {
          // ``addPulseId`` is idempotent and bound-checked so a doc
          // with the array already at the cap silently no-ops. The
          // sequential await is fine here because ``detected`` is
          // capped at 20 and each call is a single Mongo round trip.
          const wrote = await deps.users.addPulseId(auth.userId, id);
          if (wrote) added += 1;
        }
        const profile = await deps.users.getProfile(auth.userId);
        res.json({ ...profile, added });
      } catch (err) {
        next(err);
      }
    },
  );

  /**
   * One-shot endpoint: resolve the BattleTag(s) behind the user's
   * saved pulse ids via SC2Pulse and persist them. Replays never carry
   * the ``#discriminator``, so SC2Pulse's account data is the only
   * automated source short of Battle.net OAuth — and we were already
   * hitting the same search endpoint for MMR lookups.
   *
   * One user can own several BattleTags (one per Battle.net account;
   * multi-region/smurf profiles span accounts), so the full deduped
   * list lands in ``battleTags`` while ``battleTag`` (singular) is only
   * auto-filled when the user hasn't typed one — detection never
   * clobbers a manual value.
   *
   * Called automatically by the Settings UI when the BattleTag field
   * is empty and pulse ids exist. Best-effort: a Pulse outage returns
   * the unchanged profile with ``detected: []``.
   */
  router.post(
    "/me/profile/battletag/detect",
    deps.auth,
    async (req, res, next) => {
      try {
        const auth = req.auth;
        if (!auth) throw new Error("auth_required");
        const profile = await deps.users.getProfile(auth.userId);
        const ids = Array.isArray(profile.pulseIds) ? profile.pulseIds : [];
        if (
          ids.length === 0 ||
          !deps.pulseMmr ||
          typeof deps.pulseMmr.getBattleTags !== "function"
        ) {
          res.json({ ...profile, detected: [] });
          return;
        }
        /** @type {string[]} */
        let tags = [];
        try {
          tags = await deps.pulseMmr.getBattleTags(ids);
        } catch {
          tags = [];
        }
        if (tags.length === 0) {
          res.json({ ...profile, detected: [] });
          return;
        }
        const updated = await deps.users.setBattleTags(auth.userId, tags);
        res.json({ ...updated, detected: tags });
      } catch (err) {
        next(err);
      }
    },
  );

  router.put("/me/profile", deps.auth, async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      const result = validateProfile(req.body);
      if (!result.valid) {
        res.status(400).json({
          error: { code: "invalid_profile", details: result.errors },
        });
        return;
      }
      const profile = await deps.users.updateProfile(auth.userId, result.value);
      res.json(profile);
    } catch (err) {
      next(err);
    }
  });

  /**
   * Narrow agent-only entry: ping the cloud with the most-recently-extracted
   * MMR from a parsed replay so the session widget has a "last known"
   * value to fall back to even when no game in the user's cloud history
   * carries ``myMmr`` (e.g. existing rows uploaded by pre-v0.5.6 agents
   * before the streamer's-own-MMR extraction was reliable).
   *
   * Why a separate route from PUT /me/profile: the agent must NEVER be
   * able to clobber the user-editable fields the streamer typed into
   * Settings (battleTag/pulseId/region/...). PATCH semantics on the
   * full profile route would require validation acrobatics; a tiny
   * focused route is cleaner and lets the validation schema reject
   * any extra fields outright.
   *
   * Body: ``{ mmr: number, capturedAt?: string, region?: string,
   * gameId?: string }``. New agents send the source replay id so a
   * quarantined replay can never republish its synthetic MMR.
   * The service drops the request silently when ``mmr`` is outside the
   * [500, 9999] band so a pasted-by-mistake league enum (Bronze=0..GM=7)
   * can't poison the cache.
   */
  router.post("/me/last-mmr", deps.auth, async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const mmr = Number(body.mmr);
      if (!Number.isInteger(mmr) || mmr < 500 || mmr > 9999) {
        res.status(400).json({ error: { code: "invalid_mmr" } });
        return;
      }
      /** @type {{mmr: number, capturedAt?: string, region?: string, gameId?: string}} */
      const update = { mmr };
      if (typeof body.capturedAt === "string") {
        update.capturedAt = body.capturedAt;
      }
      if (typeof body.region === "string") update.region = body.region;
      if (typeof body.gameId === "string" && body.gameId.trim()) {
        update.gameId = body.gameId.trim().slice(0, 200);
      }
      const wrote = await deps.users.patchLastKnownMmr(auth.userId, update);
      res.json({ ok: true, wrote });
    } catch (err) {
      next(err);
    }
  });

  // Allowlist of preference types the client may read/write.
  // "arcade" stores Arcade tab state (streak, XP/level, unlocked card slugs,
  // current Stock Market portfolio + week key, Bingo card state, badges).
  // "onboarding" stores the checklist bits only the client knows
  // (downloadStartedAt, dismissedAt). "buildCheckin" is the build check-in
  // switches (always exactly three booleans, default true).
  const PREF_TYPES = new Set([
    NOTIFICATIONS_PREF_TYPE,
    "misc",
    "voice",
    "arcade",
    "randomizer",
    "onboarding",
    "multichat",
    "chatCommands",
    "analyzerViews",
    "rivals",
    OPPONENT_SCOUTING_PREF_TYPE,
    TWITCH_PREF_TYPE,
    "ghost",
    CHECKIN_PREF_TYPE,
  ]);

  router.get("/me/analyzer-default-view", deps.auth, async (req, res, next) => {
    try {
      if (!req.auth) throw new Error("auth_required");
      res.set("Cache-Control", "private, no-store");
      res.json(await deps.users.getAnalyzerDefaultView(req.auth.userId));
    } catch (error) { next(error); }
  });

  router.get("/me/preferences/:type", deps.auth, async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      const { type } = req.params;
      if (type === "analyzerViews" || type === "rivals" || type === TWITCH_PREF_TYPE || type === "ghost" || type === "chatCommands" || type === OPPONENT_SCOUTING_PREF_TYPE) res.set("Cache-Control", "private, no-store");
      if (!PREF_TYPES.has(type)) {
        res.status(404).json({ error: { code: "unknown_preference_type" } });
        return;
      }
      if (type === "ghost") {
        if (!deps.ghostConfig) { res.sendStatus(503); return; }
        res.json(await deps.ghostConfig.get(auth.userId));
        return;
      }
      const prefs = await deps.users.getPreferences(auth.userId, type);
      res.json(type === CHECKIN_PREF_TYPE ? sanitizeCheckinPrefs(prefs)
        : type === NOTIFICATIONS_PREF_TYPE ? sanitizeNotificationPrefs(prefs)
          : type === "analyzerViews" ? sanitizeAnalyzerViews(prefs)
            : type === "rivals" ? sanitizeRivals(prefs)
              : type === TWITCH_PREF_TYPE ? sanitizeTwitchAutomation(prefs)
                : type === "chatCommands" ? sanitizeChatCommands(prefs)
                : type === OPPONENT_SCOUTING_PREF_TYPE ? sanitizeOpponentScouting(prefs) : prefs);
    } catch (err) {
      next(err);
    }
  });

  router.put("/me/preferences/:type", deps.auth, async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      const { type } = req.params;
      if (type === "analyzerViews" || type === "rivals" || type === TWITCH_PREF_TYPE || type === "ghost" || type === "chatCommands" || type === OPPONENT_SCOUTING_PREF_TYPE) res.set("Cache-Control", "private, no-store");
      if (type === TWITCH_PREF_TYPE && auth.source !== "clerk") { res.status(403).json({ error: { code: "clerk_required" } }); return; }
      if (!PREF_TYPES.has(type)) {
        res.status(404).json({ error: { code: "unknown_preference_type" } });
        return;
      }
      if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
        res.status(400).json({ error: { code: "invalid_body" } });
        return;
      }
      if (type === "ghost") {
        if (!deps.ghostConfig) { res.sendStatus(503); return; }
        res.json(await deps.ghostConfig.replace(auth.userId, req.body));
        return;
      }
      if (type === "onboarding" && req.body.goals !== undefined &&
          (!Array.isArray(req.body.goals) || req.body.goals.length > 2 ||
           req.body.goals.some((/** @type {unknown} */ goal) => goal !== "improve" && goal !== "stream"))) {
        res.status(400).json({ error: { code: "invalid_onboarding_goals" } });
        return;
      }
      const body = type === CHECKIN_PREF_TYPE ? sanitizeCheckinPrefs(req.body)
        : type === NOTIFICATIONS_PREF_TYPE ? sanitizeNotificationPrefs(req.body)
          : type === "analyzerViews" ? sanitizeAnalyzerViews(req.body, true)
            : type === "rivals" ? sanitizeRivals(req.body, true)
              : type === TWITCH_PREF_TYPE ? sanitizeTwitchAutomation(req.body, true)
                : type === "chatCommands" ? sanitizeChatCommands(req.body, true)
                : type === OPPONENT_SCOUTING_PREF_TYPE ? sanitizeOpponentScouting(req.body, true) : req.body;
      const saved = await deps.users.updatePreferences(auth.userId, type, body);
      if (type === "rivals") {
        try { deps.onRivalsChanged?.(auth.userId); } catch { /* Advisory cache refresh; preferences are already saved. */ }
      }
      if (type === OPPONENT_SCOUTING_PREF_TYPE) {
        try { deps.onScoutingChanged?.(auth.userId); } catch { /* Committed preference; advisory invalidation only. */ }
      }
      if (deps.buildIntents) {
        try {
          // Build check-in switches reach the agent as a user-room ping;
          // randomizer pools change which builds are check-in options.
            await deps.buildIntents.preferencesChanged(auth.userId, type);
        } catch {
          // Advisory: clients also refresh on their own.
        }
      }
      res.json(saved);
    } catch (err) {
      next(err);
    }
  });

  router.patch("/me/preferences/ghost", deps.auth, async (req, res, next) => {
    try {
      if (!req.auth) throw new Error("auth_required");
      res.set("Cache-Control", "private, no-store");
      if (!deps.ghostConfig) { res.sendStatus(503); return; }
      res.json(await deps.ghostConfig.patch(req.auth.userId, req.body));
    } catch (error) { next(error); }
  });

  // ── Uploaded multichat alert sounds ──
  // Small audio files for the multichat sound system. Bytes arrive
  // base64 in JSON (handled by the authenticated large-body lane at the
  // 300 KB cap); the OBS widget fetches them back on the token route
  // (/v1/multichat/:token/sound/:id). Wire shape errors map to the
  // service's coded throws.

  router.get("/me/multichat-sounds", deps.auth, async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      if (!deps.multichatSounds) {
        res.json({ sounds: [] });
        return;
      }
      res.json({ sounds: await deps.multichatSounds.list(auth.userId) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/me/multichat-sounds", deps.auth, async (req, res, next) => {
    const claimed = claimReplayIngestAdmission(res, { allowMissing: true });
    if (!claimed) {
      res.set("Retry-After", "5");
      res.status(503).json({
        error: { code: "replay_ingest_busy", retryable: true },
      });
      return;
    }
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      if (!deps.multichatSounds) {
        res.status(503).json({ error: { code: "uploads_unavailable" } });
        return;
      }
      const label = String(req.body?.label ?? "");
      const b64 = String(req.body?.dataBase64 ?? "");
      let bytes;
      try {
        bytes = Buffer.from(b64, "base64");
      } catch {
        bytes = Buffer.alloc(0);
      }
      const created = await deps.multichatSounds.create(
        auth.userId,
        label,
        bytes,
      );
      res.status(201).json(created);
    } catch (err) {
      const coded = /** @type {{code?: string, message?: string}} */ (err);
      if (
        coded.code === "bad_label" ||
        coded.code === "bad_file" ||
        coded.code === "bad_format" ||
        coded.code === "too_large" ||
        coded.code === "too_many"
      ) {
        res
          .status(400)
          .json({ error: { code: coded.code, message: coded.message } });
        return;
      }
      next(err);
    } finally {
      releaseReplayIngestAdmission(res);
    }
  });

  router.delete(
    "/me/multichat-sounds/:soundId",
    deps.auth,
    async (req, res, next) => {
      try {
        const auth = req.auth;
        if (!auth) throw new Error("auth_required");
        if (!deps.multichatSounds) {
          res.status(404).json({ error: { code: "not_found" } });
          return;
        }
        const ok = await deps.multichatSounds.remove(
          auth.userId,
          String(req.params.soundId),
        );
        if (!ok) {
          res.status(404).json({ error: { code: "not_found" } });
          return;
        }
        res.json({ deleted: true });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post("/me/activation/download", deps.auth, async (req, res, next) => {
    try { if (!req.auth || req.auth.source !== "clerk") { res.status(403).json({ error: { code: "clerk_session_required" } }); return; }
      await deps.users.recordDownload(req.auth.userId); res.status(204).end();
    } catch (error) { next(error); }
  });

  router.get("/me/doctor", deps.auth, async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");

      res.json(await buildDoctor(deps, auth.userId));
    } catch (err) {
      next(err);
    }
  });

  router.get(
    "/me/replay-archive-status",
    deps.auth,
    async (req, res, next) => {
      try {
        const auth = req.auth;
        if (!auth) throw new Error("auth_required");
        const [counts, prefs] = await Promise.all([
          deps.replayArchiveEnabled
            ? deps.games.replayArchiveStatus(auth.userId)
            : Promise.resolve(emptyReplayArchiveCounts()),
          deps.users.getPreferences(auth.userId, "replayArchive"),
        ]);
        res.json({
          ...withReplayResyncState(counts, prefs, Boolean(deps.replayArchiveEnabled)),
          // Browsers may back up originals only once R2 verifiably accepts
          // their cross-origin PUTs (services/replayFilesCors.js).
          browserUploadReady:
            browserUploadStatusOf(deps.browserUploadCors).status === "ready",
        });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/me/replay-archive-resync",
    deps.auth,
    async (req, res, next) => {
      try {
        const auth = req.auth;
        if (!auth) throw new Error("auth_required");
        if (auth.source !== "device") {
          res.status(403).json({ error: { code: "device_auth_required" } });
          return;
        }
        if (!deps.replayArchiveEnabled) {
          res.status(503).json({
            error: { code: "replay_storage_unavailable" },
          });
          return;
        }
        const rawVersion = req.body && req.body.agentVersion;
        const agentVersion =
          typeof rawVersion === "string" && rawVersion.trim().length <= 50
            ? rawVersion.trim()
            : null;
        const prefs = {
          version: 1,
          resyncRequestedAt: new Date().toISOString(),
          ...(agentVersion ? { agentVersion } : {}),
        };
        await deps.users.updatePreferences(
          auth.userId,
          "replayArchive",
          prefs,
        );
        res.json({ ok: true, ...prefs });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get("/me/export", deps.auth, async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      const data = await deps.gdpr.export(auth.userId);
      const filename = `sc2tools-export-${Date.now()}.json`;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader(
        "content-disposition",
        `attachment; filename="${filename}"`,
      );
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  router.delete("/me", deps.auth, async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
        if (auth.source !== "clerk") {
          res.status(403).json({ error: { code: "browser_session_required" } }); return;
        }
      const counts = await deps.gdpr.deleteAll(auth.userId);
      if (deps.logger) {
        deps.logger.info(
          { userId: auth.userId, counts },
          "gdpr_account_deleted",
        );
      }
      res.json({ deleted: true, counts, identityDeletionPending: counts.identityDeletionPending === 1 });
    } catch (err) {
      next(err);
    }
  });

  // Scoped wipe: clears the user's replay history (games, opponents,
  // macro jobs) but keeps their account, custom builds, device pairings,
  // and overlay tokens. Optional ISO `since` / `until` bound
  // the wipe to a date range. Used by Settings → "Delete game history"
  // before a fresh agent re-sync.
  router.post("/me/games/wipe", deps.auth, async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      const body = req.body || {};
      const since = parseIso(body.since);
      const until = parseIso(body.until);
      if (body.since !== undefined && body.since !== null && !since) {
        res.status(400).json({
          error: { code: "bad_request", message: "since must be ISO-8601" },
        });
        return;
      }
      if (body.until !== undefined && body.until !== null && !until) {
        res.status(400).json({
          error: { code: "bad_request", message: "until must be ISO-8601" },
        });
        return;
      }
      if (since && until && since >= until) {
        res.status(400).json({ error: { code: "bad_request", message: "since must be before until" } });
        return;
      }
      if (body.dryRun === true) {
        const games = await deps.gdpr.countGamesForWipe(auth.userId, { since, until });
        res.json({ dryRun: true, counts: { games } });
        return;
      }
      const counts = await deps.gdpr.wipeGames(auth.userId, { since, until });
      res.json({ deleted: true, counts });
    } catch (err) {
      next(err);
    }
  });

  router.get("/me/backups", deps.auth, async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      const result = await deps.gdpr.listSnapshots(auth.userId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post("/me/backups", deps.auth, async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      const snap = await deps.gdpr.snapshot(auth.userId);
      res.status(201).json(snap);
    } catch (err) {
      next(err);
    }
  });

  router.post("/me/repair/:kind", deps.auth, async (req, res, next) => {
    try {
      if (!req.auth) throw new Error("auth_required");
      if (!deps.dataRepairs) throw Object.assign(new Error("repairs_unavailable"), { status: 503 });
      res.status(202).json(await deps.dataRepairs.start(req.auth.userId, String(req.params.kind)));
    } catch (error) { next(error); }
  });

  for (const action of ["preview", "download"]) {
    router.get(`/me/backups/:id/${action}`, deps.auth, async (req, res, next) => {
      try {
        if (!req.auth) throw new Error("auth_required");
        if (!deps.gdpr.backups) throw Object.assign(new Error("backups_unavailable"), { status: 503 });
        res.setHeader("Cache-Control", "private, no-store");
        res.json(action === "preview" ? await deps.gdpr.backups.preview(req.auth.userId, String(req.params.id)) : await deps.gdpr.backups.download(req.auth.userId, String(req.params.id)));
      } catch (error) { next(error); }
    });
  }
  router.patch("/me/backups/:id", deps.auth, async (req, res, next) => {
    try {
      if (!req.auth) throw new Error("auth_required");
      if (!deps.gdpr.backups) throw Object.assign(new Error("backups_unavailable"), { status: 503 });
      res.json(await deps.gdpr.backups.label(req.auth.userId, String(req.params.id), req.body?.label));
    } catch (error) { next(error); }
  });
  router.delete("/me/backups/:id", deps.auth, async (req, res, next) => {
    try {
      if (!req.auth) throw new Error("auth_required");
      if (!deps.gdpr.backups) throw Object.assign(new Error("backups_unavailable"), { status: 503 });
      const fence = await deps.gdpr._acquireMutationFence(req.auth.userId, "delete_backup");
      try { res.json(await deps.gdpr.backups.remove(req.auth.userId, String(req.params.id))); }
      finally { await deps.gdpr._releaseMutationFence(req.auth.userId, fence); }
    } catch (error) { next(error); }
  });

  router.post(
    "/me/backups/:id/restore",
    deps.auth,
    async (req, res, next) => {
      try {
        const auth = req.auth;
        if (!auth) throw new Error("auth_required");
        if (req.body?.currentRevision !== undefined && (typeof req.body.currentRevision !== "string" || !/^[a-f0-9]{24}$/.test(req.body.currentRevision))) throw Object.assign(new Error("invalid_preview_revision"), { status: 400 });
        const result = await deps.gdpr.restoreSnapshot(
          auth.userId,
          String(req.params.id),
          req.body?.currentRevision,
        );
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  /**
   * Current MMR per toon/region for the dashboard KPI strip.
   *
   * One entry per pulseId on the user's profile, each resolved
   * against SC2Pulse independently so a multi-toon streamer sees
   * their NA and EU rows side-by-side. Cached for 5 minutes inside
   * PulseMmrService — the dashboard polls liberally but pays no
   * outbound cost until the cache expires.
   *
   * Response shape (small + capped so a streamer with many alts
   * doesn't blow up the payload):
   *   {
   *     entries: Array<{ pulseId, region, mmr }>,
   *     truncated: boolean,
   *   }
   *
   * The route is best-effort throughout: a Pulse timeout / rate-limit
   * /  miss for a single pulseId just drops that row, never blocks
   * the others.
   */
  router.get("/me/mmr", deps.auth, async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      if (!deps.pulseMmr || typeof deps.pulseMmr.getCurrentMmr !== "function") {
        res.json({ entries: [], truncated: false });
        return;
      }
      // Hoisted past the guard so the narrowed (non-undefined) type
      // survives into the per-id closure below.
      const pulseMmr = deps.pulseMmr;
      const profile = await deps.users.getProfile(auth.userId);
      const ids = Array.isArray(profile && profile.pulseIds)
        ? /** @type {string[]} */ (profile.pulseIds).slice(0, ME_MMR_MAX_TOONS)
        : [];
      const truncated =
        Array.isArray(profile && profile.pulseIds)
        && /** @type {string[]} */ (profile.pulseIds).length > ME_MMR_MAX_TOONS;
      const settled = await Promise.all(
        ids.map(async (id) => {
          try {
            const r = await pulseMmr.getCurrentMmr(id);
            if (!r || !Number.isFinite(Number(r.mmr)) || Number(r.mmr) <= 0) {
              return null;
            }
            return {
              pulseId: String(id),
              region: typeof r.region === "string" ? r.region : null,
              mmr: Math.round(Number(r.mmr)),
              characterId:
                typeof r.characterId === "string" && r.characterId
                  ? r.characterId
                  : null,
            };
          } catch {
            return null;
          }
        }),
      );
      // Sort descending by MMR so the highest ladder always reads
      // first — that's what a streamer's chat asks about.
      const resolved = settled
        .filter((e) => e !== null)
        .sort((a, b) => b.mmr - a.mmr);
      // Collapse duplicate identifiers for the SAME real account. A
      // profile commonly stores both the raw toon handle
      // (``1-S2-1-267727``) AND the canonical SC2Pulse character id
      // (``994428``) for one account — the toon-handle backfill on
      // games ingest adds the former, manual Settings entry the latter
      // — so the fan-out would otherwise report one account twice. Both
      // resolve to the same ``characterId``, so dedupe on it. Running
      // after the sort means the highest-MMR row wins per account.
      /** @type {Set<string>} */
      const seen = new Set();
      /** @type {Array<{ pulseId: string, region: string | null, mmr: number }>} */
      const entries = [];
      for (const e of resolved) {
        const key = e.characterId || `pulse:${e.pulseId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // ``characterId`` was only needed for the dedupe key; keep the
        // wire shape ``{ pulseId, region, mmr }`` the client expects.
        entries.push({ pulseId: e.pulseId, region: e.region, mmr: e.mmr });
      }
      res.json({ entries, truncated });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/**
 * Parse an ISO-8601 string into a Date, or return null on bad input.
 * Permissive on falsy values — `null` / `undefined` mean "no bound",
 * not "invalid".
 *
 * @param {unknown} raw
 * @returns {Date|null}
 */
function parseIso(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

module.exports = {
  buildMeRouter,
  _internals: { withReplayResyncState },
};
