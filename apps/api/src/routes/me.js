"use strict";

const express = require("express");
const { validateProfile } = require("../validation/profile");

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
 *   clerk?: import('../services/clerkClient').ClerkClient,
 *   auth: import('express').RequestHandler,
 *   isAdmin?: (req: import('express').Request) => boolean,
 *   logger?: import('pino').Logger,
 * }} deps
 */
function buildMeRouter(deps) {
  const router = express.Router();
  const isAdmin = deps.isAdmin || (() => false);
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
      const [stats, summary, agent] = await Promise.all([
        deps.games.stats(auth.userId),
        deps.users.getSummary(auth.userId),
        deps.pairings.latestAgent(auth.userId),
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
      res.json({
        userId: auth.userId,
        source: auth.source,
        games: stats,
        email,
        agentVersion: agent.version,
        agentPaired: agent.paired,
        isAdmin: isAdmin(req),
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
      res.json(profile);
    } catch (err) {
      next(err);
    }
  });

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
  const PREF_TYPES = new Set(["misc", "voice"]);

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

      if (!profile.battleTag) {
        warnings.push({
          id: "no_profile",
          severity: "warn",
          message:
            "Your SC2 profile isn't set up yet. Add your BattleTag to see opponent matchup stats.",
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
