"use strict";

/**
 * /v1/admin/* — operational admin routes.
 *
 * Every endpoint here is gated by ``isAdmin(req)`` (Clerk user ID
 * matched against ``SC2TOOLS_ADMIN_USER_IDS``). Non-admins get a 403
 * with no body — the SPA hides the Admin link entirely for those
 * users via ``/v1/me.isAdmin``, so a 403 here only fires on direct
 * URL access.
 *
 * Endpoints
 * ---------
 *
 *   GET  /admin/storage-stats       per-collection size + total
 *   GET  /admin/infrastructure      provider costs + capacity advisories
 *   GET  /admin/users               paginated user list w/ activity
 *   GET  /admin/users/:userId       per-user detail snapshot
 *   POST /admin/users/:userId/rebuild-opponents
 *                                    drop + re-derive opponents from games
 *   POST /admin/users/:userId/wipe-games
 *                                    GDPR wipe (delegates to GdprService)
 *   POST /admin/me/rebuild-opponents
 *                                    convenience for the calling admin's
 *                                    own opponents row — drives the
 *                                    "Fix my counters" button on /admin
 *   GET  /admin/health              Mongo ping, uptime, runtime info
 */

const express = require("express");

/**
 * @param {{
 *   admin: import('../services/admin').AdminService,
 *   adminGlobal: import('../services/adminGlobal').AdminGlobalService,
 *   adminEvents: import('../services/adminEvents').AdminEventsService,
 *   analytics: import('../services/analytics').AnalyticsService,
 *   gdpr: import('../services/gdpr').GdprService,
 *   games: import('../services/games').GamesService,
 *   opponents: import('../services/types').OpponentsService,
 *   perGame: import('../services/types').PerGameComputeService,
 *   users: import('../services/users').UsersService,
 *   auth: import('express').RequestHandler,
 *   isAdmin: (req: any) => boolean,
 *   onAdminGranted?: (clerkUserId: string) => void,
 *   gameDetailsStoreKind?: string,
 *   replayFilesStoreKind?: string,
 * }} deps
 */
function buildAdminRouter(deps) {
  const router = express.Router();
  // Scope the auth + admin gate to ``/admin/*`` only. ``router.use(...)``
  // without a path argument runs for every request that reaches this
  // router — including non-admin ``/v1/*`` requests that just happen
  // to pass through this router on the way to a downstream handler
  // — which would 403 unrelated traffic.
  router.use("/admin", deps.auth);
  router.use("/admin", (req, res, next) => {
    if (!deps.isAdmin(req)) {
      res.status(403).json({ error: { code: "admin_only" } });
      return;
    }
    next();
  });

  router.get("/admin/storage-stats", async (_req, res, next) => {
    try {
      res.json(await deps.admin.storageStats());
    } catch (err) {
      next(err);
    }
  });

  router.get("/admin/infrastructure", async (_req, res, next) => {
    try {
      // Capacity is operator-only and changes independently of the web build;
      // never let a browser or shared CDN cache the response.
      res.set("Cache-Control", "private, no-store").json(
        await deps.admin.infrastructureSnapshot(),
      );
    } catch (err) {
      next(err);
    }
  });

  // Global tracking — platform-wide aggregates across every user.
  router.get("/admin/global/summary", async (_req, res, next) => {
    try {
      res.json(await deps.adminGlobal.summary());
    } catch (err) {
      next(err);
    }
  });

  router.get("/admin/global/players", async (req, res, next) => {
    try {
      res.json(
        await deps.adminGlobal.listPlayers({
          limit: parseLimit(req.query.limit),
          page: parsePage(req.query.page),
          search: typeof req.query.search === "string" ? req.query.search : undefined,
          race: typeof req.query.race === "string" ? req.query.race : undefined,
          minGames: parseNonNegInt(req.query.minGames),
          sort: typeof req.query.sort === "string" ? req.query.sort : undefined,
          order: typeof req.query.order === "string" ? req.query.order : undefined,
        }),
      );
    } catch (err) {
      next(err);
    }
  });

  router.get("/admin/global/breakdowns", async (_req, res, next) => {
    try {
      res.json(await deps.adminGlobal.breakdowns());
    } catch (err) {
      next(err);
    }
  });

  // Every game any user played vs one global player, newest first.
  // Registered before the bare ``:pulseId`` profile route for clarity;
  // the two never collide (this path carries an extra ``/games``
  // segment), and ``:pulseId`` matches a single segment so a toon
  // handle (``region-S2-realm-id``, no slashes) maps cleanly.
  router.get("/admin/global/players/:pulseId/games", async (req, res, next) => {
    try {
      res.json(
        await deps.adminGlobal.listPlayerGames(String(req.params.pulseId), {
          limit: parseLimit(req.query.limit),
          before: parseDate(req.query.before),
        }),
      );
    } catch (err) {
      next(err);
    }
  });

  // Operator-facing profile for one global player — merged stats,
  // per-user breakdown, and the strategies/maps seen against them.
  router.get("/admin/global/players/:pulseId", async (req, res, next) => {
    try {
      const profile = await deps.adminGlobal.playerProfile(
        String(req.params.pulseId),
      );
      if (!profile) {
        res.status(404).json({ error: { code: "player_not_found" } });
        return;
      }
      res.json(profile);
    } catch (err) {
      next(err);
    }
  });

  router.get("/admin/users", async (req, res, next) => {
    try {
      const limit = parseLimit(req.query.limit);
      const before = parseDate(req.query.before);
      const search = typeof req.query.search === "string" ? req.query.search : undefined;
      const filter = typeof req.query.filter === "string" ? req.query.filter : undefined;
      res.json(await deps.admin.listUsers({ limit, before, search, filter }));
    } catch (err) {
      next(err);
    }
  });

  router.get("/admin/users/:userId", async (req, res, next) => {
    try {
      const detail = await deps.admin.userDetail(String(req.params.userId));
      res.json(detail);
    } catch (err) {
      next(err);
    }
  });

  // Promote another user to admin. The whole router is already gated on
  // ``isAdmin``, so only an existing admin can reach this — that's the
  // "only an admin can add other admins" rule. On success we push the
  // grantee's Clerk id straight into the live allowlist so their next
  // request is admin-authorized without a restart.
  router.post("/admin/users/:userId/grant-admin", async (req, res, next) => {
    try {
      const grantedBy = req.auth && req.auth.clerkUserId;
      const granted = await deps.users.grantAdmin(
        String(req.params.userId),
        typeof grantedBy === "string" ? grantedBy : "",
      );
      if (!granted) {
        res.status(404).json({ error: { code: "user_not_grantable" } });
        return;
      }
      if (typeof deps.onAdminGranted === "function") {
        deps.onAdminGranted(granted.clerkUserId);
      }
      res.json({ ok: true, userId: granted.userId });
    } catch (err) {
      next(err);
    }
  });

  // Full opponent history for one user — the "see all opponents"
  // browser. ``:userId`` matches a single path segment, so this more
  // specific route never collides with ``/admin/users/:userId`` above.
  router.get("/admin/users/:userId/opponents", async (req, res, next) => {
    try {
      const limit = parseLimit(req.query.limit);
      const page = parsePage(req.query.page);
      const search =
        typeof req.query.search === "string" ? req.query.search : undefined;
      const race =
        typeof req.query.race === "string" ? req.query.race : undefined;
      const minGames = parseNonNegInt(req.query.minGames);
      const sort =
        typeof req.query.sort === "string" ? req.query.sort : undefined;
      const order =
        typeof req.query.order === "string" ? req.query.order : undefined;
      res.json(
        await deps.admin.listOpponents(String(req.params.userId), {
          limit,
          page,
          search,
          race,
          minGames,
          sort,
          order,
        }),
      );
    } catch (err) {
      next(err);
    }
  });

  // Games one user played vs a single opponent — drill-down from the
  // opponents browser. Cursor-paginated by date (``before``).
  router.get(
    "/admin/users/:userId/opponents/:pulseId/games",
    async (req, res, next) => {
      try {
        const limit = parseLimit(req.query.limit);
        const before = parseDate(req.query.before);
        const result = await deps.admin.listGamesVsOpponent(
          String(req.params.userId),
          String(req.params.pulseId),
          { limit, before },
        );
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  // Identity / MMR diagnostics for a single opponent — "why is the
  // Pulse ID or MMR missing?". Read-only; inferred from stored fields,
  // no SC2Pulse traffic.
  router.get(
    "/admin/users/:userId/opponents/:pulseId/diagnostics",
    async (req, res, next) => {
      try {
        const result = await deps.opponents.diagnoseIdentity(
          String(req.params.userId),
          String(req.params.pulseId),
        );
        if (!result) {
          res.status(404).json({ error: { code: "opponent_not_found" } });
          return;
        }
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  // Force a fresh SC2Pulse resolve + MMR refetch for one opponent,
  // bypassing the throttle windows. Powers the debug panel's "Retry".
  router.post(
    "/admin/users/:userId/opponents/:pulseId/retry-pulse",
    async (req, res, next) => {
      try {
        const result = await deps.opponents.retryPulseResolution(
          String(req.params.userId),
          String(req.params.pulseId),
        );
        if (!result) {
          res.status(404).json({ error: { code: "opponent_not_found" } });
          return;
        }
        res.status(202).json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  // Build order (player + opponent, parsed into timeline events) for a
  // single game owned by an ARBITRARY user. Delegates to the same
  // compute service the user-facing /v1/games/:gameId/build-order route
  // uses, just with the target userId instead of the caller's — so the
  // admin view renders identically to the owner's own replay.
  router.get(
    "/admin/users/:userId/games/:gameId/build-order",
    async (req, res, next) => {
      try {
        const out = await deps.perGame.buildOrder(
          String(req.params.userId),
          String(req.params.gameId),
        );
        if (!out) {
          res.status(404).json({ error: { code: "game_not_found" } });
          return;
        }
        res.json(out);
      } catch (err) {
        next(err);
      }
    },
  );

  // APM/SPM curve for an arbitrary user's game. Mirrors the
  // not-computed handling of the user-facing /apm-curve route.
  router.get(
    "/admin/users/:userId/games/:gameId/apm-curve",
    async (req, res, next) => {
      try {
        const out = /** @type {any} */ (
          await deps.perGame.apmCurve(
            String(req.params.userId),
            String(req.params.gameId),
          )
        );
        if (!out) {
          res.status(404).json({ error: { code: "game_not_found" } });
          return;
        }
        if (out.ok === false && out.code === "not_computed") {
          res.status(404).json({ error: { code: "apm_not_computed" } });
          return;
        }
        res.json(out);
      } catch (err) {
        next(err);
      }
    },
  );

  // Macro breakdown (leaks, economy/army samples, unit timeline) for an
  // arbitrary user's game. Mirrors the user-facing /macro-breakdown
  // route's not-computed handling.
  router.get(
    "/admin/users/:userId/games/:gameId/macro-breakdown",
    async (req, res, next) => {
      try {
        const out = /** @type {any} */ (
          await deps.perGame.macroBreakdown(
            String(req.params.userId),
            String(req.params.gameId),
          )
        );
        if (!out) {
          res.status(404).json({ error: { code: "game_not_found" } });
          return;
        }
        if (out.ok === false && out.code === "not_computed") {
          res.status(404).json({ error: { code: "macro_not_computed" } });
          return;
        }
        res.json(out);
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/admin/users/:userId/rebuild-opponents",
    async (req, res, next) => {
      try {
        const result = await deps.admin.rebuildOpponentsForUser(
          String(req.params.userId),
        );
        res.status(202).json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/admin/users/:userId/wipe-games",
    async (req, res, next) => {
      try {
        // GDPR.wipeGames is the single source of truth for cascading
        // a user's data delete (games + game_details + opponents
        // re-derive + macroJobs). The admin route just delegates.
        const result = await deps.gdpr.wipeGames(
          String(req.params.userId),
          {},
        );
        res.status(202).json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  /**
   * "Rebuild MY opponents" — the most common single-button action
   * for the admin themselves after a buggy re-sync. We pull the
   * caller's userId off ``req.auth`` (set by the auth middleware)
   * so the SPA doesn't have to round-trip /v1/me first.
   */
  router.post("/admin/me/rebuild-opponents", async (req, res, next) => {
    try {
      const userId = req.auth && req.auth.userId;
      if (!userId) {
        res.status(401).json({ error: { code: "auth_required" } });
        return;
      }
      const result = await deps.admin.rebuildOpponentsForUser(userId);
      res.status(202).json(result);
    } catch (err) {
      next(err);
    }
  });

  router.get("/admin/health", async (_req, res, next) => {
    try {
      res.json(
        await deps.admin.health({
          gameDetailsStoreKind: deps.gameDetailsStoreKind,
          replayFilesStoreKind: deps.replayFilesStoreKind,
        }),
      );
    } catch (err) {
      next(err);
    }
  });

  router.get("/admin/events", async (req, res, next) => {
    try {
      const limit = parseLimit(req.query.limit);
      const before = parseDate(req.query.before);
      const typeRaw = req.query.type;
      const type = typeof typeRaw === "string" && typeRaw.length > 0
        ? typeRaw
        : undefined;
      res.json(await deps.adminEvents.list({ limit, before, type }));
    } catch (err) {
      next(err);
    }
  });

  // Google Analytics 4 — dashboard payload for the Analytics tab.
  // When GA isn't configured we return ``{ configured: false }`` with a
  // 200 so the UI renders a setup hint rather than treating it as an
  // error. ``days`` selects the trailing window (default 28, clamped
  // service-side to 1..365).
  router.get("/admin/analytics/summary", async (req, res, next) => {
    try {
      if (!deps.analytics.isEnabled()) {
        res.json({ configured: false });
        return;
      }
      const days = parseLimit(req.query.days);
      res.json(await deps.analytics.summary({ days }));
    } catch (err) {
      next(err);
    }
  });

  router.get("/admin/analytics/realtime", async (_req, res, next) => {
    try {
      if (!deps.analytics.isEnabled()) {
        res.json({ configured: false });
        return;
      }
      res.json(await deps.analytics.realtime());
    } catch (err) {
      next(err);
    }
  });

  router.get("/admin/events/counts", async (_req, res, next) => {
    try {
      res.json(await deps.adminEvents.counts());
    } catch (err) {
      next(err);
    }
  });

  router.post("/admin/events/mark-read", async (_req, res, next) => {
    try {
      res.json(await deps.adminEvents.markAllRead());
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/** @param {unknown} raw */
function parseLimit(raw) {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** @param {unknown} raw — 0-based page index; negatives/garbage → 0. */
function parsePage(raw) {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** @param {unknown} raw — non-negative integer filter; garbage → undefined. */
function parseNonNegInt(raw) {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** @param {unknown} raw */
function parseDate(raw) {
  if (!raw || typeof raw !== "string") return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

module.exports = { buildAdminRouter };
