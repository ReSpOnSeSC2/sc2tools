// @ts-nocheck
"use strict";
const express = require("express");
const request = require("supertest");
const { buildSyncHealthActionsRouter } = require("../src/routes/syncHealthActions");
const { SyncHealthFixes, RETRY_REASONS } = require("../src/services/syncHealthFixes");
const { sha256 } = require("../src/util/hash");
const DEVICE = "a".repeat(24), OTHER = "b".repeat(24);
function fixture(options = {}) {
  const emit = jest.fn(options.ack || (async (_event, payload) => ({ ...payload, code: "accepted", count: 3, name: "private", path: "C:/private" })));
  const device = { id: "namespace-session", handshake: { auth: { deviceToken: "private-token" } },
    data: { kind: "device", userId: "owner", deviceId: DEVICE, syncRetryVersion: 1 }, timeout: jest.fn(() => ({ emitWithAck: emit })) };
  const fetchSockets = jest.fn(async () => options.devices ?? [device]);
  const io = { in: jest.fn(() => ({ fetchSockets })) };
  const pairings = { findTokenByHash: jest.fn(async () => ({ userId: "owner", deviceId: DEVICE })) };
  const users = { findOne: jest.fn(async () => ({ pulseId: "legacy" })), updateOne: jest.fn(async () => ({ matchedCount: 1 })) };
  const deps = { io, pairings, users, timeoutMs: options.timeoutMs, now: options.now };
  const service = new SyncHealthFixes(deps);
  const app = express(); app.use(express.json());
  app.use("/v1/me/sync-health", buildSyncHealthActionsRouter({ ...deps, auth: (req, res, next) => {
    if (options.source === "none") return res.status(401).end();
    req.auth = { userId: "owner", source: options.source || "clerk" }; next();
  } }));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ code: err.code }));
  return { app, service, device, emit, fetchSockets, io, pairings, users };
}
const retry = f => request(f.app).post("/v1/me/sync-health/retry").send({ deviceId: DEVICE, reason: "player_unresolved" });

test.each(["device", "overlay", "none"])("only the owner Clerk session can act (%s rejected before any read)", async source => {
  const f = fixture({ source });
  for (const [path, body] of [["identity", { toonHandle: "1-S2-1-42" }], ["retry", { deviceId: DEVICE, reason: "parse_failed" }]]) {
    expect((await request(f.app).post(`/v1/me/sync-health/${path}`).send(body)).status).toBe(source === "none" ? 401 : 403);
  }
  expect(f.users.findOne).not.toHaveBeenCalled(); expect(f.fetchSockets).not.toHaveBeenCalled();
});

test.each([{}, [], { toonHandle: "bad" }, { toonHandle: "1-S2-1-42", userId: "foreign" }, { toonHandle: { $ne: "" } }, { toonHandle: `1-S2-1-${"9".repeat(32)}` }])("strict identity request %j performs no read/write", async body => {
  const f = fixture(); expect((await request(f.app).post("/v1/me/sync-health/identity").send(body)).status).toBe(400);
  expect(f.users.findOne).not.toHaveBeenCalled(); expect(f.users.updateOne).not.toHaveBeenCalled();
});

test("add-one writes only owner's identity fields and returns no identity/profile data", async () => {
  const f = fixture(); const res = await request(f.app).post("/v1/me/sync-health/identity").send({ toonHandle: "1-S2-1-42" });
  expect(res.status).toBe(200); expect(res.headers["cache-control"]).toBe("private, no-store");
  expect(res.body).toEqual({ code: "added", count: 2 });
  expect(f.users.updateOne.mock.calls[0][0].userId).toBe("owner");
  expect(f.users.updateOne.mock.calls[0][1]).toEqual({ $set: { pulseIds: ["legacy", "1-S2-1-42"], pulseId: "legacy", _schemaVersion: 1 } });
});

test.each([[null, 404, "sync_owner_missing"], [{ pulseIds: ["1-S2-1-42"] }, 200, "already_present"],
  [{ pulseIds: Array.from({ length: 20 }, (_, i) => String(i)) }, 409, "sync_identity_capacity"], [{ _gdprMutation: true }, 409, "sync_identity_busy"]])("identity status distinguishes %j without writes", async (doc, status, code) => {
  const f = fixture(); f.users.findOne.mockResolvedValue(doc);
  const res = await request(f.app).post("/v1/me/sync-health/identity").send({ toonHandle: "1-S2-1-42" });
  expect(res.status).toBe(status); expect(res.body.code).toBe(code); expect(f.users.updateOne).not.toHaveBeenCalled();
});

test("private database errors are replaced before reaching the common error logger", async () => {
  const f = fixture(); f.users.findOne.mockRejectedValue(new Error("private toon 1-S2-1-42"));
  await expect(f.service.identity("owner", { toonHandle: "1-S2-1-42" })).rejects.toMatchObject({ status: 503, message: "sync_identity_unavailable" });
});

test.each([{}, [], { deviceId: DEVICE, reason: "filtered" }, { deviceId: DEVICE, reason: "ai_game" }, { deviceId: DEVICE, reason: "resumed_replay" },
  { deviceId: DEVICE, reason: "no_result" }, { deviceId: DEVICE, reason: "parse_failed", paths: ["C:/private"] }, { deviceId: "bad", reason: "parse_failed" }])("strict retry %j performs no discovery", async body => {
  const f = fixture(); expect((await request(f.app).post("/v1/me/sync-health/retry").send(body)).status).toBe(400);
  expect(f.fetchSockets).not.toHaveBeenCalled(); expect(f.emit).not.toHaveBeenCalled();
});

test("query parameters cannot smuggle an owner or alter either action", async () => {
  const f = fixture();
  for (const path of ["identity", "retry"]) expect((await request(f.app).post(`/v1/me/sync-health/${path}?userId=foreign`).send({})).status).toBe(400);
  expect(f.users.findOne).not.toHaveBeenCalled(); expect(f.fetchSockets).not.toHaveBeenCalled();
});

test.each([...RETRY_REASONS])("%s reaches exactly the chosen live device through the NEW scoped event and strips private ACK extras", async reason => {
  const f = fixture(); const res = await request(f.app).post("/v1/me/sync-health/retry").send({ deviceId: DEVICE, reason });
  expect(res.status).toBe(200); expect(res.headers["cache-control"]).toBe("private, no-store");
  expect(res.body).toEqual({ code: "accepted", count: 3, requestId: expect.stringMatching(/^[a-f0-9]{32}$/), deviceId: DEVICE });
  expect(f.io.in).toHaveBeenCalledWith("user:owner"); expect(f.emit).toHaveBeenCalledTimes(1);
  const [event, payload] = f.emit.mock.calls[0]; expect(event).toBe("sync:retry-request");
  expect(payload).toEqual({ requestId: res.body.requestId, deviceId: DEVICE, sessionId: "namespace-session", reason, expiresAt: expect.any(Number) });
  expect(payload.expiresAt - Date.now()).toBeLessThanOrEqual(10000);
  expect(f.pairings.findTokenByHash).toHaveBeenCalledTimes(2);
  expect(f.pairings.findTokenByHash).toHaveBeenCalledWith(sha256("private-token"));
});

test.each([[], [{ data: { kind: "web", userId: "owner", deviceId: DEVICE } }], [{ data: { kind: "overlay", userId: "owner", deviceId: DEVICE } }],
  [{ data: { kind: "device", userId: "foreign", deviceId: DEVICE } }], [{ data: { kind: "device", userId: "owner", deviceId: OTHER } }]].map(devices => ({ devices })))("foreign, web, overlay, different or offline devices never receive a command", async ({ devices }) => {
  const f = fixture({ devices }); expect((await retry(f)).body.code).toBe("sync_agent_offline"); expect(f.emit).not.toHaveBeenCalled();
});

test("old agent lacks the strict wire capability and gets an explicit update outcome", async () => {
  const f = fixture(); f.device.data.syncRetryVersion = 0;
  expect((await retry(f)).body.code).toBe("sync_agent_unsupported"); expect(f.emit).not.toHaveBeenCalled();
});

test.each([null, { userId: "foreign", deviceId: DEVICE }, { userId: "owner", deviceId: OTHER }])("revoked or rotated device authorization prevents dispatch", async hit => {
  const f = fixture(); f.pairings.findTokenByHash.mockResolvedValue(hit);
  expect((await retry(f)).body.code).toBe("sync_agent_offline"); expect(f.emit).not.toHaveBeenCalled();
});

test.each(["requestId", "deviceId", "sessionId", "reason", "code", "count"])("rejects unbound or malformed ACK %s without retry/fallback", async key => {
  const f = fixture({ ack: async (_event, payload) => ({ ...payload, code: "accepted", count: 3, [key]: key === "count" ? -1 : "wrong" }) });
  expect((await retry(f)).body.code).toBe("sync_retry_invalid_ack"); expect(f.emit).toHaveBeenCalledTimes(1);
});

test.each([NaN, 0.5, 1000000, "3"])("rejects unsafe count %j", async count => {
  const f = fixture({ ack: async (_event, payload) => ({ ...payload, code: "accepted", count }) });
  await expect(f.service.retry("owner", { deviceId: DEVICE, reason: "parse_failed" })).rejects.toMatchObject({ code: "sync_retry_invalid_ack" });
});

test.each(["no_matches", "busy", "expired", "owner_changed", "unsupported", "invalid_request", "local_error"])("non-accepted %s cannot claim queued work", async code => {
  const f = fixture({ ack: async (_event, payload) => ({ ...payload, code, count: 3 }) });
  await expect(f.service.retry("owner", { deviceId: DEVICE, reason: "parse_failed" })).rejects.toMatchObject({ code: "sync_retry_invalid_ack" });
});

test("reconnect and credential revocation during ACK cannot become accepted", async () => {
  const f = fixture(); f.fetchSockets.mockResolvedValueOnce([f.device]).mockResolvedValueOnce([{ ...f.device, id: "replacement-session" }]);
  expect((await retry(f)).body.code).toBe("sync_owner_changed");
  f.fetchSockets.mockResolvedValue([f.device]); f.pairings.findTokenByHash.mockResolvedValueOnce({ userId: "owner", deviceId: DEVICE }).mockResolvedValueOnce(null);
  expect((await retry(f)).body.code).toBe("sync_owner_changed"); expect(f.emit).toHaveBeenCalledTimes(2);
});

test("an expired ACK cannot be accepted even if the real timer has not fired", async () => {
  let now = 1000;
  const f = fixture({ now: () => now, ack: async (_event, payload) => { now = payload.expiresAt; return { ...payload, code: "accepted", count: 3 }; } });
  await expect(f.service.retry("owner", { deviceId: DEVICE, reason: "parse_failed" })).rejects.toMatchObject({ code: "sync_retry_expired" });
});

test("expiry also fences an ACK whose final ownership read completes late", async () => {
  let now = 1000;
  const f = fixture({ now: () => now });
  f.pairings.findTokenByHash.mockImplementationOnce(async () => ({ userId: "owner", deviceId: DEVICE }))
    .mockImplementationOnce(async () => { now += 10001; return { userId: "owner", deviceId: DEVICE }; });
  await expect(f.service.retry("owner", { deviceId: DEVICE, reason: "parse_failed" })).rejects.toMatchObject({ code: "sync_retry_expired" });
});

test.each(["presence", "credential"])("a stalled %s read has a real deadline and releases admission without dispatch", async stage => {
  jest.useFakeTimers();
  try {
    const f = fixture();
    if (stage === "presence") f.fetchSockets.mockReturnValue(new Promise(() => {}));
    else f.pairings.findTokenByHash.mockReturnValue(new Promise(() => {}));
    const outcome = f.service.retry("owner", { deviceId: DEVICE, reason: "parse_failed" }).catch(error => error);
    await jest.advanceTimersByTimeAsync(1001);
    expect(await outcome).toMatchObject({ code: stage === "presence" ? "sync_presence_unavailable" : "sync_auth_unavailable" });
    expect(f.service.pending.size).toBe(0); expect(f.emit).not.toHaveBeenCalled();
  } finally { jest.useRealTimers(); }
});

test("a lost ACK cannot turn into a second dispatch, including after its late success", async () => {
  let resolve;
  const held = new Promise(done => { resolve = done; });
  const f = fixture({ timeoutMs: 20, ack: () => held });
  const result = await retry(f); expect(result.body.code).toBe("sync_retry_unknown");
  const payload = f.emit.mock.calls[0][1]; resolve({ ...payload, code: "accepted", count: 3 });
  await Promise.resolve(); expect(f.emit).toHaveBeenCalledTimes(1); expect(f.fetchSockets).toHaveBeenCalledTimes(1);
});

test("one pending request per owner stays admitted until real timeout, then permits manual recovery", async () => {
  const f = fixture({ timeoutMs: 50, ack: () => new Promise(() => {}) });
  const first = retry(f).then(res => res);
  for (let i = 0; !f.emit.mock.calls.length && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 1));
  expect((await retry(f)).body.code).toBe("sync_retry_pending"); expect(f.fetchSockets).toHaveBeenCalledTimes(1);
  expect((await first).body.code).toBe("sync_retry_unknown");
  f.emit.mockImplementation(async (_event, payload) => ({ ...payload, code: "no_matches", count: 0 }));
  expect((await retry(f)).body).toMatchObject({ code: "no_matches", count: 0 });
});

test("global admission is bounded without discovery", async () => {
  const f = fixture(); for (let i = 0; i < 64; i++) f.service.pending.add(String(i));
  await expect(f.service.retry("owner", { deviceId: DEVICE, reason: "parse_failed" })).rejects.toMatchObject({ code: "sync_retry_capacity" });
  expect(f.fetchSockets).not.toHaveBeenCalled();
});

test("per-owner rate limits bound sequential retry and identity work", async () => {
  const f = fixture(); for (let i = 0; i < 6; i++) expect((await retry(f)).status).toBe(200);
  expect((await retry(f)).status).toBe(429); expect(f.emit).toHaveBeenCalledTimes(6);
  for (let i = 0; i < 20; i++) expect((await request(f.app).post("/v1/me/sync-health/identity").send({ toonHandle: "1-S2-1-42" })).status).toBe(200);
  expect((await request(f.app).post("/v1/me/sync-health/identity").send({ toonHandle: "1-S2-1-42" })).status).toBe(429);
  expect(f.users.updateOne).toHaveBeenCalledTimes(20);
});
