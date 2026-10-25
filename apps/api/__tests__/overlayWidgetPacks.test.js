// @ts-nocheck
"use strict";
const express = require("express"), request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");
const { OverlayTokensService, DEFAULT_WIDGETS, KNOWN_WIDGETS } = require("../src/services/overlayTokens");
const { buildOverlayTokensRouter } = require("../src/routes/overlayTokens");

describe("owned widget pack selection", () => {
  let mongo, client, collection, service, emit, app;
  beforeAll(async () => { mongo = await MongoMemoryServer.create(); client = await MongoClient.connect(mongo.getUri()); collection = client.db("widget-packs").collection("overlayTokens"); });
  afterAll(async () => { await client?.close(); await mongo?.stop(); });
  beforeEach(async () => {
    await collection.deleteMany({}); service = new OverlayTokensService({ overlayTokens: collection }); emit = jest.fn();
    app = express(); app.use(express.json());
    app.use("/v1", buildOverlayTokensRouter({ overlayTokens: service, io: { to: jest.fn(() => ({ emit })) }, auth: (req, res, next) => { const owner = req.get("x-fixture-owner"); if (!owner) return res.sendStatus(401); req.auth = { userId: owner, source: "clerk" }; next(); } }));
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: { code: err.code || err.message } }));
    await collection.insertOne({ token: "synthetic-token", userId: "owner", revokedAt: null, enabledWidgets: ["session"] });
  });
  const put = (owner, body) => request(app).put("/v1/overlay-tokens/synthetic-token/widgets").set("x-fixture-owner", owner).send(body);

  test("atomically changes the selection and emits only the saved allowlisted config", async () => {
    const res = await put("owner", { enabled: ["session", "opponent", "match-result"], expectedEnabled: ["session"] });
    expect(res.status).toBe(200); expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.body.enabledWidgets).toEqual(["match-result", "opponent", "session"]);
    expect((await collection.findOne({ token: "synthetic-token" })).enabledWidgets).toEqual(res.body.enabledWidgets);
    expect(emit).toHaveBeenCalledWith("overlay:config", res.body);
    expect((await service.resolve("synthetic-token")).enabledWidgets).toEqual(res.body.enabledWidgets);
  });
  test.each([null, {}, ["session", "session"], ["not-a-widget"], ["__proto__"], [1], Array(KNOWN_WIDGETS.length + 1).fill("session")])("rejects malformed selection %j before writing or emitting", async enabled => {
    expect((await put("owner", { enabled })).status).toBe(400);
    expect((await collection.findOne({ token: "synthetic-token" })).enabledWidgets).toEqual(["session"]); expect(emit).not.toHaveBeenCalled();
  });
  test("unknown, revoked and foreign tokens cannot be changed or broadcast", async () => {
    expect((await put("other-owner", { enabled: ["opponent"] })).status).toBe(404);
    await service.revoke("owner", "synthetic-token");
    expect((await put("owner", { enabled: ["opponent"] })).status).toBe(404);
    expect((await request(app).put("/v1/overlay-tokens/synthetic-token/widgets").send({ enabled: [] })).status).toBe(401); expect(emit).not.toHaveBeenCalled();
  });
  test("stale previews cannot remove another tab's changes", async () => {
    await service.setWidgetEnabled("owner", "synthetic-token", "randomizer", true);
    const res = await put("owner", { enabled: ["session", "opponent"], expectedEnabled: ["session"] });
    expect(res.status).toBe(409); expect(res.body.error.code).toBe("widget_selection_changed");
    expect((await collection.findOne({ token: "synthetic-token" })).enabledWidgets).toEqual(["session", "randomizer"]); expect(emit).not.toHaveBeenCalled();
  });
  test("legacy missing selections accept the defaults displayed by the list without a migration", async () => {
    await collection.updateOne({ token: "synthetic-token" }, { $unset: { enabledWidgets: "" } });
    expect((await put("owner", { enabled: [...DEFAULT_WIDGETS, "randomizer"], expectedEnabled: [...DEFAULT_WIDGETS].reverse() })).status).toBe(200);
  });
  test("an unchanged empty selection can enable a starter pack", async () => {
    await collection.updateOne({ token: "synthetic-token" }, { $set: { enabledWidgets: [] } });
    const res = await put("owner", { enabled: ["session", "opponent"], expectedEnabled: [] });
    expect(res.status).toBe(200); expect(res.body.enabledWidgets).toEqual(["opponent", "session"]);
  });
  test("an admitted resolve cannot return or repopulate its previous selection after a pack save", async () => {
    const original = collection.findOne.bind(collection); let release, captured;
    const ready = new Promise(resolve => { captured = resolve; });
    jest.spyOn(collection, "findOne").mockImplementationOnce(async query => { const stale = await original(query); captured(); await new Promise(resolve => { release = resolve; }); return stale; });
    const pending = service.resolve("synthetic-token"); await ready;
    await service.setEnabledWidgets("owner", "synthetic-token", ["opponent"], ["session"]); release();
    expect(await pending).toBeNull(); expect((await service.resolve("synthetic-token")).enabledWidgets).toEqual(["opponent"]);
    jest.restoreAllMocks();
  });
});
