"use strict";

/**
 * Handlers for the coaching session reads beside the calendar: the
 * calendar itself (``?past=1`` returns the complete past-session history)
 * and one booking's prep digest. ``buildCoachingRouter`` mounts them;
 * ``context`` resolves req.auth plus the caller's coaching role the same
 * way every coaching route does.
 */

const rateLimitModule = require("express-rate-limit");
const { BoundedRateLimitStore } = require("../middleware/boundedRateLimitStore");
const { streamOriginal } = require("./publicReplayDownloads");

const rateLimit = /** @type {any} */ (rateLimitModule).default || rateLimitModule;
const PRIVATE_NO_STORE = "private, no-store, max-age=0";

/**
 * @typedef {(req: import("express").Request) => {auth: any, cr: any}} CoachingContext
 */

/** @param {any} deps @param {CoachingContext} context @returns {import("express").RequestHandler} */
function calendarRoute(deps, context) {
  return async (req, res, next) => {
    try {
      const { auth, cr } = context(req);
      if (cr.role === "none") {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (req.query.past === "1") {
        res.set("Cache-Control", PRIVATE_NO_STORE);
        res.json(await deps.coaching.calendarHistory(auth.userId, cr, { limit: Number(req.query.limit) }));
        return;
      }
      const timeZone = typeof req.query.timeZone === "string"
        ? req.query.timeZone
        : undefined;
      res.json(await deps.coaching.calendarFor(auth.userId, cr, timeZone));
    } catch (err) {
      next(err);
    }
  };
}

/** @param {any} deps @param {CoachingContext} context @returns {import("express").RequestHandler} */
function bookingDigestRoute(deps, context) {
  return async (req, res, next) => {
    res.set("Cache-Control", PRIVATE_NO_STORE);
    try {
      const { auth, cr } = context(req);
      // Device credentials exist to upload replays; they never read a
      // player's game facts, even the caller's own.
      if (cr.role === "none" || auth.source !== "clerk") {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json(await deps.coaching.bookingDigest(auth.userId, cr, req.params.bookingId));
    } catch (err) {
      next(err);
    }
  };
}

/** @param {any} deps @param {CoachingContext} context @returns {import('express').RequestHandler[]} */
function bookingDigestReplayRoute(deps, context) {
  let active = 0;
  const limiter = rateLimit({
    windowMs: 60_000, max: 12, standardHeaders: true, legacyHeaders: false,
    store: new BoundedRateLimitStore({ maxEntries: 4096 }),
    keyGenerator: (/** @type {import('express').Request} */ req) => req.auth?.userId || req.ip || "anonymous",
  });
  return [(_req, res, next) => { res.set("Cache-Control", PRIVATE_NO_STORE); next(); }, limiter,
    async (req, res, next) => {
      let admitted = false;
      try {
        const { auth, cr } = context(req);
        if (auth.source !== "clerk" || (cr.role !== "coach" && cr.role !== "admin")) {
          res.status(404).json({ error: "not_found" });
          return;
        }
        if (active >= 4) { res.status(503).json({ error: "replay_storage_unavailable" }); return; }
        active += 1;
        admitted = true;
        const reference = req.body?.reference;
        const lookup = () => deps.coaching.bookingDigestReplay(auth.userId, cr, req.params.bookingId, reference);
        const replay = await lookup();
        if (!deps.replayFiles) { res.status(503).json({ error: "replay_storage_unavailable" }); return; }
        const prepared = await deps.replayFiles.prepareDownload(replay.userId, replay.gameId, { filename: "sc2tools-replay.SC2Replay" });
        await streamOriginal(prepared.url, res, async () => {
          try {
            const current = await lookup();
            return current.userId === replay.userId && current.gameId === replay.gameId;
          } catch (error) {
            if ([404, 409].includes(/** @type {any} */ (error)?.status)) return false;
            throw error;
          }
        });
      } catch (error) {
        next(error);
      } finally { if (admitted) active -= 1; }
    }];
}

/** @param {import('express').Router} router @param {import('express').RequestHandler} withRole
 * @param {any} deps @param {CoachingContext} context */
function mountBookingDigestRoutes(router, withRole, deps, context) {
  const path = "/coaching/calendar/bookings/:bookingId/digest";
  router.get(path, withRole, bookingDigestRoute(deps, context));
  router.post(path + "/replay", withRole, ...bookingDigestReplayRoute(deps, context));
}

module.exports = { calendarRoute, mountBookingDigestRoutes };
