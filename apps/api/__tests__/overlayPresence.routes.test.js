// @ts-nocheck
"use strict";
const express = require("express"), request = require("supertest");
const { buildOverlayPresenceRouter } = require("../src/routes/overlayPresence");
function fixture() {
  const tokenBelongsToUser = jest.fn(async (owner, token) => owner === "owner" && token === "synthetic-token");
  const resolve = jest.fn(async token => token === "synthetic-token" ? { userId: "owner" } : null);
  const fetchSockets = jest.fn(async () => [{ id: "secret-socket", data: { kind: "overlay", overlayToken: "synthetic-token", overlayUserId: "owner", overlayPresence: { surface: "widget", widget: "scouting" }, overlayConnectedAt: Date.now() - 1000 } }]);
  const io = { in: jest.fn(() => ({ fetchSockets })) }, app = express();
  app.use("/v1", buildOverlayPresenceRouter({ io, overlayTokens: { tokenBelongsToUser, resolve }, auth: (req, res, next) => { const userId = req.get("x-owner"); if (!userId) return res.sendStatus(401); req.auth = { userId, source: "clerk" }; next(); } }));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: { code: error.code || "internal_error" } }));
  return { app, io, fetchSockets, tokenBelongsToUser, resolve };
}
test("the owner receives private aggregate counts and the five-second limiter bounds repeat scans", async () => {
  const { app, fetchSockets } = fixture();
  const first = await request(app).get("/v1/overlay-tokens/synthetic-token/presence").set("x-owner", "owner");
  expect(first.status).toBe(200); expect(first.headers["cache-control"]).toBe("private, no-store");
  expect(first.body.widgets.scouting.count).toBe(1); expect(JSON.stringify(first.body)).not.toMatch(/secret-socket|synthetic-token/);
  expect((await request(app).get("/v1/overlay-tokens/synthetic-token/presence").set("x-owner", "owner")).status).toBe(429);
  expect(fetchSockets).toHaveBeenCalledTimes(2);
});
test("foreign users cannot read or spend the owner's admission budget", async () => {
  const { app, fetchSockets } = fixture();
  expect((await request(app).get("/v1/overlay-tokens/synthetic-token/presence")).status).toBe(401);
  expect((await request(app).get("/v1/overlay-tokens/synthetic-token/presence").set("x-owner", "another-owner")).status).toBe(404);
  expect(fetchSockets).not.toHaveBeenCalled();
  expect((await request(app).get("/v1/overlay-tokens/synthetic-token/presence").set("x-owner", "owner")).status).toBe(200);
});
test("Dock credentials return only counts and share admission with the owner endpoint", async () => {
  const { app, fetchSockets } = fixture();
  const result = await request(app).get("/v1/multichat/synthetic-token/presence");
  expect(result.status).toBe(200); expect(Object.keys(result.body).sort()).toEqual(["sampledAt", "surfaces", "totalSources"]);
  expect(result.body.surfaces.widget).toBe(1);
  expect((await request(app).get("/v1/overlay-tokens/synthetic-token/presence").set("x-owner", "owner")).status).toBe(429);
  expect(fetchSockets).toHaveBeenCalledTimes(2);
});
test("revoked Dock tokens fail before any room is inspected", async () => {
  const { app, fetchSockets } = fixture();
  expect((await request(app).get("/v1/multichat/revoked/presence")).status).toBe(401); expect(fetchSockets).not.toHaveBeenCalled();
});
