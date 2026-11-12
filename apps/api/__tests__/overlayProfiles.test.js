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
const placement = { anchor: "bottom", xPct: 42, yPct: 7, scale: 1.25, zIndex: 3 };
describe("owned live overlay layouts", () => {
  test("keeps each orientation in the same owner CAS and clears only the requested layout", async () => {
    const initial = profile({ layout: { opponent: placement }, layoutVertical: { scouting: { ...placement, xPct: 70 } },
      theme: { accent: "#abc" }, widgetOptions: { "match-result": { durationSec: 45 } }, credit: false });
    await put({ profile: initial, expectedRevision: 0 }).expect(200, { profile: initial, profileRevision: 1 });
    expect(emit).toHaveBeenCalledWith("overlay:config", { profile: initial, profileRevision: 1 });
    await put({ profile: { ...initial, layout: {} }, expectedRevision: 0 }).expect(409);
    await put({ profile: { ...initial, layout: {} }, expectedRevision: 1 }, "other-owner").expect(404);
    const verticalOnly = { ...initial }; delete verticalOnly.layout;
    await put({ profile: { ...initial, layout: {} }, expectedRevision: 1 }).expect(200, { profile: verticalOnly, profileRevision: 2 });
    expect((await service.resolve("synthetic-token")).profile).toEqual(verticalOnly);
  });
  test.each([
    { ghost: placement }, { opponent: { ...placement, xPct: 101 } },
    { opponent: { ...placement, yPct: "5%" } }, { opponent: { ...placement, anchor: "left" } },
    { opponent: { ...placement, scale: 0 } }, { opponent: { ...placement, zIndex: 50 } },
    { opponent: { ...placement, zIndex: 1.5 } }, { opponent: { ...placement, style: "display:none" } },
    JSON.parse('{"__proto__":{"xPct":1}}'),
  ])("rejects hostile layout entries before saving: %j", async layout => {
    await put({ profile: profile({ layout }), expectedRevision: 0 }).expect(400);
    expect(emit).not.toHaveBeenCalled();
  });
});

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
    profile({ v: 2 }), profile({ extra: "field" }), profile({ credit: "false" }), profile({ ghostVoice: 1 }),
  ])("rejects hostile/unknown profile values before writing or broadcasting: %j", async invalid => {
    expect((await put({ profile: invalid, expectedRevision: 0 })).status).toBe(400);
    expect(await collection.findOne({ token: "synthetic-token" })).not.toHaveProperty("profile"); expect(emit).not.toHaveBeenCalled();
  });
  test("publishes and resolves the saved credit per token with legacy defaults", async () => {
    await collection.insertOne({ userId: "owner", token: "other-synthetic-token", label: "Second synthetic source", revokedAt: null });
    const flags = profile({ credit: false, ghostVoice: true });
    await put({ profile: flags, expectedRevision: 0 }).expect(200, { profile: flags, profileRevision: 1 });
    expect((await service.list("owner")).find(row => row.token === "synthetic-token").profile).toEqual(flags);
    expect((await service.resolve("synthetic-token")).profile).toEqual(flags);
    expect(emit).toHaveBeenNthCalledWith(1, "overlay:config", { profile: flags, profileRevision: 1 });

    const visible = { ...flags, credit: true };
    await put({ profile: visible, expectedRevision: 1 }).expect(200, { profile: visible, profileRevision: 2 });
    expect(await service.resolve("synthetic-token")).toMatchObject({ profile: visible, profileRevision: 2 });
    expect(emit).toHaveBeenNthCalledWith(2, "overlay:config", { profile: visible, profileRevision: 2 });
    expect(await service.resolve("other-synthetic-token")).toMatchObject({ profile: profile(), profileRevision: 0 });
    expect(await collection.findOne({ token: "other-synthetic-token" })).not.toHaveProperty("profile");
  });

  test("resync reads the current owned profile despite a stale token cache", async () => {
    const token = "synthetic-token";
    await expect(service.resolve(token)).resolves.toMatchObject({ profile: profile(), profileRevision: 0 });
    const remote = new OverlayTokensService({ overlayTokens: collection });
    const hidden = profile({ credit: false });
    await remote.setProfile("owner", token, hidden, 0);

    await expect(service.resolve(token)).resolves.toMatchObject({ profile: profile(), profileRevision: 0 });
    await expect(service.readOwnedProfile("owner", token)).resolves.toEqual({ profile: hidden, profileRevision: 1 });
    await expect(service.readOwnedProfile("other-owner", token)).resolves.toBeNull();
    await collection.updateOne({ token }, { $set: { _rotationPending: true } });
    await expect(service.readOwnedProfile("owner", token)).resolves.toBeNull();
    await collection.updateOne({ token }, { $set: { revokedAt: new Date() }, $unset: { _rotationPending: "" } });
    await expect(service.readOwnedProfile("owner", token)).resolves.toBeNull();
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

describe("owned overlay credit QR", () => {
  test.each(["1", null])("rejects non-boolean credit QR %j before persisting or broadcasting", async creditQr => {
    await put({ profile: profile({ creditQr }), expectedRevision: 0 }).expect(400);
    expect(await collection.findOne({ token: "synthetic-token" })).not.toHaveProperty("profile");
    expect(emit).not.toHaveBeenCalled();
  });

  test("saves QR independently of credit and preserves both choices in owned reads", async () => {
    const enabled = profile({ credit: false, creditQr: true });
    await put({ profile: enabled, expectedRevision: 0 }, "other-owner").expect(404);
    await put({ profile: enabled, expectedRevision: 0 }).expect(200, { profile: enabled, profileRevision: 1 });
    const disabled = { ...enabled, creditQr: false };
    await put({ profile: disabled, expectedRevision: 0 }).expect(409);
    expect(await service.readOwnedProfile("owner", "synthetic-token")).toEqual({ profile: enabled, profileRevision: 1 });
    await put({ profile: disabled, expectedRevision: 1 }).expect(200, { profile: disabled, profileRevision: 2 });
    expect(emit).toHaveBeenLastCalledWith("overlay:config", { profile: disabled, profileRevision: 2 });
    expect(await service.resolve("synthetic-token")).toMatchObject({ profile: disabled, profileRevision: 2 });
  });
});
