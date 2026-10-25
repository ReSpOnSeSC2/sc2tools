// @ts-nocheck
"use strict";
const express = require("express");
const request = require("supertest");
const { buildOverlayTokensRouter } = require("../src/routes/overlayTokens");
const { buildDevicePairingsRouter } = require("../src/routes/devicePairings");

function harness({ pending = false, source = "clerk", receipts = async () => [] } = {}) {
  const emitted = [];
  const overlayTokens = { rotate: jest.fn(async () => pending ? { pending: true } : { pending: false, token: "new-private" }), rename: jest.fn(async (_user, _token, label) => ({ label })), replacementReceipts: jest.fn(receipts) };
  const io = { to: room => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }) };
  const auth = (req, _res, next) => { req.auth = { userId: "owner", source, tokenHash: "device-hash" }; next(); };
  const app = express(); app.use(express.json());
  app.use("/v1", buildOverlayTokensRouter({ overlayTokens, auth, io }));
  app.use("/v1", buildDevicePairingsRouter({ overlayTokens, auth, pairings: { recordHeartbeat: async () => ({ ok: true }) } }));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: { code: err.code || err.message } }));
  return { app, overlayTokens, emitted };
}

test("only the authenticated response gets the secret; both socket rooms get boolean notices", async () => {
  const { app, overlayTokens, emitted } = harness();
  const result = await request(app).post("/v1/overlay-tokens/old-private/rotate").send({});
  expect(result.status).toBe(200); expect(result.body).toEqual({ pending: false, token: "new-private" });
  expect(result.headers["cache-control"]).toContain("no-store");
  expect(overlayTokens.rotate).toHaveBeenCalledWith("owner", "old-private");
  expect(emitted).toEqual([
    { room: "overlay:old-private", event: "overlay:config", payload: { replacedBy: true } },
    { room: "user:owner", event: "overlay:tokens-changed", payload: { replaced: true } },
  ]);
  expect(JSON.stringify(emitted)).not.toContain("new-private");
});

test("bounded progress returns202; callers cannot choose a destination or another owner", async () => {
  const { app, overlayTokens, emitted } = harness({ pending: true });
  await request(app).post("/v1/overlay-tokens/old/rotate").send({ token: "injected", userId: "other" }).expect(400);
  expect(overlayTokens.rotate).not.toHaveBeenCalled();
  expect((await request(app).post("/v1/overlay-tokens/old/rotate").send({}).expect(202)).body).toEqual({ pending: true });
  expect(emitted).toEqual([]);
});

test("rename uses the authenticated owner and rejects extra fields", async () => {
  const { app, overlayTokens } = harness();
  await request(app).patch("/v1/overlay-tokens/old").send({ label: "Studio" }).expect(200);
  expect(overlayTokens.rename).toHaveBeenCalledWith("owner", "old", "Studio");
  await request(app).patch("/v1/overlay-tokens/old").send({ label: "Studio", enabledWidgets: [] }).expect(400);
});

test("heartbeat receipts require device auth, stay owner scoped and are advisory", async () => {
  const receipts = jest.fn(async () => [{ from: "old", to: "new" }]);
  const device = harness({ source: "device", receipts });
  const result = await request(device.app).post("/v1/devices/heartbeat").send({}).expect(200);
  expect(result.body).toEqual({ ok: true, overlayTokenReplacements: [{ from: "old", to: "new" }] });
  expect(receipts).toHaveBeenCalledWith("owner");
  const web = harness({ receipts });
  await request(web.app).post("/v1/devices/heartbeat").send({}).expect(403);
  expect(receipts).toHaveBeenCalledTimes(1);
  const failed = harness({ source: "device", receipts: async () => { throw new Error("synthetic unavailable"); } });
  expect((await request(failed.app).post("/v1/devices/heartbeat").send({}).expect(200)).body).toEqual({ ok: true });
});


test.each(["overlay_rotation_pending", "overlay_token_resolve_busy", "invalid_overlay_token"])("a raced %s clip credential cannot suppress a later healthy game moment", async code => {
  const { emitOverlayLive } = require("../src/routes/games");
  const recordMoment = jest.fn(async token => { if (token === "raced") throw Object.assign(new Error(code), { code }); });
  await emitOverlayLive({ to: () => ({ emit: jest.fn() }) }, { buildFromGame: async () => ({ result: "win", mmrDelta: 50, gameKey: "game" }) },
    { list: async () => [{ token: "raced" }, { token: "healthy" }] }, "owner", { gameId: "game" }, null,
    { settlePrediction: async () => {}, recordMoment });
  expect(recordMoment.mock.calls.map(([token]) => token)).toEqual(["raced", "healthy"]);
});
