"use strict";

const express = require("express");
const { rateLimit } = require("express-rate-limit");

const ID = /^[a-f0-9]{32}$/;
const CATALOG_ID = /^[a-f0-9]{24}$/;
const DEVICE_ID = /^[a-f0-9]{24}$/;
const RACES = new Set(["Protoss", "Terran", "Zerg"]);
const STATUSES = new Set(["starting", "playing", "finished", "closed", "failed", "unknown"]);

/** @param {number} status @param {string} code */
function fail(status, code) {
  return Object.assign(new Error(code), { status, code });
}

/** @param {unknown} value @param {number} limit */
function label(value, limit = 160) {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

/** @param {any} raw */
function catalog(raw) {
  const bots = Array.isArray(raw?.bots) ? raw.bots : [];
  const maps = Array.isArray(raw?.maps) ? raw.maps : [];
  return {
    agent: {
      available: true,
      ready: raw?.ready === true,
      code: label(raw?.code, 60),
      message: label(raw?.message, 240),
    },
    bots: bots.slice(0, 300).filter((/** @type {any} */ b) => CATALOG_ID.test(b?.id) && RACES.has(b.race)).map((/** @type {any} */ b) => ({
      id: b.id, label: label(b.label), race: b.race,
      updates: Number.isSafeInteger(b.updates) && b.updates >= 0 ? b.updates : 0,
      maxApm: b.race === "Protoss" ? 200 : 600,
      cameraRestricted: b.race === "Protoss",
    })),
    maps: maps.slice(0, 100).filter((/** @type {any} */ m) => CATALOG_ID.test(m?.id)).map((/** @type {any} */ m) => ({ id: m.id, label: label(m.label) })),
    activeSessionId: ID.test(raw?.activeSessionId) ? raw.activeSessionId : null,
    startWorkers: 8,
  };
}

/** @param {any} raw @param {string} id @param {string} deviceId */
function session(raw, id, deviceId) {
  return {
    id, deviceId,
    status: STATUSES.has(raw?.status) ? raw.status : "unknown",
    ...(ID.test(raw?.sessionId) ? { sessionId: raw.sessionId } : {}),
    ...(RACES.has(raw?.humanRace) ? { humanRace: raw.humanRace } : {}),
    ...(RACES.has(raw?.botRace) ? { botRace: raw.botRace } : {}),
    botLabel: label(raw?.botLabel), map: label(raw?.map),
    result: label(raw?.result, 60), error: label(raw?.error, 240),
  };
}

/**
 * Private, default-off RPC only. No engine, replay or model work runs here.
 * @param {{auth: import('express').RequestHandler, io?: any,
 * isAdmin: (req: import('express').Request) => boolean, enabled: boolean}} deps
 */
function buildBotLabRouter(deps) {
  const router = express.Router();
  // Disabled routes do not authenticate, enumerate devices or allocate timers.
  if (!deps.enabled) {
    router.use((_req, res) => { res.sendStatus(404); });
    return router;
  }
  router.use(deps.auth, (req, res, next) => {
    if (req.auth?.source !== "clerk" || !deps.isAdmin(req)) { res.sendStatus(404); return; }
    res.set("cache-control", "private, no-store");
    res.set("x-robots-tag", "noindex, nofollow");
    next();
  });
  router.use(rateLimit({ windowMs: 60000, limit: 40, standardHeaders: "draft-7", legacyHeaders: false,
    keyGenerator: (req) => String(req.auth?.userId) }));
  /** @type {Set<string>} */
  const activeRequests = new Set();

  /** @param {string} userId */
  async function devicesFor(userId) {
    if (!deps.io) return [];
    const sockets = await deps.io.in(`user:${userId}`).fetchSockets();
    // A stale/reconnecting socket must not turn one device into two choices.
    const unique = new Map();
    for (const socket of sockets) {
      if (socket.data?.kind === "device" && String(socket.data.userId) === userId && DEVICE_ID.test(socket.data.deviceId)) {
        unique.set(socket.data.deviceId, socket);
      }
    }
    return [...unique.values()];
  }

  /** @param {any[]} devices @param {unknown} raw */
  function choose(devices, raw) {
    if (raw !== undefined && (typeof raw !== "string" || !DEVICE_ID.test(raw))) throw fail(400, "invalid_device");
    if (raw) {
      const match = devices.find((device) => device.data.deviceId === raw);
      if (!match) throw fail(409, "device_offline");
      return match;
    }
    if (devices.length !== 1) throw fail(409, devices.length ? "choose_device" : "agent_offline");
    return devices[0];
  }

  /** @param {any} device @param {Record<string, unknown>} payload */
  async function rpc(device, payload) {
    const key = String(device.data.deviceId);
    if (activeRequests.has(key)) throw fail(409, "device_request_pending");
    activeRequests.add(key);
    try {
      // One device, one dispatch. An ambiguous ACK never launches elsewhere.
      const reply = await device.timeout(15000).emitWithAck("bot-lab:request", payload);
      if (!reply || typeof reply !== "object" || Array.isArray(reply) || JSON.stringify(reply).length > 131072) throw fail(502, "invalid_agent_reply");
      return reply;
    } catch (err) {
      if (/** @type {any} */ (err)?.status) throw err;
      throw fail(504, "agent_ack_unknown");
    } finally { activeRequests.delete(key); }
  }

  router.get("/catalog", async (req, res, next) => {
    try {
      const devices = await devicesFor(String(req.auth?.userId));
      const choices = devices.map((device, index) => ({ id: device.data.deviceId, label: `Local agent ${index + 1} (${device.data.deviceId.slice(-6)})` }));
      if (req.query.deviceId === undefined && devices.length !== 1) {
        res.json({ enabled: true, devices: choices, deviceId: null,
          agent: { available: devices.length > 0, ready: false, code: devices.length ? "choose_device" : "agent_offline" },
          bots: [], maps: [], activeSessionId: null, startWorkers: 8 });
        return;
      }
      const device = choose(devices, req.query.deviceId);
      res.json({ enabled: true, devices: choices, deviceId: device.data.deviceId, ...catalog(await rpc(device, { operation: "catalog" })) });
    } catch (err) { next(err); }
  });

  router.post("/sessions", async (req, res, next) => {
    try {
      const body = req.body;
      const keys = ["deviceId", "requestId", "botId", "mapId", "humanRace"];
      if (!body || typeof body !== "object" || Object.keys(body).length !== keys.length || keys.some((key) => typeof body[key] !== "string") || Object.keys(body).some((key) => !keys.includes(key)) || !ID.test(body.requestId) || !CATALOG_ID.test(body.botId) || !CATALOG_ID.test(body.mapId) || !RACES.has(body.humanRace)) throw fail(400, "invalid_bot_start");
      const device = choose(await devicesFor(String(req.auth?.userId)), body.deviceId);
      const reply = await rpc(device, { operation: "start", requestId: body.requestId, botId: body.botId, mapId: body.mapId, humanRace: body.humanRace });
      res.status(202).json(session(reply, body.requestId, device.data.deviceId));
    } catch (err) { next(err); }
  });

  /** @param {'status'|'stop'} operation @returns {import('express').RequestHandler} */
  function sessionRequest(operation) {
    return async (req, res, next) => {
      try {
        if (!ID.test(req.params.id)) throw fail(400, "invalid_session");
        if (operation === "stop" && (!req.body || Object.keys(req.body).length !== 1 || typeof req.body.deviceId !== "string")) throw fail(400, "invalid_stop");
        const rawDevice = operation === "stop" ? req.body.deviceId : req.query.deviceId;
        if (!rawDevice) throw fail(400, "device_required");
        const device = choose(await devicesFor(String(req.auth?.userId)), rawDevice);
        res.json(session(await rpc(device, { operation, requestId: req.params.id }), req.params.id, device.data.deviceId));
      } catch (err) { next(err); }
    };
  }
  router.get("/sessions/:id", sessionRequest("status"));
  router.post("/sessions/:id/stop", sessionRequest("stop"));
  return router;
}

module.exports = { buildBotLabRouter };
