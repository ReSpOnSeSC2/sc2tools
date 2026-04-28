"use strict";

const rateLimitModule = require("express-rate-limit");
const { RATE, HEADER } = require("../constants");

const rateLimit = /** @type {any} */ (rateLimitModule).default || rateLimitModule;

/**
 * Read rate limit: per IP. Mounted on read-only routes.
 *
 * @returns {import('express').RequestHandler}
 */
function readLimiter() {
  return rateLimit({
    windowMs: RATE.WINDOW_MS,
    limit: RATE.READ_PER_HOUR_PER_IP,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "rate_limited", scope: "ip-reads" },
  });
}

/**
 * Write rate limit: per client_id. Mounted on write routes after auth.
 *
 * @returns {import('express').RequestHandler}
 */
function writeLimiter() {
  return rateLimit({
    windowMs: RATE.WINDOW_MS,
    limit: RATE.WRITE_PER_HOUR_PER_CLIENT,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: keyByClientIdOrIp,
    message: { error: "rate_limited", scope: "client-writes" },
  });
}

/** @param {import('express').Request} req @returns {string} */
function keyByClientIdOrIp(req) {
  const id = req.header(HEADER.CLIENT_ID);
  if (typeof id === "string" && id.length > 0) return `cid:${id.toLowerCase()}`;
  return `ip:${req.ip}`;
}

module.exports = { readLimiter, writeLimiter };
