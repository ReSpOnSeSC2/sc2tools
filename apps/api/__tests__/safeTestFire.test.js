// @ts-nocheck
"use strict";
const request = require("supertest");
const pino = require("pino");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");
jest.mock("@clerk/backend", () => ({ verifyToken: jest.fn(async (token) => { if (token === "owner") return { sub: "clerk_owner" }; throw new Error("invalid"); }) }));

describe("safe test-fire real HTTP/Mongo boundary", () => {
  let mongo, db, app, services, token;
  const emitted = [];
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create(); db = await connect({ uri: mongo.getUri(), dbName: "safe_test_fire" });
    const io = { to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }), in: () => ({ fetchSockets: async () => [] }) };
    ({ app, services } = buildApp({ db, io, logger: pino({ level: "silent" }), config: { nodeEnv: "test", clerkSecretKey: "fixture", serverPepper: Buffer.alloc(32, 7), corsAllowedOrigins: [], rateLimitPerMinute: 10000, pythonExe: null, pythonAnalyzerDir: "C:/__missing__", adminUserIds: [] } }));
    await db.users.insertOne({ userId: "u_owner", clerkUserId: "clerk_owner", createdAt: new Date(), lastSeenAt: new Date() });
    token = (await services.overlayTokens.create("u_owner", "fixture")).token;
  });
  beforeEach(() => { services.liveGameBroker.publish("u_owner", { phase: "menu" }); emitted.length = 0; });
  afterAll(async () => { await db?.close(); await mongo?.stop(); });
  const post = (path, body) => request(app).post(path).set("authorization", "Bearer owner").send(body);

  test.each(["match_loading", "match_started", "match_in_progress"])("blocks sample broadcasts during %s unless explicitly forced", async (phase) => {
    services.liveGameBroker.publish("u_owner", { phase, gameKey: `fixture-${phase}` });
    const blocked = await post("/v1/overlay-events/test", { token, widget: "opponent" });
    expect(blocked.status).toBe(409); expect(blocked.body.error.code).toBe("live_match");
    expect(emitted.filter((row) => row.event === "overlay:live")).toEqual([]);
    expect((await post("/v1/overlay-events/test", { token, widget: "opponent", force: "true" })).status).toBe(409);
    expect((await post("/v1/overlay-events/test", { token, widget: "opponent", force: true })).status).toBe(202);
    const events = emitted.filter((row) => row.event === "overlay:live");
    expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ room: `overlay:${token}`, payload: { isTest: true, testWidget: "opponent" } });
    expect(services.liveGameBroker.latest("u_owner").phase).toBe(phase);
    expect(await db.games.countDocuments({ userId: "u_owner" })).toBe(0);
  });
  test("completed games need no override; paired sample channels share a nonce", async () => {
    services.liveGameBroker.publish("u_owner", { phase: "match_ended", gameKey: "finished" });
    expect((await post("/v1/overlay-events/test", { token, widget: "session" })).status).toBe(202);
    const live = emitted.find((row) => row.event === "overlay:live"), session = emitted.find((row) => row.event === "overlay:session");
    expect(live.payload.testNonce).toEqual(expect.any(String)); expect(session.payload.testNonce).toBe(live.payload.testNonce); expect(session.payload.isTest).toBe(true);
  });
  test("force cannot bypass ownership and Stop emits an explicit test-only scope", async () => {
    expect((await post("/v1/overlay-events/test", { token: "foreign", force: true })).status).toBe(404);
    expect((await post("/v1/overlay-events/test/cancel", { token: "foreign" })).status).toBe(404);
    expect((await post("/v1/overlay-events/test/cancel", { token, widget: "opponent" })).status).toBe(202);
    expect(emitted.filter((row) => row.event === "overlay:clear")).toEqual([{ room: `overlay:${token}`, event: "overlay:clear", payload: { scope: "test", widget: "opponent" } }]);
  });
});
