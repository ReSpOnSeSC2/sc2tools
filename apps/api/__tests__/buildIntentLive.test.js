// @ts-nocheck
/* eslint-disable max-lines-per-function */
"use strict";

/**
 * Build check-in live records: registration from POST /v1/agent/live, the
 * OBS randomizer hold, and PUT/GET /v1/build-intents/live/:gameKey
 * (register / declare / undeclare / release / postgame). Real Mongo and
 * LiveGameBroker, a header-driven auth stub and a controllable clock.
 */

const express = require("express");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { LiveGameBroker } = require("../src/services/liveGameBroker");
const { BuildIntentsService } = require("../src/services/buildIntents");
const { buildBuildIntentsRouter } = require("../src/routes/buildIntents");
const { buildAgentLiveRouter } = require("../src/routes/agentLive");
const {
  DAY_MS,
  HOUR_MS,
  makeFakeIo,
  randomizerPrefs,
  setPrefs,
  addOverlayToken,
  addCustomBuild,
} = require("./helpers/buildIntentHarness");

const KEY_MS = 1_790_000_000_000;
const GAME_KEY = `[oM]Cure#123|Streamer#456|${KEY_MS}`;
const PHOENIX_KEY = "pvz-2-stargate-phoenix";

function envelope(over = {}) {
  return {
    type: "liveGameState",
    phase: "match_loading",
    gameKey: GAME_KEY,
    displayTime: 0,
    isReplay: false,
    user: { name: "Streamer", race: "Protoss" },
    opponent: { name: "[oM]Cure", race: "Zerg" },
    ...over,
  };
}


describe("build check-in live records", () => {
  let mongo;
  let db;
  let io;
  let broker;
  let service;
  let app;
  let nowMs;
  let userCounter = 0;
  /** Fire-and-forget registrations started by POST /v1/agent/live. */
  let pending = [];

  async function settle() {
    while (pending.length > 0) await Promise.allSettled(pending.splice(0));
  }

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "build_intent_live_test" });
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  beforeEach(() => {
    nowMs = KEY_MS + 5_000;
    io = makeFakeIo();
    broker = new LiveGameBroker();
    service = new BuildIntentsService(db, { io, liveGameBroker: broker, now: () => nowMs });
    pending = [];
    const register = service.registerFromEnvelope.bind(service);
    service.registerFromEnvelope = (userId, env) => {
      const promise = register(userId, env);
      pending.push(promise);
      return promise;
    };
    const auth = (req, _res, next) => {
      req.auth = {
        userId: String(req.headers["x-user"]),
        source: req.headers["x-source"] === "device" ? "device" : "clerk",
      };
      next();
    };
    app = express();
    app.use(express.json());
    app.use("/v1", buildAgentLiveRouter({ broker, auth, buildIntents: service }));
    app.use("/v1", buildBuildIntentsRouter({ buildIntents: service, auth }));
  });

  async function newUser({ hold = false } = {}) {
    userCounter += 1;
    const userId = `live-user-${userCounter}`;
    await db.users.insertOne({ userId, clerkUserId: `clerk_live_${userCounter}`, preferences: {} });
    if (hold) {
      await setPrefs(db, userId, { randomizer: randomizerPrefs("PvZ", [PHOENIX_KEY, "pvz-robo-opener"]) });
      await addOverlayToken(db, userId, `tok-${userCounter}`, ["opponent", "randomizer"]);
    }
    return userId;
  }

  function postEnvelope(userId, env) {
    return request(app)
      .post("/v1/agent/live")
      .set("x-user", userId)
      .set("x-source", "device")
      .send(env)
      .expect(200);
  }

  function putLive(userId, body, { gameKey = GAME_KEY, source = "device" } = {}) {
    return request(app)
      .put(`/v1/build-intents/live/${encodeURIComponent(gameKey)}`)
      .set("x-user", userId)
      .set("x-source", source)
      .send(body);
  }

  function liveDoc(userId, gameKey = GAME_KEY) {
    return db.buildIntentLive.findOne({ userId, gameKey });
  }

  function overlayEmits() {
    return io.events("overlay:buildIntent");
  }

  describe("registration from POST /v1/agent/live", () => {
    test("registers the live game with races, opponent and normalised key names", async () => {
      const userId = await newUser();
      await postEnvelope(userId, envelope());
      await settle();
      const doc = await liveDoc(userId);
      expect(doc).toEqual(expect.objectContaining({
        userId,
        gameKey: GAME_KEY,
        keyStartedAtMs: KEY_MS,
        playerNames: ["cure", "streamer"],
        myRace: "Protoss",
        oppRace: "Zerg",
        oppName: "[oM]Cure",
        matchup: "PvZ",
        declared: null,
        postgame: null,
        randomizer: null,
        gameId: null,
        boundAt: null,
        _schemaVersion: 1,
      }));
      expect(doc.expiresAt.getTime() - doc.createdAt.getTime()).toBe(12 * HOUR_MS);
      // No randomizer set up: the hold is decided released and announced.
      expect(doc.hold).toEqual({ untilMs: null, released: true, decidedAt: expect.any(Date) });
      expect(overlayEmits()).toHaveLength(0);
    });

    test("skips identical envelopes and lets later envelope data win", async () => {
      const userId = await newUser();
      await postEnvelope(userId, envelope({ opponent: { name: "[oM]Cure", race: null } }));
      await settle();
      let doc = await liveDoc(userId);
      expect(doc.matchup).toBeNull();
      expect(doc.hold).toBeNull();
      const firstUpdated = doc.updatedAt.getTime();
      nowMs += 1000;
      await postEnvelope(userId, envelope({ opponent: { name: "[oM]Cure", race: null } }));
      await settle();
      doc = await liveDoc(userId);
      expect(doc.updatedAt.getTime()).toBe(firstUpdated);
      await postEnvelope(userId, envelope({ phase: "match_started", displayTime: 3 }));
      await settle();
      doc = await liveDoc(userId);
      expect(doc.oppRace).toBe("Zerg");
      expect(doc.matchup).toBe("PvZ");
      expect(doc.hold).not.toBeNull();
    });

    test.each([
      ["a replay", { isReplay: true }],
      ["an in-progress tick", { phase: "match_in_progress" }],
      ["a menu tick", { phase: "menu" }],
      ["no opponent", { opponent: undefined }],
      ["no game key", { gameKey: undefined }],
    ])("ignores %s", async (_label, over) => {
      const userId = await newUser();
      await postEnvelope(userId, envelope(over));
      await settle();
      expect(await db.buildIntentLive.countDocuments({ userId })).toBe(0);
    });

    test("a registration failure never fails the live POST", async () => {
      const userId = await newUser();
      const failing = { registerFromEnvelope: jest.fn(async () => { throw new Error("db down"); }) };
      const failingApp = express();
      failingApp.use(express.json());
      failingApp.use("/v1", buildAgentLiveRouter({
        broker,
        auth: (req, _res, next) => { req.auth = { userId }; next(); },
        buildIntents: failing,
      }));
      const res = await request(failingApp).post("/v1/agent/live").send(envelope()).expect(200);
      expect(res.body).toEqual({ ok: true });
      await settle();
      expect(failing.registerFromEnvelope).toHaveBeenCalledTimes(1);
    });
  });

  describe("randomizer hold", () => {
    test("holds 6 s when the matchup becomes concrete and a randomizer widget can spin", async () => {
      const userId = await newUser({ hold: true });
      await postEnvelope(userId, envelope());
      await settle();
      const doc = await liveDoc(userId);
      expect(doc.hold).toEqual({ untilMs: nowMs + 6000, released: false, decidedAt: expect.any(Date) });
      expect(overlayEmits()).toEqual([{
        room: `overlay:tok-${userCounter}`,
        event: "overlay:buildIntent",
        payload: { gameKey: GAME_KEY, suppressRandomizer: false, holdRemainingMs: 6000 },
      }]);
      nowMs += 2500;
      const state = await request(app)
        .get(`/v1/build-intents/live/${encodeURIComponent(GAME_KEY)}`)
        .set("x-user", userId)
        .expect(200);
      expect(state.body.holdRemainingMs).toBe(3500);
      nowMs += 10_000;
      const expired = await request(app)
        .get(`/v1/build-intents/live/${encodeURIComponent(GAME_KEY)}`)
        .set("x-user", userId)
        .expect(200);
      expect(expired.body.holdRemainingMs).toBe(0);
    });

    test.each([
      ["check-ins are off", { buildCheckin: { enabled: false } }, null],
      ["loading asks are off", { buildCheckin: { askAtLoading: false } }, null],
      ["the matchup's randomizer is off", { randomizer: randomizerPrefs("PvZ", [PHOENIX_KEY], { enabled: false }) }, null],
      ["the pool is empty", { randomizer: randomizerPrefs("PvZ", []) }, null],
      ["no token shows the randomizer", {}, ["opponent"]],
    ])("is released at once when %s", async (_label, prefs, widgets) => {
      const userId = await newUser({ hold: true });
      if (Object.keys(prefs).length > 0) await setPrefs(db, userId, prefs);
      if (widgets) {
        await db.overlayTokens.updateMany({ userId }, { $set: { enabledWidgets: widgets } });
      }
      await postEnvelope(userId, envelope());
      await settle();
      const doc = await liveDoc(userId);
      expect(doc.hold).toEqual({ untilMs: null, released: true, decidedAt: expect.any(Date) });
      expect(overlayEmits().map((e) => e.payload)).toEqual([
        { gameKey: GAME_KEY, suppressRandomizer: false, holdRemainingMs: 0 },
      ]);
    });

    test("is decided once", async () => {
      const userId = await newUser({ hold: true });
      await postEnvelope(userId, envelope());
      await settle();
      const first = (await liveDoc(userId)).hold;
      nowMs += 1000;
      await postEnvelope(userId, envelope({ opponent: { name: "Cure", race: "Zerg" } }));
      await putLive(userId, { action: "register", myRace: "Protoss", oppRace: "Zerg" }).expect(200);
      await settle();
      expect((await liveDoc(userId)).hold).toEqual(first);
      expect(overlayEmits()).toHaveLength(1);
    });

    test("release ends the hold (Roll now / Not now)", async () => {
      const userId = await newUser({ hold: true });
      await postEnvelope(userId, envelope());
      await settle();
      io.clear();
      const res = await putLive(userId, { action: "release" }).expect(200);
      expect(res.body.holdRemainingMs).toBe(0);
      expect((await liveDoc(userId)).hold).toEqual(expect.objectContaining({ released: true, untilMs: nowMs + 6000 }));
      expect(overlayEmits().map((e) => e.payload)).toEqual([
        { gameKey: GAME_KEY, suppressRandomizer: false, holdRemainingMs: 0 },
      ]);
      expect(io.events("build-intent:changed").map((e) => e.payload)).toEqual([{ gameKey: GAME_KEY }]);
    });
  });

  describe("PUT /v1/build-intents/live/:gameKey", () => {
    test("register fills only missing fields from the body and returns LiveState", async () => {
      const userId = await newUser();
      await postEnvelope(userId, envelope({ user: { name: "Streamer", race: "Random" } }));
      await settle();
      const res = await putLive(userId, {
        action: "register", myRace: "Protoss", oppRace: "Terran", oppName: "Someone Else",
      }).expect(200);
      expect(res.headers["cache-control"]).toBe("private, no-store");
      expect(res.body).toEqual({
        gameKey: GAME_KEY,
        matchup: null,
        myRace: "Random",
        oppRace: "Zerg",
        oppName: "[oM]Cure",
        declared: null,
        randomizer: null,
        randomizerEnabled: false,
        holdRemainingMs: 0,
        gameId: null,
        prefs: { enabled: true, askAtLoading: true, askAfterGame: true },
      });
      const other = `Me|Them|${KEY_MS + 1}`;
      const created = await putLive(userId, {
        action: "register", myRace: "p", oppRace: "zerg", oppName: " Them ",
      }, { gameKey: other }).expect(200);
      expect(created.body).toEqual(expect.objectContaining({
        matchup: "PvZ", myRace: "Protoss", oppRace: "Zerg", oppName: "Them",
      }));
    });

    test("declare stores the server's build, releases the hold and tells the overlay to suppress", async () => {
      const userId = await newUser({ hold: true });
      await postEnvelope(userId, envelope());
      await settle();
      io.clear();
      const res = await putLive(userId, { action: "declare", buildKey: PHOENIX_KEY }).expect(200);
      expect(res.body.declared).toEqual({
        key: PHOENIX_KEY,
        name: "PvZ - 2 Stargate Phoenix",
        slug: null,
        source: "catalog",
        at: expect.any(String),
        via: "agent",
      });
      expect(res.body.holdRemainingMs).toBe(0);
      expect(res.body.randomizerEnabled).toBe(true);
      const doc = await liveDoc(userId);
      expect(doc.hold.released).toBe(true);
      expect(doc.expiresAt.getTime()).toBe(nowMs + 7 * DAY_MS);
      expect(overlayEmits()).toEqual([{
        room: `overlay:tok-${userCounter}`,
        event: "overlay:buildIntent",
        payload: { gameKey: GAME_KEY, suppressRandomizer: true, holdRemainingMs: 0 },
      }]);
      expect(io.events("build-intent:changed").map((e) => e.payload)).toEqual([{ gameKey: GAME_KEY }]);

      io.clear();
      const undeclared = await putLive(userId, { action: "undeclare" }, { source: "clerk" }).expect(200);
      expect(undeclared.body.declared).toBeNull();
      expect((await liveDoc(userId)).hold.released).toBe(true);
      expect(overlayEmits().map((e) => e.payload)).toEqual([
        { gameKey: GAME_KEY, suppressRandomizer: false, holdRemainingMs: 0 },
      ]);
    });

    test("declare of a custom build records web provenance", async () => {
      const userId = await newUser();
      await addCustomBuild(db, userId, "dt-3-gate", { name: "DT into 3 Gate" });
      const res = await putLive(userId, {
        action: "declare", buildKey: "custom:dt-3-gate", myRace: "Protoss", oppRace: "Zerg", oppName: "Cure",
      }, { source: "clerk" }).expect(200);
      expect(res.body.declared).toEqual(expect.objectContaining({
        key: "custom:dt-3-gate", name: "DT into 3 Gate", slug: "dt-3-gate", source: "custom", via: "web",
      }));
    });

    test("declare needs a concrete matchup, an open window and a known build", async () => {
      const userId = await newUser();
      await postEnvelope(userId, envelope({ user: { name: "Streamer", race: "Random" } }));
      await settle();
      const unknownMatchup = await putLive(userId, {
        action: "declare", buildKey: PHOENIX_KEY, myRace: "Protoss",
      }).expect(409);
      expect(unknownMatchup.body.error.code).toBe("matchup_unknown");

      const other = `Streamer|Foe|${KEY_MS + 7}`;
      for (const buildKey of ["tvz-3-rax-marine", "custom:not-mine", "pvz-macro-transition-unclassified"]) {
        const res = await putLive(userId, {
          action: "declare", buildKey, myRace: "Protoss", oppRace: "Zerg",
        }, { gameKey: other }).expect(400);
        expect(res.body.error.code).toBe("unknown_build");
      }
      const badKey = await putLive(userId, { action: "declare", buildKey: 7 }, { gameKey: other }).expect(400);
      expect(badKey.body.error.code).toBe("unknown_build");

      broker.publish(userId, { phase: "match_in_progress", gameKey: other, displayTime: 121 });
      const late = await putLive(userId, { action: "declare", buildKey: PHOENIX_KEY }, { gameKey: other }).expect(409);
      expect(late.body.error.code).toBe("declare_window_closed");
      broker.publish(userId, { phase: "match_in_progress", gameKey: other, displayTime: 119 });
      await putLive(userId, { action: "declare", buildKey: PHOENIX_KEY }, { gameKey: other }).expect(200);
    });

    test("postgame stores the answer for the bind", async () => {
      const userId = await newUser();
      await postEnvelope(userId, envelope());
      await settle();
      const res = await putLive(userId, {
        action: "postgame", buildKey: PHOENIX_KEY, notes: "  hit by a ling flood  ",
      }).expect(200);
      expect(res.body.gameId).toBeNull();
      let doc = await liveDoc(userId);
      expect(doc.postgame).toEqual({
        buildKey: PHOENIX_KEY, skip: false, notes: "hit by a ling flood", at: expect.any(Date), via: "agent",
      });
      expect(doc.expiresAt.getTime()).toBe(nowMs + 7 * DAY_MS);
      await putLive(userId, { action: "postgame", skip: true }, { source: "clerk" }).expect(200);
      doc = await liveDoc(userId);
      expect(doc.postgame).toEqual({ buildKey: null, skip: true, notes: null, at: expect.any(Date), via: "web" });

      const both = await putLive(userId, { action: "postgame", skip: true, buildKey: PHOENIX_KEY }).expect(400);
      expect(both.body.error.code).toBe("invalid_request");
      const neither = await putLive(userId, { action: "postgame" }).expect(400);
      expect(neither.body.error.code).toBe("invalid_request");
      const longNotes = await putLive(userId, { action: "postgame", skip: true, notes: "n".repeat(1001) }).expect(400);
      expect(longNotes.body.error.code).toBe("invalid_notes");
      const wrongMatchup = await putLive(userId, { action: "postgame", buildKey: "tvz-3-rax-marine" }).expect(400);
      expect(wrongMatchup.body.error.code).toBe("unknown_build");
    });

    test("postgame with an unknown matchup accepts any build the user has", async () => {
      const userId = await newUser();
      await addCustomBuild(db, userId, "zerg-thing", { name: "Zerg Thing", race: "Zerg", vsRace: "Any" });
      const randomKey = `Streamer|Foe|${KEY_MS + 9}`;
      await putLive(userId, { action: "register", myRace: "Random", oppRace: "Zerg" }, { gameKey: randomKey }).expect(200);
      await putLive(userId, { action: "postgame", buildKey: "custom:zerg-thing" }, { gameKey: randomKey }).expect(200);
      await putLive(userId, { action: "postgame", buildKey: "tvz-3-rax-marine" }, { gameKey: randomKey }).expect(200);
      const missing = await putLive(userId, { action: "postgame", buildKey: "custom:missing" }, { gameKey: randomKey }).expect(400);
      expect(missing.body.error.code).toBe("unknown_build");
    });

    test("every write to a bound record answers 409 already_bound with the game id", async () => {
      const userId = await newUser();
      await postEnvelope(userId, envelope());
      await settle();
      await db.buildIntentLive.updateOne({ userId, gameKey: GAME_KEY }, { $set: { gameId: "the-game" } });
      for (const body of [
        { action: "register" },
        { action: "declare", buildKey: PHOENIX_KEY },
        { action: "undeclare" },
        { action: "release" },
        { action: "postgame", skip: true },
      ]) {
        const res = await putLive(userId, body).expect(409);
        expect(res.body.error).toEqual(expect.objectContaining({ code: "already_bound", gameId: "the-game" }));
      }
      const state = await request(app)
        .get(`/v1/build-intents/live/${encodeURIComponent(GAME_KEY)}`)
        .set("x-user", userId)
        .expect(200);
      expect(state.body.gameId).toBe("the-game");
    });

    test("validates the game key, the action and unknown fields", async () => {
      const userId = await newUser();
      for (const gameKey of ["no-pipe", "a|b|12x", `a|${"x".repeat(400)}|1`]) {
        const res = await putLive(userId, { action: "register" }, { gameKey }).expect(400);
        expect(res.body.error.code).toBe("invalid_game_key");
        const read = await request(app)
          .get(`/v1/build-intents/live/${encodeURIComponent(gameKey)}`)
          .set("x-user", userId)
          .expect(400);
        expect(read.body.error.code).toBe("invalid_game_key");
      }
      expect((await putLive(userId, { action: "explode" }).expect(400)).body.error.code).toBe("invalid_action");
      expect((await putLive(userId, {}).expect(400)).body.error.code).toBe("invalid_action");
      expect((await putLive(userId, { action: "register", via: "agent" }).expect(400)).body.error.code)
        .toBe("invalid_request");
      const missing = await request(app)
        .get(`/v1/build-intents/live/${encodeURIComponent("Nobody|Here|5")}`)
        .set("x-user", userId)
        .expect(404);
      expect(missing.body.error.code).toBe("not_found");
    });

    test("live writes are limited to 30 a minute per user", async () => {
      const userId = await newUser();
      for (let i = 0; i < 30; i += 1) {
        await putLive(userId, { action: "register" }).expect(200);
      }
      const limited = await putLive(userId, { action: "register" }).expect(429);
      expect(limited.body.error.code).toBe("rate_limited");
      const other = await newUser();
      await putLive(other, { action: "register" }).expect(200);
    });
  });
});
