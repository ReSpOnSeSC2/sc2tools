"use strict";

/**
 * Handlers for the coaching session reads beside the calendar: the
 * calendar itself (``?past=1`` returns the complete past-session history)
 * and one booking's prep digest. ``buildCoachingRouter`` mounts them;
 * ``context`` resolves req.auth plus the caller's coaching role the same
 * way every coaching route does.
 */

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

module.exports = { calendarRoute, bookingDigestRoute };
