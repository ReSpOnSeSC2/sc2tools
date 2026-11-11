"use strict";

const express = require("express");
const rateLimitModule = require("express-rate-limit");
const { BoundedRateLimitStore } = require("../middleware/boundedRateLimitStore");
const { sha256 } = require("../util/hash");
const { rewardError } = require("../services/twitchRewardPolicy");
const rateLimit = /** @type {any} */ (rateLimitModule).default || rateLimitModule;

/** @param {{auth:import('express').RequestHandler,rewards:import('../services/twitchRewards').TwitchRewardsService}} deps */
function buildTwitchRewardsRouter(deps) {
  const router = express.Router();
  /** @type {import('express').RequestHandler} */
  const ownerOnly = (req, res, next) => {
    res.set("Cache-Control", "private, no-store"); res.vary("Authorization");
    if (req.auth?.source !== "clerk") return next(rewardError("clerk_required", 403));
    res.locals.rewardOwner = req.auth.userId;
    next();
  };
  /** @param {string} lane @param {number} max */
  const limit = (lane, max) => rateLimit({ windowMs: 60_000, max, standardHeaders: true, legacyHeaders: false,
    store: new BoundedRateLimitStore({ maxEntries: 1024 }),
    /** @param {import('express').Request} req */
    keyGenerator: req => `${lane}:${sha256(String(req.auth?.userId || ""))}` });
  const base = "/me/twitch-rewards";
  router.get(base, deps.auth, ownerOnly, limit("rewards-status", 30), async (_req, res, next) => {
    try { res.json(await deps.rewards.status(res.locals.rewardOwner)); } catch (error) { next(error); }
  });
  router.put(base, deps.auth, ownerOnly, limit("rewards-save", 8), async (req, res, next) => {
    try { res.json(await deps.rewards.save(res.locals.rewardOwner, req.body)); } catch (error) { next(error); }
  });
  router.get(`${base}/catalog`, deps.auth, ownerOnly, limit("rewards-catalog", 8), async (_req, res, next) => {
    try { res.json({ rewards: await deps.rewards.listRewards(res.locals.rewardOwner) }); } catch (error) { next(error); }
  });
  router.post(`${base}/catalog`, deps.auth, ownerOnly, limit("rewards-create", 5), async (req, res, next) => {
    try { res.status(201).json({ reward: await deps.rewards.createReward(res.locals.rewardOwner, req.body) }); } catch (error) { next(error); }
  });
  return router;
}

module.exports = { buildTwitchRewardsRouter };
