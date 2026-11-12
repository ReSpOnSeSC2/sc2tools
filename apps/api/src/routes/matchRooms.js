"use strict";

const express = require("express");
const { rateLimit } = require("express-rate-limit");
const { BoundedRateLimitStore } = require("../middleware/boundedRateLimitStore");
const { MatchRoomError } = require("../services/matchRoomModel");

/** @param {number} max @param {number} [windowMs] */
function roomLimit(max, windowMs = 60_000) {
  return rateLimit({ windowMs, max, standardHeaders: "draft-7", legacyHeaders: false,
    store: new BoundedRateLimitStore({ maxEntries: 4096 }), message: { error: { code: "rate_limited" } } });
}

/** @param {unknown} value */
function readRevision(value) {
  if (value === undefined) return null;
  const rev = typeof value === "string" && /^\d{1,16}$/u.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(rev)) throw new MatchRoomError(400, "invalid_room_revision");
  return rev;
}

/** @param {unknown} err @param {import("express").Response} res @param {import("express").NextFunction} next */
function roomError(err, res, next) {
  if (err instanceof MatchRoomError) {
    if (err.status === 503) res.set("Retry-After", "30");
    res.status(err.status).json({ error: { code: err.code } });
    return;
  }
  // Mongo errors and body-parser errors can embed submitted content.
  next(new Error("match_room_storage_failed"));
}

const parseRoomBody = express.json({ limit: "2kb" });
/** @type {import("express").RequestHandler} */
function roomBody(req, res, next) {
  parseRoomBody(req, res, err => {
    if (!err) next();
    else if (err.status === 413) res.status(413).json({ error: { code: "room_request_too_large" } });
    else res.status(400).json({ error: { code: "invalid_room_request" } });
  });
}

/** @param {import("../services/matchRooms").MatchRoomsService} rooms */
function buildMatchRoomsRouter(rooms) {
  const router = express.Router();
  router.use("/match-rooms", (_req, res, next) => {
    res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" });
    next();
  });
  const write = roomLimit(60);
  router.post("/match-rooms", roomLimit(10, 3_600_000), roomBody, async (req, res, next) => {
    try { res.status(201).json(await rooms.create(req.body)); }
    catch (err) { roomError(err, res, next); }
  });
  router.get("/match-rooms/:id", roomLimit(600), async (req, res, next) => {
    try {
      const snapshot = await rooms.read(req.params.id, readRevision(req.query.rev));
      if (snapshot) res.json(snapshot);
      else res.status(204).end();
    } catch (err) { roomError(err, res, next); }
  });
  router.post("/match-rooms/:id/actions", write, roomBody, async (req, res, next) => {
    try { res.json(await rooms.act(req.params.id, req.body?.key, req.body?.rev, req.body?.action)); }
    catch (err) { roomError(err, res, next); }
  });
  router.delete("/match-rooms/:id", write, roomBody, async (req, res, next) => {
    try {
      await rooms.remove(req.params.id, req.body?.key);
      res.status(204).end();
    } catch (err) { roomError(err, res, next); }
  });
  return router;
}

module.exports = { buildMatchRoomsRouter };
