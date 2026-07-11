"use strict";

const express = require("express");
const { validateProfile } = require("../validation/profile");

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
 *   PUT    /me/preferences/:type    — replace preferences for that type
 *   GET    /me/doctor               — diagnostic warnings (no agent, no profile, etc.)
 *   GET    /me/export               — download every per-user record as JSON
 *   DELETE /me                      — permanently delete the account
 *   GET    /me/backups              — list manual snapshots
 *   POST   /me/backups              — take a manual snapshot
 *   POST   /me/backups/:id/restore  — restore from a snapshot
 *
 * @param {{
 *   users: import('../services/types').UsersService,
 *   games: import('../services/types').GamesService,
 *   gdpr: import('../services/gdpr').GdprService,
 *   pairings: import('../services/devicePairings').DevicePairingsService,
 *   imports?: import('../services/import').ImportService,
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
 *   logger?: import('pino').Logger,
 * }} deps
 */
function buildMeRouter(deps) {
  const router = express.Router();
  const isAdmin = deps.isAdmin || (() => false);
  const isAdminEmail = deps.isAdminEmail || (() => false);
  const clerk = deps.clerk || null;

  // Auth applied per-route, NOT via router.use(). Router-level middleware
  // here would intercept every /v1/* request that doesn't match an
  // earlier-mounted router, blocking unauthenticated endpoints like
  // /v1/device-pairings/start with a spurious 401.
  router.get("/me", deps.auth, async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      await deps.users.touch(auth.userId);
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
   * Body: ``{ mmr: number, capturedAt?: string, region?: string }``.
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
      /** @type {{mmr: number, capturedAt?: string, region?: string}} */
      const update = { mmr };
      if (typeof body.capturedAt === "string") {
        update.capturedAt = body.capturedAt;
      }
      if (typeof body.region === "string") update.region = body.region;
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
  // (downloadStartedAt, dismissedAt).
  const PREF_TYPES = new Set([
    "misc",
    "voice",
    "arcade",
    "randomizer",
    "onboarding",
  ]);

  router.get("/me/preferences/:type", deps.auth, async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      const { type } = req.params;
      if (!PREF_TYPES.has(type)) {
        res.status(404).json({ error: { code: "unknown_preference_type" } });
        return;
      }
      const prefs = await deps.users.getPreferences(auth.userId, type);
      res.json(prefs);
    } catch (err) {
      next(err);
    }
  });

  router.put("/me/preferences/:type", deps.auth, async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      const { type } = req.params;
      if (!PREF_TYPES.has(type)) {
        res.status(404).json({ error: { code: "unknown_preference_type" } });
        return;
      }
      if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
        res.status(400).json({ error: { code: "invalid_body" } });
        return;
      }
      const saved = await deps.users.updatePreferences(auth.userId, type, req.body);
      res.json(saved);
    } catch (err) {
      next(err);
    }
  });

  router.get("/me/doctor", deps.auth, async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");

      /** @type {Array<{id: string, severity: 'info'|'warn'|'error', message: string, cta?: {label: string, href: string}}>} */
      const warnings = [];

      const [profile, devices, gameStats] = await Promise.all([
        deps.users.getProfile(auth.userId),
        deps.pairings.listDevices(auth.userId),
        deps.games.stats(auth.userId),
      ]);

      // Any one identity signal is enough: the replay matcher keys off
      // displayName first, pulse ids drive MMR lookups, and battleTag
      // is auto-backfilled from SC2Pulse once a pulse id exists. Only
      // nag when ALL of them are missing — warning on a bare
      // ``!battleTag`` produced a false positive for every user whose
      // profile was populated by auto-detection.
      const hasIdentity = Boolean(
        profile.battleTag ||
          profile.displayName ||
          (Array.isArray(profile.pulseIds) && profile.pulseIds.length > 0),
      );
      if (!hasIdentity) {
        warnings.push({
          id: "no_profile",
          severity: "warn",
          message:
            "Your SC2 profile isn't set up yet. Add your BattleTag or a Pulse ID to see opponent matchup stats.",
          cta: { label: "Set up profile", href: "/settings#profile" },
        });
      }

      if (devices.length === 0) {
        warnings.push({
          id: "no_agent",
          severity: "warn",
          message:
            "No SC2 agent is connected. Install and pair the desktop agent to start importing replays.",
          cta: { label: "Connect agent", href: "/devices" },
        });
      }

      if (gameStats.total === 0) {
        warnings.push({
          id: "no_games",
          severity: "info",
          message:
            "No games recorded yet. The agent will import your recent replays automatically after pairing.",
        });
      }

      res.json({ ok: warnings.filter((w) => w.severity !== "info").length === 0, warnings });
    } catch (err) {
      next(err);
    }
  });

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
      const counts = await deps.gdpr.deleteAll(auth.userId);
      if (deps.logger) {
        deps.logger.info(
          { userId: auth.userId, counts },
          "gdpr_account_deleted",
        );
      }
      res.json({ deleted: true, counts });
    } catch (err) {
      next(err);
    }
  });

  // Scoped wipe: clears the user's replay history (games, opponents,
  // macro jobs) but keeps their account, custom builds, device pairings,
  // overlay tokens, and ML models. Optional ISO `since` / `until` bound
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
      const counts = await deps.gdpr.wipeGames(auth.userId, { since, until });
      if (deps.logger) {
        deps.logger.info(
          { userId: auth.userId, counts },
          "gdpr_games_wiped",
        );
      }
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

  router.post(
    "/me/backups/:id/restore",
    deps.auth,
    async (req, res, next) => {
      try {
        const auth = req.auth;
        if (!auth) throw new Error("auth_required");
        const result = await deps.gdpr.restoreSnapshot(
          auth.userId,
          String(req.params.id),
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

module.exports = { buildMeRouter };
