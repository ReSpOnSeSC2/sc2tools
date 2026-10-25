// @ts-nocheck
"use strict";
const express = require("express"), request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");
const { OverlayTokensService } = require("../src/services/overlayTokens");
const { buildOverlayTokensRouter } = require("../src/routes/overlayTokens");
const { validateOverlayProfile } = require("../src/validation/overlayProfile");
const profile = patch => ({ v: 1, theme: {}, widgetOptions: {}, ...patch });
  let mongo, client, collection, service, app, emit;
  beforeAll(async () => { mongo = await MongoMemoryServer.create(); client = await MongoClient.connect(mongo.getUri()); collection = client.db("overlay-profile").collection("tokens"); });
  afterAll(async () => { await client?.close(); await mongo?.stop(); });
  beforeEach(async () => {
    await collection.deleteMany({}); service = new OverlayTokensService({ overlayTokens: collection }); emit = jest.fn();
    app = express(); app.use(express.json());
    app.use("/v1", buildOverlayTokensRouter({ overlayTokens: service, io: { to: jest.fn(() => ({ emit })) }, auth: (req, res, next) => { const owner = req.get("x-fixture-owner"); if (!owner) return res.sendStatus(401); req.auth = { userId: owner, source: "clerk" }; next(); } }));
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: { code: err.code || err.message } }));
    await collection.insertOne({ userId: "owner", token: "synthetic-token", label: "Synthetic", revokedAt: null, enabledWidgets: ["session"] });
  });
  const put = (body, owner = "owner") => request(app).put("/v1/overlay-tokens/synthetic-token/profile").set("x-fixture-owner", owner).send(body);
describe("owned live overlay profiles", () => {
  test("legacy reads supply canonical defaults without writing, then an explicit save publishes only profile fields", async () => {
    expect((await service.list("owner"))[0]).toMatchObject({ profile: profile(), profileRevision: 0 });
    expect(await collection.findOne({ userId: "owner" })).not.toHaveProperty("profile");
    const response = await put({ profile: profile({ theme: { accent: "#ABc", opacity: 2, scale: 1, radius: "rounded", font: "default" }, widgetOptions: { "match-result": { durationSec: 60 }, streak: { durationSec: null } } }), expectedRevision: 0 });
    expect(response.status).toBe(200); expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.body).toEqual({ profile: profile({ theme: { accent: "#abc", opacity: 1 }, widgetOptions: { "match-result": { durationSec: 60 } } }), profileRevision: 1 });
    expect(emit).toHaveBeenCalledWith("overlay:config", response.body);
    expect(await collection.findOne({ token: "synthetic-token" })).toMatchObject({ userId: "owner", enabledWidgets: ["session"], ...response.body });
    expect(await service.resolve("synthetic-token")).toMatchObject(response.body);
  });
  test.each([
    profile({ theme: { accent: "red" } }), profile({ theme: { accent: "#fff;background:url(x)" } }), profile({ theme: { font: "external-font" } }),
    profile({ theme: { opacity: "0.5" } }), profile({ theme: { scale: 2 } }), profile({ theme: { css: "color:red" } }),
    profile({ widgetOptions: { constructor: { durationSec: 15 } } }), profile({ widgetOptions: { session: { durationSec: 15 } } }),
    profile({ widgetOptions: { "match-result": { durationSec: 37 } } }), profile({ widgetOptions: { "match-result": { durationSec: 15, style: "extra" } } }),
    profile({ v: 2 }), profile({ extra: "field" }),
  ])("rejects hostile/unknown profile values before writing or broadcasting: %j", async invalid => {
    expect((await put({ profile: invalid, expectedRevision: 0 })).status).toBe(400);
    expect(await collection.findOne({ token: "synthetic-token" })).not.toHaveProperty("profile"); expect(emit).not.toHaveBeenCalled();
  });
  test("prototype keys and nonfinite values fail the direct validator too", () => {
    expect(() => validateOverlayProfile(JSON.parse('{"v":1,"theme":{"__proto__":{}},"widgetOptions":{}}'))).toThrow();
    for (const opacity of [Infinity, -Infinity, NaN]) expect(() => validateOverlayProfile(profile({ theme: { opacity } }))).toThrow();
  });
  test("CAS rejects stale/malformed revisions, and another owner's token cannot be changed", async () => {
    expect((await put({ profile: profile({ theme: { accent: "#fff" } }), expectedRevision: 0 })).status).toBe(200);
    emit.mockClear();
    expect((await put({ profile: profile(), expectedRevision: 0 })).status).toBe(409);
    for (const expectedRevision of [undefined, -1, 0.5, "1"]) expect((await put({ profile: profile(), expectedRevision })).status).toBe(400);
    expect((await put({ profile: profile(), expectedRevision: 1 }, "other-owner")).status).toBe(404);
    await service.revoke("owner", "synthetic-token"); expect((await put({ profile: profile(), expectedRevision: 1 })).status).toBe(404);
    expect((await request(app).put("/v1/overlay-tokens/synthetic-token/profile").send({ profile: profile(), expectedRevision: 1 })).status).toBe(401);
    expect(emit).not.toHaveBeenCalled();
  });
  test("widget CAS and profile CAS do not replace one another's fields", async () => {
    await service.setProfile("owner", "synthetic-token", profile({ theme: { accent: "#fff" } }), 0);
    await service.setEnabledWidgets("owner", "synthetic-token", ["opponent"], ["session"]);
    await service.setProfile("owner", "synthetic-token", profile({ widgetOptions: { "match-result": { durationSec: 45 } } }), 1);
    expect(await collection.findOne({ token: "synthetic-token" })).toMatchObject({ enabledWidgets: ["opponent"], profileRevision: 2, profile: profile({ widgetOptions: { "match-result": { durationSec: 45 } } }) });
  });
  test("a pre-save admitted token resolve asks for a transient retry without returning an old profile", async () => {
    const original = collection.findOne.bind(collection); let release, captured;
    const ready = new Promise(resolve => { captured = resolve; });
    jest.spyOn(collection, "findOne").mockImplementationOnce(async query => { const old = await original(query); captured(); await new Promise(resolve => { release = resolve; }); return old; });
    const pending = service.resolve("synthetic-token"); await ready;
    await service.setProfile("owner", "synthetic-token", profile({ theme: { accent: "#fff" } }), 0); release();
    await expect(pending).rejects.toMatchObject({ code: "overlay_token_resolve_busy", status: 503 }); expect(await service.resolve("synthetic-token")).toMatchObject({ profileRevision: 1, profile: profile({ theme: { accent: "#fff" } }) });
    jest.restoreAllMocks();
  });
});
