// @ts-nocheck
"use strict";

/**
 * Coverage for the cloud's Live Game Bridge endpoints + broker.
 *
 *   1. ``LiveGameBroker.publish/subscribe`` — in-process pub/sub fans
 *      out to every subscriber, replays the latest snapshot on
 *      subscribe, and ages out stale snapshots after 30 minutes.
 *   2. ``POST /v1/agent/live`` — accepts well-formed envelopes,
 *      rejects malformed bodies, and routes through the broker.
 *   3. ``GET /v1/me/live`` (SSE) — heartbeat + live envelope writes
 *      reach the subscribed client; multiple users don't cross
 *      streams.
 */

const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const pino = require("pino");

const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");
const { LiveGameBroker } = require("../src/services/liveGameBroker");

const TEST_TOKEN = "user-live";
const TEST_CLERK_USER_ID = "clerk_user_live";
const SECOND_TOKEN = "user-live-second";
const SECOND_CLERK_USER_ID = "clerk_user_live_second";

jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(async (token) => {
    if (token === "user-live") return { sub: "clerk_user_live" };
    if (token === "user-live-second") return { sub: "clerk_user_live_second" };
    throw new Error("invalid");
  }),
}));

describe("LiveGameBroker (in-process pub/sub)", () => {
  test("publish fans out to every subscriber for the user", () => {
    const broker = new LiveGameBroker();
    const a = [];
    const b = [];
    broker.subscribe("user-1", (e) => a.push(e));
    broker.subscribe("user-1", (e) => b.push(e));
    broker.publish("user-1", { phase: "match_loading" });
    expect(a).toEqual([{ phase: "match_loading" }]);
    expect(b).toEqual([{ phase: "match_loading" }]);
  });

  test("publish does not cross streams between users", () => {
    const broker = new LiveGameBroker();
    const aliceEvents = [];
    const bobEvents = [];
    broker.subscribe("alice", (e) => aliceEvents.push(e));
    broker.subscribe("bob", (e) => bobEvents.push(e));
    broker.publish("alice", { phase: "match_started" });
    expect(aliceEvents).toHaveLength(1);
    expect(bobEvents).toHaveLength(0);
  });

  test("subscribe replays the latest cached envelope when it's fresh", () => {
    const broker = new LiveGameBroker();
    broker.publish("u", { phase: "match_in_progress", displayTime: 12 });
    const seen = [];
    broker.subscribe("u", (e) => seen.push(e));
    expect(seen).toHaveLength(1);
    expect(seen[0].displayTime).toBe(12);
  });

  test("unsubscribe removes the listener and prunes empty buckets", () => {
    const broker = new LiveGameBroker();
    const seen = [];
    const unsub = broker.subscribe("u", (e) => seen.push(e));
    broker.publish("u", { phase: "match_loading" });
    unsub();
    broker.publish("u", { phase: "match_started" });
    expect(seen).toHaveLength(1);
    expect(broker.subscriberCount("u")).toBe(0);
  });

  test("a throwing subscriber does not stop other subscribers from firing", () => {
    const broker = new LiveGameBroker();
    const seen = [];
    broker.subscribe("u", () => {
      throw new Error("oops");
    });
    broker.subscribe("u", (e) => seen.push(e));
    broker.publish("u", { phase: "x" });
    expect(seen).toHaveLength(1);
  });

  test("latest returns null after the snapshot ages out", () => {
    const broker = new LiveGameBroker();
    broker.publish("u", { phase: "x" });
    expect(broker.latest("u")).toEqual({ phase: "x" });
    // Forcibly age the snapshot.
    broker._latest.set("u", { envelope: { phase: "x" }, ts: 0 });
    expect(broker.latest("u")).toBeNull();
  });
});

describe("POST /v1/agent/live + GET /v1/me/live", () => {
  let mongo;
  let db;
  let app;

  const config = {
    port: 0,
    nodeEnv: "test",
    logLevel: "silent",
    mongoUri: "",
    mongoDb: "sc2tools_test_live",
    clerkSecretKey: "sk_test",
    clerkJwtIssuer: undefined,
    clerkJwtAudience: undefined,
    clerkWebhookSecret: "whsec_xxxx",
    serverPepper: Buffer.alloc(32, 4),
    corsAllowedOrigins: [],
    rateLimitPerMinute: 5000,
    agentReleaseAdminToken: "admin",
    pythonExe: null,
    pythonAnalyzerDir: "/tmp/__nonexistent__",
    adminUserIds: [],
  };

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({
      uri: mongo.getUri(),
      dbName: "sc2tools_test_live",
    });
    const built = buildApp({
      db,
      logger: pino({ level: "silent" }),
      config,
    });
    app = built.app;
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  function withAuth(req, token = TEST_TOKEN) {
    return req.set("authorization", `Bearer ${token}`);
  }

  test("POST /v1/agent/live accepts a well-formed envelope", async () => {
    const res = await withAuth(
      request(app).post("/v1/agent/live").send({
        type: "liveGameState",
        phase: "match_loading",
        gameKey: "Opp|Streamer|1717000000000",
      }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  test("POST /v1/agent/live rejects non-object body", async () => {
    const res = await withAuth(
      request(app)
        .post("/v1/agent/live")
        .set("content-type", "application/json")
        .send([{ phase: "match_loading" }]),
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_envelope");
  });

  test("POST /v1/agent/live requires auth", async () => {
    const res = await request(app)
      .post("/v1/agent/live")
      .send({ phase: "match_loading" });
    expect(res.status).toBe(401);
  });

  test(
    "GET /v1/me/live receives published envelopes via SSE",
    async () => {
      const chunks = [];
      const req = request(app)
        .get("/v1/me/live")
        .set("authorization", `Bearer ${TEST_TOKEN}`)
        .buffer(false)
        .parse((res, cb) => {
          res.on("data", (chunk) => {
            chunks.push(chunk.toString("utf8"));
            // Once we've seen the first real envelope, close the stream.
            if (chunks.join("").includes('"phase":"match_started"')) {
              res.destroy();
              cb(null, chunks.join(""));
            }
          });
          res.on("end", () => cb(null, chunks.join("")));
          res.on("error", () => cb(null, chunks.join("")));
        });

      // Dispatch an envelope a tick after we kick off the SSE request.
      // Supertest's .end is the resolution point; we publish from a
      // setTimeout because the subscribe happens once the route's
      // handler runs.
      const reqPromise = req.then(
        (r) => r,
        (err) => err,
      );
      // Wait briefly for the route to register the subscription.
      await new Promise((r) => setTimeout(r, 50));
      await withAuth(
        request(app).post("/v1/agent/live").send({
          type: "liveGameState",
          phase: "match_started",
          gameKey: "Opp|Streamer|1717000000000",
          displayTime: 1.5,
        }),
      );
      // Wait for the SSE stream to close itself after seeing the
      // envelope (or up to 1 s).
      const res = await Promise.race([
        reqPromise,
        new Promise((r) => setTimeout(() => r({ text: chunks.join("") }), 2000)),
      ]);
      const text = (res && res.text) || chunks.join("");
      expect(text).toContain('"phase":"match_started"');
    },
    8000,
  );

  test(
    "GET /v1/me/live keeps users isolated",
    async () => {
      // Subscribe alice, publish to bob — alice must NOT see bob's
      // envelope.
      const aliceChunks = [];
      const aliceReq = request(app)
        .get("/v1/me/live")
        .set("authorization", `Bearer ${TEST_TOKEN}`)
        .buffer(false)
        .parse((res, cb) => {
          res.on("data", (c) => aliceChunks.push(c.toString("utf8")));
          res.on("end", () => cb(null, aliceChunks.join("")));
        });

      const aliceProm = aliceReq.then(
        (r) => r,
        (err) => err,
      );
      await new Promise((r) => setTimeout(r, 50));

      // Bob publishes an envelope.
      await withAuth(
        request(app).post("/v1/agent/live").send({
          type: "liveGameState",
          phase: "bob_match",
          gameKey: "Bob|...",
        }),
        SECOND_TOKEN,
      );

      // Wait briefly to give SSE a chance to (incorrectly) leak.
      await new Promise((r) => setTimeout(r, 200));
      // Tear down alice's stream.
      const aliceText = aliceChunks.join("");
      expect(aliceText).not.toContain("bob_match");

      // Drain alice's request — supertest needs the response to end.
      // We can't easily abort, but the test has already validated.
      // Resolve by destroying the underlying socket: supertest exposes
      // `req` on the chain; we just await the timeout race.
      await Promise.race([
        aliceProm,
        new Promise((r) => setTimeout(r, 500)),
      ]);
    },
    8000,
  );
});
