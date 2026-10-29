// @ts-nocheck
"use strict";

jest.mock("@clerk/backend", () => ({ verifyToken: jest.fn() }));
const express = require("express");
const request = require("supertest");
const { verifyToken } = require("@clerk/backend");
const { buildAuth } = require("../src/middleware/auth");
const { DevicePairingsService } = require("../src/services/devicePairings");
const { DeviceLiveness } = require("../src/services/deviceLiveness");
const { prepareDeviceCredentialsForServing } = require("../src/services/deviceCredentialReadiness");
const { attachSocketAuth } = require("../src/socket/auth");
const { authFixture, deferred } = require("./helpers/deviceAuthFixture");
const { sha256 } = require("../src/util/hash");
const { randomUUID } = require("crypto");

const bearer = "A".repeat(43), hash = sha256(bearer);
function app(reuse, original, nextObserved = () => {}) {
  const server = express();
  server.use(buildAuth({ secretKey: "synthetic", getDeviceToken: original, deviceTokenReuse: reuse,
    ensureUser: async () => ({ userId: "clerk-owner" }) }));
  server.get("/", (req, res) => { nextObserved(); res.json(req.auth); });
  server.use((error, _req, res, _next) => res.status(error.status || 500).json({ code: error.code }));
  return server;
}
beforeEach(() => { jest.clearAllMocks(); verifyToken.mockRejectedValue(new Error("invalid")); });

test("actual middleware consumes once immediately before original-shaped auth and next", async () => {
  const f = authFixture(), original = jest.fn(async () => ({ userId: "fallback" })), seen = [];
  const reuse = { prepare: value => f.cache.prepare(value), consume: (value, ticket) => {
    const hit = f.cache.consume(value, ticket); seen.push("consume");
    queueMicrotask(() => { seen.push("after-consume-microtask"); }); return hit;
  } };
  const server = app(reuse, original, () => seen.push("next"));
  const response = await request(server).get("/").set("Authorization", `Bearer ${bearer}`);
  expect(response.body).toEqual({ userId: "owner-a", source: "device", tokenHash: hash });
  expect(original).not.toHaveBeenCalled(); expect(f.read).toHaveBeenCalledTimes(1);
  expect(seen).toEqual(["consume", "next", "after-consume-microtask"]); expect(f.cache.tickets.size).toBe(0);
  await f.cache.stopAndDrain();
});

test.each(["expired", "generation", "incarnation", "shutdown"])("held %s ticket cannot become a fallback result", async mode => {
  const f = authFixture(), held = deferred(), entered = deferred();
  const reuse = { prepare: async value => { const ticket = await f.cache.prepare(value); entered.resolve(); await held.promise; return ticket; }, consume: f.cache.consume.bind(f.cache) };
  const original = jest.fn(async () => ({ userId: "fresh-original" }));
  const response = request(app(reuse, original)).get("/").set("Authorization", `Bearer ${bearer}`).then(value => value);
  await entered.promise;
  if (mode === "expired") f.clock.mono = 1800;
  if (mode === "generation" || mode === "incarnation") {
    f.clock.mono = 1; f.row[mode] = randomUUID();
    f.lease.expire(f.lease.grant); await f.cache.prepare(hash);
  }
  if (mode === "shutdown") await f.cache.stopAndDrain();
  held.resolve();
  expect((await response).body.userId).toBe("fresh-original"); expect(original).toHaveBeenCalledTimes(1);
  expect(f.read).toHaveBeenCalledTimes(mode === "generation" || mode === "incarnation" ? 2 : 1);
  await f.cache.stopAndDrain();
});

test.each(["prepare rejection", "consume throw", "cache miss"])("%s preserves one independent original lookup and Clerk fallback", async mode => {
  const reuse = { prepare: async () => { if (mode === "prepare rejection") throw new Error("cache"); return mode === "cache miss" ? null : {}; }, consume: () => { throw new Error("cache"); } };
  const original = jest.fn(async () => null); verifyToken.mockResolvedValue({ sub: "synthetic-clerk" });
  const response = await request(app(reuse, original)).get("/").set("Authorization", `Bearer ${bearer}`);
  expect(response.body).toEqual({ userId: "clerk-owner", clerkUserId: "synthetic-clerk", source: "clerk" });
  expect(original).toHaveBeenCalledTimes(1); expect(original).toHaveBeenCalledWith(hash);
});

test("original account-deleted rejection and absent-adapter path remain unchanged", async () => {
  const original = jest.fn(async () => { throw Object.assign(new Error("deleted"), { code: "account_deleted" }); });
  const response = await request(app(undefined, original)).get("/").set("Authorization", `Bearer ${bearer}`);
  expect(response.status).toBe(401); expect(response.body).toEqual({ code: "account_deleted" });
  expect(original).toHaveBeenCalledTimes(1); expect(verifyToken).not.toHaveBeenCalled();
});

test("failed readiness leaves actual REST and socket authoritative lookups usable", async () => {
  const row = { _id: "device-a", userId: "owner-a", lastSeenAt: new Date(100000) };
  const collection = { findOne: jest.fn(async () => row) }, liveness = new DeviceLiveness({ now: () => 100000 });
  const pairings = new DevicePairingsService({ deviceTokens: collection }, { liveness });
  expect(await prepareDeviceCredentialsForServing({ readiness: { ensure: async () => { throw new Error("metadata"); } } }, null)).toBe(false);
  expect((await request(app(undefined, value => pairings.findTokenByHash(value))).get("/").set("Authorization", `Bearer ${bearer}`)).body.userId).toBe("owner-a");
  let middleware; const io = { use: value => { middleware = value; }, on: () => {} };
  attachSocketAuth(io, { secretKey: "synthetic", resolveDeviceToken: value => pairings.findTokenByHash(value) });
  const socket = { handshake: { auth: { deviceToken: bearer, obsAddSource: { supported: true, enabled: false } } }, data: {} };
  await new Promise((resolve, reject) => middleware(socket, error => error ? reject(error) : resolve()));
  expect(socket.data).toMatchObject({ userId: "owner-a", deviceId: "device-a", kind: "device", obsAddSource: { supported: true, enabled: false } });
  expect(collection.findOne).toHaveBeenCalledTimes(2);
  for (const call of collection.findOne.mock.calls) expect(call).toEqual([{ tokenHash: hash, revokedAt: null }, { projection: { _id: 1, userId: 1, lastSeenAt: 1 } }]);
});
