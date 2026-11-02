// @ts-nocheck
"use strict";
const express = require("express");
const request = require("supertest");
const pino = require("pino");
const { buildSyncActionJsonParser, isSyncActionPost } = require("../src/middleware/syncActionJson");
const { buildSyncHealthActionsRouter } = require("../src/routes/syncHealthActions");
const { buildErrorHandler } = require("../src/middleware/errorHandler");

function fixture() {
  const logs = [], seen = [];
  const logger = pino({ level: "error" }, { write: line => logs.push(line) });
  const auth = jest.fn((req, _res, next) => { req.auth = { userId: "owner", source: "clerk" }; next(); });
  const users = { findOne: jest.fn(async () => ({ pulseIds: [] })), updateOne: jest.fn(async () => ({ matchedCount: 1 })) };
  const app = express();
  // Same ordering as applyBaseMiddleware: private action parser precedes the
  // ordinary parser, and the common production error logger is last.
  app.use(buildSyncActionJsonParser());
  app.use(express.json({ limit: "512kb" }));
  app.use("/v1/me/sync-health", buildSyncHealthActionsRouter({ auth, users, pairings: { findTokenByHash: jest.fn() } }));
  app.post("/ordinary", (req, res) => res.json(req.body));
  app.use((err, _req, _res, next) => { seen.push(err); next(err); });
  app.use(buildErrorHandler(logger));
  return { app, auth, users, logs, seen };
}

test.each(["/v1/me/sync-health/identity", "/V1/ME/SYNC-HEALTH/IDENTITY/", "/v1/me/sync-health/retry?ignored=1"])("malformed private JSON on %s never reaches auth or leaks into the shared logger/reply", async path => {
  const f = fixture();
  const raw = '{"toonHandle":"1-S2-1-424242","name":"PrivateDisplay","path":"C:/PrivateReplay",broken';
  const res = await request(f.app).post(path).set("content-type", "application/json").send(raw);
  expect(res.status).toBe(400); expect(res.headers["cache-control"]).toBe("private, no-store");
  expect(res.body).toEqual({ error: { code: "sync_fix_invalid_json", message: "sync_fix_invalid_json" } });
  expect(f.auth).not.toHaveBeenCalled(); expect(f.users.findOne).not.toHaveBeenCalled();
  expect(f.seen).toHaveLength(1); expect(f.seen[0].body).toBeUndefined(); expect(f.seen[0].cause).toBeUndefined();
  expect(f.logs).toHaveLength(1);
  for (const value of [JSON.stringify(res.body), f.logs.join(""), f.seen[0].message, f.seen[0].stack]) {
    expect(value).not.toMatch(/1-S2-1-424242|PrivateDisplay|PrivateReplay|toonHandle/);
  }
  expect(JSON.parse(f.logs[0]).err.message).toBe("sync_fix_invalid_json");
});

test("oversized and unsupported-charset private bodies receive fixed errors before auth", async () => {
  const f = fixture();
  const large = await request(f.app).post("/v1/me/sync-health/identity").send({ toonHandle: "PrivateDisplay".repeat(100) });
  expect(large.status).toBe(413); expect(large.body.error.code).toBe("sync_fix_invalid_json");
  const charset = await request(f.app).post("/v1/me/sync-health/retry").set("content-type", "application/json; charset=not-a-charset").send('{"private":"PrivateDisplay"}');
  expect(charset.status).toBe(415); expect(charset.body.error.code).toBe("sync_fix_invalid_json");
  expect(f.logs.join("")).not.toContain("PrivateDisplay"); expect(f.auth).not.toHaveBeenCalled();
});

test("valid action JSON is parsed exactly once before the owner action", async () => {
  const f = fixture(); const res = await request(f.app).post("/v1/me/sync-health/identity").send({ toonHandle: "1-S2-1-42" });
  expect(res.status).toBe(200); expect(res.body).toEqual({ code: "added", count: 1 });
  expect(f.auth).toHaveBeenCalledTimes(1); expect(f.users.updateOne).toHaveBeenCalledTimes(1); expect(f.logs).toEqual([]);
});

test("the boundary does not change unrelated JSON routes or methods", async () => {
  const f = fixture();
  const ordinary = await request(f.app).post("/ordinary").send({ text: "x".repeat(2048) });
  expect(ordinary.status).toBe(200); expect(ordinary.body.text).toHaveLength(2048);
  expect(isSyncActionPost({ method: "PUT", originalUrl: "/v1/me/sync-health/identity" })).toBe(false);
  expect(isSyncActionPost({ method: "POST", originalUrl: "/v1/me/sync-health/identity-extra" })).toBe(false);
  expect(isSyncActionPost({ method: "POST", originalUrl: "https://api.example/v1/me/sync-health/retry?ignored=1" })).toBe(true);
});
