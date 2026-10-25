"use strict";

const express = require("express");
const { randomBytes } = require("crypto");
const { rateLimit } = require("express-rate-limit");
const { KNOWN_WIDGETS } = require("../services/overlayTokens");
const { BoundedRateLimitStore } = require("../middleware/boundedRateLimitStore");
const DEVICE_ID = /^[a-f0-9]{24}$/;
const WIDGETS = new Set(KNOWN_WIDGETS); // Ghost requires a private assigned URL fragment; use Copy/Drag.
const CODES = new Set(["added", "already_present", "declined", "disabled", "obs_unavailable", "scene_changed", "expired", "busy", "owner_changed", "local_error", "token_unavailable", "invalid_request"]);
/** @param {number} status @param {string} code */
function fail(status, code) { return Object.assign(new Error(code), { status, code }); }

/** One private request to one authenticated device; no replay/database work.
 * @param {{auth: import('express').RequestHandler, io?: any, timeoutMs?: number}} deps */
function buildObsSourcesRouter(deps) {
  const router = express.Router();
  router.use(deps.auth, (req, res, next) => {
    res.set("cache-control", "private, no-store");
    if (req.auth?.source !== "clerk") { res.sendStatus(403); return; }
    next();
  });
  router.use(rateLimit({ windowMs: 60000, limit: 30, standardHeaders: "draft-7", legacyHeaders: false,
    keyGenerator: req => String(req.auth?.userId), store: new BoundedRateLimitStore({ maxEntries: 4096 }) }));
  /** @type {Set<string>} */ const pending = new Set();
  /** @param {string} owner */
  async function devicesFor(owner) {
    /** @type {NodeJS.Timeout|undefined} */ let timer;
    const sockets = deps.io ? await Promise.race([deps.io.in(`user:${owner}`).fetchSockets(), new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(fail(503, "obs_presence_unavailable")), 1000);
    })]).finally(() => clearTimeout(timer)) : [];
    const devices = new Map();
    for (const device of sockets) {
      if (device.data?.kind === "device" && String(device.data.userId) === owner && DEVICE_ID.test(device.data.deviceId)) devices.set(device.data.deviceId, device);
    }
    return [...devices.values()].slice(0, 32);
  }
  router.get("/", async (req, res, next) => {
    try {
      const devices = await devicesFor(String(req.auth?.userId));
      res.json({ devices: devices.map((device, index) => ({ id: device.data.deviceId, label: `Local agent ${index + 1} (${device.data.deviceId.slice(-6)})`,
        supported: device.data.obsAddSource?.supported === true, enabled: device.data.obsAddSource?.enabled === true })) });
    } catch (err) { next(err); }
  });
  router.post("/add-source", async (req, res, next) => {
    const owner = String(req.auth?.userId);
    let admitted = false;
    try {
      const body = req.body;
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !["widget", "deviceId"].includes(key)) || !WIDGETS.has(body.widget)
          || (body.deviceId !== undefined && (typeof body.deviceId !== "string" || !DEVICE_ID.test(body.deviceId)))) throw fail(400, "invalid_obs_source");
      if (pending.has(owner)) throw fail(409, "obs_request_pending");
      if (pending.size >= 64) throw fail(503, "obs_capacity");
      pending.add(owner); admitted = true;
      const devices = await devicesFor(owner);
      const eligible = devices.filter(device => device.data.obsAddSource?.supported === true && device.data.obsAddSource?.enabled === true);
      const device = body.deviceId ? eligible.find(row => row.data.deviceId === body.deviceId) : eligible.length === 1 ? eligible[0] : null;
      if (!device) throw fail(409, !devices.length ? "agent_offline" : !eligible.length ? "obs_disabled" : body.deviceId ? "device_offline" : "choose_device");
      const requestId = randomBytes(16).toString("hex"), deviceId = device.data.deviceId;
      const timeout = deps.timeoutMs ?? 45000;
      const payload = { requestId, deviceId, widget: body.widget, expiresAt: Date.now() + timeout - 1000 };
      // Socket.io ACK timeout bounds dispatch. No broadcast or automatic retry.
      /** @type {NodeJS.Timeout|undefined} */ let timer;
      const reply = await Promise.race([device.timeout(timeout).emitWithAck("obs:add-source", payload), new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(fail(504, "obs_ack_unknown")), timeout);
      })]).finally(() => clearTimeout(timer));
      if (!reply || typeof reply !== "object" || reply.requestId !== requestId || reply.deviceId !== deviceId || !CODES.has(reply.code)) throw fail(502, "invalid_obs_ack");
      res.json({ code: reply.code, requestId, deviceId });
    } catch (err) {
      next(/** @type {any} */ (err)?.status ? err : fail(504, "obs_ack_unknown"));
    } finally { if (admitted) pending.delete(owner); }
  });
  return router;
}
module.exports = { buildObsSourcesRouter };
