// @ts-nocheck
/* eslint-disable max-lines-per-function */
"use strict";

/**
 * Build check-in and the OBS randomizer pool's race-generic openers. The
 * web randomizer offers "Protoss - DT Rush" and friends for every Protoss
 * matchup, while the guide's Protoss build lists only carry "PvX - …"
 * names. Pool entries that are race-generic openers of the user's own race
 * must still be options: rollable, declarable, confirmable and bindable.
 * Real Mongo, header-driven auth stub.
 */

const express = require("express");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { LiveGameBroker } = require("../src/services/liveGameBroker");
const { BuildIntentsService } = require("../src/services/buildIntents");
const { fitsMatchup } = require("../src/services/buildIntentOptions");
const { buildBuildIntentsRouter } = require("../src/routes/buildIntents");
const {
  makeFakeIo,
  randomizerPrefs,
  setPrefs,
  addOverlayToken,
  addGame,
} = require("./helpers/buildIntentHarness");

const KEY_MS = 1_790_000_000_000;
const DT = "Protoss - DT Rush";
const DT_KEY = "protoss-dt-rush";
const GENERIC_KEY = "protoss-standard-play-unclassified";

describe("build check-in: race-generic randomizer openers", () => {
  let mongo;
  let db;
  let io;
  let broker;
  let service;
  let app;
  let userCounter = 0;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "build_intent_live_pool_test" });
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  beforeEach(() => {
    io = makeFakeIo();
    broker = new LiveGameBroker();
    service = new BuildIntentsService(db, { io, liveGameBroker: broker });
    const auth = (req, _res, next) => {
      req.auth = { userId: String(req.headers["x-user"]), source: "device" };
      next();
    };
    app = express();
    app.use(express.json());
    app.use("/v1", buildBuildIntentsRouter({ buildIntents: service, auth }));
  });

  async function newUser(matchup, ids, opts) {
    userCounter += 1;
    const userId = `pool-user-${userCounter}`;
    await db.users.insertOne({ userId, clerkUserId: `clerk_pool_${userCounter}`, preferences: {} });
    await setPrefs(db, userId, { randomizer: randomizerPrefs(matchup, ids, opts) });
    return userId;
  }

  function races(matchup) {
    const word = { P: "Protoss", T: "Terran", Z: "Zerg" };
    return { myRace: word[matchup.charAt(0)], oppRace: word[matchup.charAt(2)] };
  }

  function putLive(userId, gameKey, body) {
    return request(app)
      .put(`/v1/build-intents/live/${encodeURIComponent(gameKey)}`)
      .set("x-user", userId)
      .send(body);
  }

  describe.each(["PvP", "PvT", "PvZ"])("%s", (matchup) => {
    test("a pool entry is an option in the randomizer group", async () => {
      const userId = await newUser(matchup, [DT_KEY, GENERIC_KEY]);
      const options = await service.getOptions(userId, matchup);
      const dt = options.builds.find((b) => b.key === DT_KEY);
      expect(dt).toEqual(expect.objectContaining({
        name: DT, slug: null, source: "catalog", inRandomizer: true, group: "yours",
      }));
      expect(options.builds.some((b) => b.key === GENERIC_KEY)).toBe(false);
      expect(await service.options.resolveKey(userId, matchup, DT_KEY))
        .toEqual({ key: DT_KEY, name: DT, slug: null, source: "catalog" });
      expect(await service.options.resolveKey(userId, matchup, GENERIC_KEY)).toBeNull();
    });

    test("a roll of it is recorded and a declaration of it is accepted", async () => {
      const userId = await newUser(matchup, [DT_KEY]);
      const token = `pool-tok-${userCounter}`;
      await addOverlayToken(db, userId, token, ["randomizer"]);
      const gameKey = `Opp|Streamer|${KEY_MS + userCounter}`;
      const { myRace, oppRace } = races(matchup);
      broker.publish(userId, {
        phase: "match_loading", gameKey, displayTime: 0,
        user: { name: "Streamer", race: myRace }, opponent: { name: "Opp", race: oppRace },
      });
      await putLive(userId, gameKey, { action: "register", myRace, oppRace, oppName: "Opp" }).expect(200);
      await service.handleRandomizerRoll(userId, token, { gameKey, buildId: DT_KEY });
      const doc = await db.buildIntentLive.findOne({ userId, gameKey });
      expect(doc.randomizer).toEqual(expect.objectContaining({ key: DT_KEY, name: DT, source: "catalog" }));
      const res = await putLive(userId, gameKey, { action: "declare", buildKey: DT_KEY }).expect(200);
      expect(res.body.declared).toEqual(expect.objectContaining({ key: DT_KEY, name: DT }));
      await putLive(userId, gameKey, { action: "postgame", buildKey: DT_KEY }).expect(200);
    });

    test("a game of the matchup can be confirmed as it", async () => {
      const userId = await newUser(matchup, [DT_KEY]);
      const gameId = `pool-game-${userCounter}`;
      await addGame(db, userId, gameId, {
        myBuild: `${matchup} - Something (Unclassified)`,
        opponent: { displayName: "Opp", race: races(matchup).oppRace },
      });
      const state = await service.putGameIntent(userId, gameId, { action: "confirm", buildKey: DT_KEY }, {});
      expect(state.build).toEqual({ key: DT_KEY, name: DT, slug: null, source: "catalog" });
      expect((await db.games.findOne({ userId, gameId })).myBuild).toBe(DT);
    });
  });

  test("only the user's own race qualifies, only from the pool, only while it is on", async () => {
    const zerg = await newUser("ZvP", [DT_KEY]);
    expect((await service.getOptions(zerg, "ZvP")).builds.some((b) => b.key === DT_KEY)).toBe(false);
    expect(await service.options.resolveKey(zerg, "ZvP", DT_KEY)).toBeNull();
    const notPooled = await newUser("PvZ", ["pvz-robo-opener"]);
    expect((await service.getOptions(notPooled, "PvZ")).builds.some((b) => b.key === DT_KEY)).toBe(false);
    const gameKey = `Opp|Streamer|${KEY_MS - 5}`;
    await putLive(notPooled, gameKey, { action: "register", myRace: "Protoss", oppRace: "Zerg" }).expect(200);
    const refused = await putLive(notPooled, gameKey, { action: "declare", buildKey: DT_KEY }).expect(400);
    expect(refused.body.error.code).toBe("unknown_build");
    const off = await newUser("PvZ", [DT_KEY], { enabled: false });
    expect((await service.getOptions(off, "PvZ")).builds.some((b) => b.key === DT_KEY)).toBe(false);
  });

  test("the bind's fit check accepts own-race generic openers", () => {
    const resolved = { ref: { key: DT_KEY, name: DT, slug: null, source: "catalog" }, race: "Protoss", vsRace: null };
    expect(fitsMatchup(resolved, "PvZ")).toBe(true);
    expect(fitsMatchup(resolved, "ZvP")).toBe(false);
    expect(fitsMatchup({ ...resolved, race: "Zerg" }, "PvZ")).toBe(false);
    const generic = {
      ref: { key: GENERIC_KEY, name: "Protoss - Standard Play (Unclassified)", slug: null, source: "catalog" },
      race: "Protoss",
      vsRace: null,
    };
    expect(fitsMatchup(generic, "PvZ")).toBe(false);
  });
});
