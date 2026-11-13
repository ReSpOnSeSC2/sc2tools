"use strict";

const express = require("express");
const { randomBytes } = require("node:crypto");
const { rateLimit } = require("express-rate-limit");
const { BoundedRateLimitStore } = require("../middleware/boundedRateLimitStore");
const { hmac } = require("../util/hash");

const parseBallot = express.json({ limit: "1kb", inflate: false });
/** @type {import("express").RequestHandler} */
function ballotBody(req, res, next) {
  parseBallot(req, res, error => {
    if (!error) return next();
    const tooLarge = error.status === 413;
    res.status(tooLarge ? 413 : 400).json({ error: { code: tooLarge ? "daily_calls_too_large" : "invalid_daily_calls" } });
  });
}

/** @param {import("../services/dailyCrowd").DailyCrowdService} crowd */
function buildDailyCrowdRouter(crowd) {
  const router = express.Router();
  const limiterSecret = randomBytes(32);
  const limiter = rateLimit({ windowMs: 60_000, max: 8, standardHeaders: "draft-7", legacyHeaders: false,
    keyGenerator: req => hmac(limiterSecret, req.ip ?? ""),
    store: new BoundedRateLimitStore({ maxEntries: 4096 }), message: { error: { code: "rate_limited" } } });
  router.post("/daily/calls", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  }, limiter, ballotBody, async (req, res) => {
    try {
      res.json(await crowd.submit(req.body));
    } catch (error) {
      const { status, code } = /** @type {{status?:number, code?:string}} */ (error);
      if (status && (code?.startsWith("daily_") || code === "invalid_daily_calls")) {
        res.status(status).json({ error: { code } });
      } else {
        res.status(503).json({ error: { code: "daily_calls_unavailable" } });
      }
    }
  });
  return router;
}

module.exports = { buildDailyCrowdRouter };
