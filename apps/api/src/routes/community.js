"use strict";

const express = require("express");

/**
 * /v1/community/* — public-read + auth'd-write community endpoints.
 *
 * Public reads (no auth):
 *   GET /community/builds              — list published builds
 *                                        (matchup, sort, q, limit, offset)
 *   GET /community/builds/:slug        — detail
 *   GET /community/arcade-universe     — balanced top-N-per-matchup list
 *                                        used by the Arcade Stock Market
 *   GET /community/authors/:userId     — public author profile
 *   GET /community/opponents/:pulseId  — k-anonymous aggregate
 *
 * Authed writes:
 *   POST   /community/builds                 — publish a private build
 *   DELETE /community/builds/:slug           — unpublish (owner)
 *   POST   /community/builds/:slug/vote      — { delta: 1 | -1 }
 *   POST   /community/reports                — flag content
 *
 * Admin (Clerk role: admin):
 *   GET    /community/admin/reports          — list open reports
 *   POST   /community/admin/reports/:id      — resolve
 *
 * @param {{
 *   community: import('../services/community').CommunityService,
 *   auth: import('express').RequestHandler,
 *   isAdmin: (req: import('express').Request) => boolean,
 * }} deps
 */
function buildCommunityRouter(deps) {
  const router = express.Router();

  // ── Public ───────────────────────────────────────────────────────
  router.get("/community/builds", async (req, res, next) => {
    try {
      const matchup = req.query.matchup ? String(req.query.matchup) : undefined;
      const limit = req.query.limit
        ? Number.parseInt(String(req.query.limit), 10)
        : undefined;
      const offset = req.query.offset
        ? Number.parseInt(String(req.query.offset), 10)
        : undefined;
      const sortRaw = req.query.sort ? String(req.query.sort) : "top";
      const sort = ["top", "new", "controversial"].includes(sortRaw)
        ? /** @type {'top'|'new'|'controversial'} */ (sortRaw)
        : "top";
      const search = req.query.q
        ? String(req.query.q).trim().slice(0, 80)
        : undefined;
      const result = await deps.community.listPublic({
        matchup,
        limit,
        offset,
        sort,
        search: search || undefined,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.get("/community/arcade-universe", async (req, res, next) => {
    try {
      const perMatchup = req.query.perMatchup
        ? Number.parseInt(String(req.query.perMatchup), 10)
        : undefined;
      const totalCap = req.query.totalCap
        ? Number.parseInt(String(req.query.totalCap), 10)
        : undefined;
      const result = await deps.community.listArcadeUniverse({
        perMatchup,
        totalCap,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.get("/community/builds/:slug", async (req, res, next) => {
    try {
      const row = await deps.community.getPublic(String(req.params.slug));
      if (!row) {
        res.status(404).json({ error: { code: "not_found" } });
        return;
      }
      res.json(row);
    } catch (err) {
      next(err);
    }
  });

  /**
   * Public author profile. 404s for users with no published builds, or
   * for users who have never declared a public `authorName` (the
   * implicit opt-out — see CommunityService.getAuthor).
   */
  router.get("/community/authors/:userId", async (req, res, next) => {
    try {
      const profile = await deps.community.getAuthor(
        String(req.params.userId),
      );
      if (!profile) {
        res.status(404).json({
          error: {
            code: "author_not_found",
            message: "This profile is private or doesn't exist.",
          },
        });
        return;
      }
      res.json(profile);
    } catch (err) {
      next(err);
    }
  });

  router.get("/community/opponents/:pulseId", async (req, res, next) => {
    try {
      const result = await deps.community.aggregateOpponent(
        String(req.params.pulseId),
      );
      if (!result) {
        // K-anonymity floor not met. Tell the client distinctly so it
        // can render the "not enough data" message instead of a 500.
        res.status(404).json({
          error: {
            code: "k_anon_threshold_not_met",
            message: "Not enough distinct contributors to publish this row.",
          },
        });
        return;
      }
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // ── Authed ───────────────────────────────────────────────────────
  router.post(
    "/community/builds",
    deps.auth,
    async (req, res, next) => {
      try {
        const auth = req.auth;
        if (!auth) throw new Error("auth_required");
        const userSlug = String(req.body?.slug || "");
        if (!userSlug) {
          res.status(400).json({
            error: { code: "bad_request", message: "slug required" },
          });
          return;
        }
        const meta = {
          title: req.body?.title ? String(req.body.title).slice(0, 200) : "",
          description: req.body?.description
            ? String(req.body.description).slice(0, 4000)
            : "",
          authorName: req.body?.authorName
            ? String(req.body.authorName).slice(0, 80)
            : "",
        };
        const result = await deps.community.publish(
          auth.userId,
          userSlug,
          meta,
        );
        res.status(201).json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  router.delete(
    "/community/builds/:slug",
    deps.auth,
    async (req, res, next) => {
      try {
        const auth = req.auth;
        if (!auth) throw new Error("auth_required");
        await deps.community.unpublish(auth.userId, String(req.params.slug));
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/community/builds/:slug/vote",
    deps.auth,
    async (req, res, next) => {
      try {
        const auth = req.auth;
        if (!auth) throw new Error("auth_required");
        const delta = Number(req.body?.delta);
        await deps.community.vote(
          auth.userId,
          String(req.params.slug),
          /** @type {1 | -1} */ (delta),
        );
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    },
  );

  router.post("/community/reports", deps.auth, async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      await deps.community.report(auth.userId, {
        targetType: String(req.body?.targetType || ""),
        targetId: String(req.body?.targetId || ""),
        reason: String(req.body?.reason || ""),
        note: req.body?.note ? String(req.body.note) : "",
      });
      res.status(202).json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // ── Admin ────────────────────────────────────────────────────────
  router.get(
    "/community/admin/reports",
    deps.auth,
    requireAdmin(deps),
    async (req, res, next) => {
      try {
        const result = await deps.community.listReports();
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/community/admin/reports/:id",
    deps.auth,
    requireAdmin(deps),
    async (req, res, next) => {
      try {
        const auth = req.auth;
        if (!auth) throw new Error("auth_required");
        const action = String(req.body?.action || "dismiss");
        if (action !== "dismiss" && action !== "remove") {
          res.status(400).json({
            error: {
              code: "bad_request",
              message: "action must be dismiss|remove",
            },
          });
          return;
        }
        await deps.community.resolveReport(auth.userId, String(req.params.id), {
          action: /** @type {'dismiss'|'remove'} */ (action),
          note: req.body?.note ? String(req.body.note) : "",
        });
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

/**
 * Gate factory — returns a middleware that 403s anyone who isn't an
 * admin per `deps.isAdmin`. Keeps the admin role check pluggable; the
 * default impl reads Clerk metadata.
 *
 * @param {{ isAdmin: (req: import('express').Request) => boolean }} deps
 * @returns {import('express').RequestHandler}
 */
function requireAdmin(deps) {
  return (req, res, next) => {
    if (!deps.isAdmin(req)) {
      res.status(403).json({ error: { code: "forbidden" } });
      return;
    }
    next();
  };
}

module.exports = { buildCommunityRouter };
