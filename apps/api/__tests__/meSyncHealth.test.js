// @ts-nocheck
"use strict";

/**
 * GET /v1/me/sync-health through the real me router and UsersService (over a
 * counting users-collection double): per-route auth, a private uncached
 * reply, no query string, one owner read, and reported:false for agents that
 * never sent a sync report.
 */

const express = require("express");
const request = require("supertest");
const pino = require("pino");
const { buildMeRouter } = require("../src/routes/me");
const { buildErrorHandler } = require("../src/middleware/errorHandler");
const { UsersService } = require("../src/services/users");

const PRIVATE = { name: "SecretSmurf", toonHandle: "2-S2-1-987654", count: 4 };
const ago = (ms) => new Date(Date.now() - ms);

function harness({ row = { userId: "owner" }, devices = [], agentVersion } = {}) {
  const users = { findOne: jest.fn(async () => row), updateOne: jest.fn(), insertOne: jest.fn() };
  const pairings = { latestAgent: jest.fn(), listDevices: jest.fn(async () => devices) };
  const auth = (req, res, next) => {
    if (req.get("authorization") !== "Bearer owner") { res.status(401).json({ error: { code: "auth_required" } }); return; }
    req.auth = { userId: "owner", source: "clerk" }; next();
  };
  const app = express();
  app.use(express.json());
  app.use("/v1", buildMeRouter({ users: new UsersService({ users, games: {} }), games: {}, gdpr: {}, pairings, auth,
    ...(agentVersion ? { agentVersion } : {}) }));
  app.use(buildErrorHandler(pino({ level: "silent" })));
  const get = (path = "/v1/me/sync-health") => request(app).get(path).set("authorization", "Bearer owner");
  return { app, users, pairings, get };
}

test("auth is applied per route and nothing is read without it", async () => {
  const { app, users, pairings } = harness();
  const res = await request(app).get("/v1/me/sync-health");
  expect(res.status).toBe(401);
  expect(users.findOne).not.toHaveBeenCalled();
  expect(pairings.listDevices).not.toHaveBeenCalled();
});

test.each(["?deviceId=pc-1", "?userId=other", "?refresh"])("query %s is refused before any read", async (query) => {
  const { users, pairings, get } = harness();
  const res = await get(`/v1/me/sync-health${query}`);
  expect(res.status).toBe(400);
  expect(res.body).toEqual({ error: { code: "sync_health_query_invalid" } });
  expect(res.headers["cache-control"]).toBe("private, no-store");
  expect(users.findOne).not.toHaveBeenCalled();
  expect(pairings.listDevices).not.toHaveBeenCalled();
});

test("an agent that never sent a report is reported:false, from one owner read and no release lookup", async () => {
  const seen = ago(30_000), latest = jest.fn();
  const { users, pairings, get } = harness({ devices: [{ deviceId: "pc-1", userId: "owner", agentVersion: "0.24.0", lastSeenAt: seen }],
    agentVersion: { latest } });
  const res = await get();
  expect(res.status).toBe(200);
  expect(res.headers["cache-control"]).toBe("private, no-store");
  expect(res.body).toEqual({ checkedAt: expect.any(String), reported: false, rows: [], rejections: null,
    devices: [{ deviceId: "pc-1", agentVersion: "0.24.0", lastSeenAt: seen.toISOString(), reported: false }] });
  expect(users.findOne).toHaveBeenCalledTimes(1);
  expect(users.findOne).toHaveBeenCalledWith({ userId: "owner" }, expect.objectContaining({
    readPreference: "primary", projection: expect.objectContaining({ ingestStats: 1 }) }));
  expect(pairings.listDevices).toHaveBeenCalledTimes(1);
  expect(pairings.listDevices).toHaveBeenCalledWith("owner");
  expect(latest).not.toHaveBeenCalled();
});

test("no paired PC is reported:false with an empty device list", async () => {
  const res = await harness().get();
  expect(res.body).toMatchObject({ reported: false, rows: [], devices: [], rejections: null });
});

test("a current report becomes rows, and its owner gets the report whole", async () => {
  const reportedAt = ago(20_000), rejectedAt = ago(3_600_000);
  const latest = jest.fn(async () => ({ minSupportedVersion: "0.31.0" }));
  const sync = { paused: true, pending: 2, skipped: { player_unresolved: 3 }, unresolvedNames: [PRIVATE] };
  const { users, get } = harness({
    row: { userId: "owner", ingestStats: { rejected: { validation_failed: 2 }, rejectedSince: rejectedAt, lastRejectedAt: rejectedAt } },
    devices: [{ deviceId: "pc-1", agentVersion: "0.30.0", agentOs: "Windows", lastSeenAt: reportedAt, sync, syncReportedAt: reportedAt }],
    agentVersion: { latest },
  });
  const res = await get();
  expect(res.status).toBe(200);
  expect(res.body.reported).toBe(true);
  expect(res.body.rows).toEqual([
    { code: "agent_paused", severity: "info", count: 2, deviceId: "pc-1", helpSlug: "desktop-app-status", fix: "resume" },
    { code: "agent_outdated_required", severity: "warn", count: 1, deviceId: "pc-1", helpSlug: "desktop-app-status", fix: "update_agent" },
    { code: "replays_skipped_unresolved", severity: "warn", count: 3, deviceId: "pc-1", helpSlug: "my-game-didnt-show-up", fix: "add_identity" },
    { code: "uploads_rejected", severity: "warn", count: 2, helpSlug: "my-game-didnt-show-up", fix: "report" },
  ]);
  expect(res.body.devices[0]).toMatchObject({ deviceId: "pc-1", reported: true, syncReportedAt: reportedAt.toISOString(), sync });
  expect(res.body.rejections).toEqual({ count: 2, byCode: { validation_failed: 2 }, since: rejectedAt.toISOString(), lastRejectedAt: rejectedAt.toISOString() });
  expect(users.findOne).toHaveBeenCalledTimes(1);
  expect(latest).toHaveBeenCalledWith({ platform: "windows" });
});

test("without the optional release service, or when it fails, the route still answers", async () => {
  const device = { deviceId: "pc-1", agentVersion: "0.1.0", lastSeenAt: ago(1000), sync: { pending: 0 }, syncReportedAt: ago(1000) };
  const plain = await harness({ devices: [device] }).get();
  expect(plain.status).toBe(200);
  expect(plain.body).toMatchObject({ reported: true, rows: [] });
  const failing = await harness({ devices: [device], agentVersion: { latest: async () => { throw new Error("releases down"); } } }).get();
  expect(failing.status).toBe(200);
  expect(failing.body.rows).toEqual([]);
});

test("a stale report and an old rejection window both clear", async () => {
  const old = ago(8 * 24 * 3_600_000);
  const res = await harness({
    row: { userId: "owner", ingestStats: { rejected: { validation_failed: 5 }, rejectedSince: old, lastRejectedAt: old } },
    devices: [{ deviceId: "pc-1", lastSeenAt: ago(600_000), sync: { paused: true }, syncReportedAt: ago(600_000) }],
  }).get();
  expect(res.body).toMatchObject({ reported: false, rows: [], rejections: null });
  expect(res.body.devices[0].sync).toBeUndefined();
});
