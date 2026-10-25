// @ts-nocheck
"use strict";
const express = require("express"), request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { buildMeRouter } = require("../src/routes/me");
const { GhostConfigService, normalizeSyncedGhostBuildConfig } = require("../src/services/ghostConfig");
const { attachSocketAuth } = require("../src/socket/auth");
const cases = require("../../web/lib/__tests__/fixtures/ghost-config-parity.json");
const target = name => ({ v: 1, name, steps: [{ supply: null, t: 40, name: "Gateway" }] });
const config = (name = "Blink") => ({ v: 2, slots: { PvT: target(name) } });

describe("Ghost config cross-runtime fixture", () => {
  test.each(cases.map(c => [c.name, c]))("%s", (_name, c) => expect(normalizeSyncedGhostBuildConfig(c.input)).toEqual(c.expected));
  test("expanded UTF-8 bytes, including ignored fields, are bounded", () => {
    expect(normalizeSyncedGhostBuildConfig({ ...config(), ignored: "界".repeat(22000) })).toBeNull();
    const circular = {}; circular.self = circular;
    expect(normalizeSyncedGhostBuildConfig(circular)).toBeNull();
  });
});

describe("private atomic Ghost practice assignments", () => {
  let mongo, db, service, app, emits, tokens;
  beforeAll(async () => { mongo = await MongoMemoryServer.create(); db = await connect({ uri: mongo.getUri(), dbName: "ghost_config" }); });
  afterAll(async () => { await db?.close(); await mongo?.stop(); });
  beforeEach(async () => {
    await db.users.deleteMany({});
    await db.users.insertMany([{ userId: "a", clerkUserId: "clerk_a", preferences: { misc: { keep: true } } }, { userId: "b", clerkUserId: "clerk_b", preferences: { ghost: config("Other") } }]);
    emits = [];
    tokens = { list: jest.fn(async owner => [{ token: owner + "-active" }, { token: owner + "-revoked", revokedAt: new Date() }, { token: owner + "-pending", rotationPending: true }]) };
    service = new GhostConfigService({ db, overlayTokens: tokens, io: { to: room => ({ emit: (event, value) => emits.push({ room, event, value }) }) } });
    app = express(); app.use(express.json({ limit: "1mb" }));
    app.use("/v1", buildMeRouter({ ghostConfig: service, users: {}, auth: (req, res, next) => { if (!req.get("authorization")) return res.sendStatus(401); req.auth = { userId: req.get("authorization") }; next(); } }));
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: { code: err.code } }));
  });
  const call = (method, owner = "a") => request(app)[method]("/v1/me/preferences/ghost").set("authorization", owner);
  test("absence, explicit empty, owner isolation, sanitization and private no-store", async () => {
    const absent = await call("get"); expect(absent.body).toBeNull(); expect(absent.headers["cache-control"]).toBe("private, no-store");
    expect((await call("put").send(config())).status).toBe(200);
    expect((await call("get", "b")).body).toEqual({ ...config("Other"), revision: 0 });
    expect((await db.users.findOne({ userId: "a" })).preferences.misc).toEqual({ keep: true });
    expect((await call("put").send({ v: 2, slots: {} })).body).toEqual({ v: 2, slots: {}, revision: 2 });
    expect((await request(app).get("/v1/me/preferences/ghost")).status).toBe(401);
  });
  test("malformed or oversized writes cannot erase prior choices", async () => {
    await service.replace("a", config());
    for (const body of [{ v: 2, slots: { PvR: target("Bad") } }, { ...config(), extra: "界".repeat(22000) }]) expect((await call("put").send(body)).status).toBe(400);
    expect((await call("get")).body).toEqual({ ...config(), revision: 1 });
  });
  test("concurrent different-slot patches retain both devices; clear preserves other slots", async () => {
    const result = await Promise.all([call("patch").send({ matchup: "PvT", target: target("One") }), call("patch").send({ matchup: "PvZ", target: target("Two") })]);
    expect(result.map(row => row.status)).toEqual([200, 200]);
    expect((await service.get("a")).slots).toEqual({ PvT: target("One"), PvZ: target("Two") });
    await call("patch").send({ matchup: "PvT", target: null });
    expect((await service.get("a")).slots).toEqual({ PvZ: target("Two") });
  });
  test("explicit migration fills only empty slots, and cannot broaden the owner", async () => {
    await service.replace("a", config("Account"));
    const migrated = await call("patch").send({ onlyEmpty: true, merge: { v: 2, slots: { PvT: target("Browser"), PvZ: target("Browser Z") } } });
    expect(migrated.body.slots).toEqual({ PvT: target("Account"), PvZ: target("Browser Z") });
    expect((await call("patch").send({ matchup: "PvT", target: null, userId: "b" })).status).toBe(400);
    expect(await service.get("b")).toEqual({ ...config("Other"), revision: 0 });
  });
  test("only active owner tokens receive config; explicit disarm is broadcast", async () => {
    await service.replace("a", { v: 2, slots: {} });
    expect(emits.filter(row => row.event === "overlay:config")).toEqual([{ room: "overlay:a-active", event: "overlay:config", value: { ghost: { v: 2, slots: {}, revision: 1 } } }]);
    expect(emits.find(row => row.event === "ghost:changed")).toEqual({ room: "user:a", event: "ghost:changed", value: true });
  });
  test("a held older notification cannot overwrite a newer saved configuration", async () => {
    let release; tokens.list.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const old = service.replace("a", config("Old"));
    while (!release) await new Promise(resolve => setImmediate(resolve));
    await service.replace("a", config("New"));
    release([{ token: "a-active" }]); await old;
    expect(emits.filter(row => row.event === "overlay:config").map(row => row.value.ghost)).toEqual([{ ...config("New"), revision: 2 }]);
  });
  test("at the64-owner notification cap, a newer same-owner save still retires the held read", async () => {
    for (let i = 0; i < 63; i++) service.notifications.set(`held-${i}`, {});
    let release, started;
    const ready = new Promise(resolve => { started = resolve; });
    const get = service.get.bind(service);
    jest.spyOn(service, "get").mockImplementationOnce(async owner => {
      const snapshot = await get(owner); started(); await new Promise(resolve => { release = resolve; }); return snapshot;
    });
    const older = service.replace("a", config("Older")); await ready;
    expect(service.notifications.size).toBe(64);
    await service.replace("a", config("Newest")); release(); await older;
    expect(emits.filter(row => row.event === "overlay:config").map(row => row.value.ghost)).toEqual([{ ...config("Newest"), revision: 2 }]);
  });
  test.each(["bootstrap", "resync"])("a held %s read keeps its old revision so clients can reject it after a save broadcast", async phase => {
    await service.replace("a", config("Old")); emits.length = 0;
    let connect; const handlers = new Map();
    const socket = { connected: true, disconnected: false, data: { kind: "overlay", overlayToken: "a-active", overlayUserId: "a" }, join() {}, on: (event, callback) => handlers.set(event, callback), emit: (event, value) => emits.push({ room: "socket", event, value }) };
    const socketIo = { use() {}, on: (_event, callback) => { connect = callback; } };
    attachSocketAuth(socketIo, { secretKey: "test", resolveOverlayToken: async () => ({ userId: "a", label: "test" }), validateOverlayToken: async () => true, resolveGhostPrefs: owner => service.get(owner) });
    if (phase === "resync") {
      connect(socket);
      while (!emits.some(row => row.event === "overlay:config")) await new Promise(resolve => setImmediate(resolve));
      emits.length = 0;
    }
    let release, started; const ready = new Promise(resolve => { started = resolve; });
    const get = service.get.bind(service);
    jest.spyOn(service, "get").mockImplementationOnce(async owner => { const old = await get(owner); started(); await new Promise(resolve => { release = resolve; }); return old; });
    let pending;
    if (phase === "bootstrap") connect(socket); else pending = handlers.get("overlay:resync")();
    await ready; await service.replace("a", { v: 2, slots: {} }); release();
    if (pending) await pending; await new Promise(resolve => setImmediate(resolve));
    const configs = emits.filter(row => row.event === "overlay:config");
    expect(configs.map(row => row.value.ghost.revision)).toEqual([2, 1]);
    expect(configs[0].value.ghost.slots).toEqual({});
  });
  test("CAS conflict has three attempts and never overwrites an unseen edit", async () => {
    const update = jest.spyOn(db.users, "updateOne").mockResolvedValue({ matchedCount: 0 });
    await expect(service.patch("a", { matchup: "PvT", target: target("One") })).rejects.toMatchObject({ status: 409, code: "ghost_config_changed" });
    expect(update).toHaveBeenCalledTimes(3); update.mockRestore();
  });
  test("an old Undo/disarm snapshot cannot overwrite a newer same-slot edit", async () => {
    await service.replace("a", config("New device"));
    const response = await call("patch").send({ matchup: "PvT", target: null, expectedTarget: target("Old device") });
    expect(response.status).toBe(409); expect(await service.get("a")).toEqual({ ...config("New device"), revision: 1 });
    expect((await call("patch").send({ matchup: "PvT", target: null, expectedTarget: target("New device") })).status).toBe(200);
  });
});
