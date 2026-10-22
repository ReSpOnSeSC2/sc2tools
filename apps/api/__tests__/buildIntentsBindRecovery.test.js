// @ts-nocheck
/* eslint-disable max-lines-per-function */
"use strict";

/**
 * Build check-in ingest bind, failure and edge cases: a claim is released
 * when the bind fails after claiming (unless the game write did land),
 * records carrying an answer are claimed first, and a record keyed
 * mid-game (an agent that first saw the match late) still binds its answer
 * when it names the replay's opponent. Full app, real Mongo.
 */

jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());

const request = require("supertest");
const {
  startFullApp,
  signIn,
  addGame,
  ingestGame,
} = require("./helpers/buildIntentHarness");

const UNCLASSIFIED = "PvZ - Macro Transition (Unclassified)";
const PHOENIX = "PvZ - 2 Stargate Phoenix";
const PHOENIX_KEY = "pvz-2-stargate-phoenix";
const ROBO = "PvZ - Robo Opener";
const ROBO_KEY = "pvz-robo-opener";

describe("build check-in ingest bind: recovery and late keys", () => {
  let h;
  let userCounter = 0;

  beforeAll(async () => {
    h = await startFullApp("build_intent_bind_recovery_test");
  });

  afterAll(async () => {
    if (h) await h.stop();
  });

  beforeEach(() => {
    h.io.clear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function newUser() {
    userCounter += 1;
    return signIn(h.app, h.db, `recover${userCounter}`);
  }

  /** A live key ``offsetMs`` after the replay's start. */
  function keyAt(game, offsetMs, names = "Opp|Streamer") {
    return `${names}|${Date.parse(game.startedAt) + offsetMs}`;
  }

  function putLive(user, gameKey, body) {
    return request(h.app)
      .put(`/v1/build-intents/live/${encodeURIComponent(gameKey)}`)
      .set("authorization", user.device)
      .send(body)
      .expect(200);
  }

  async function register(user, gameKey, fields = { myRace: "Protoss", oppRace: "Zerg", oppName: "Opp" }) {
    await putLive(user, gameKey, { action: "register", ...fields });
  }

  async function upload(user, game) {
    const res = await request(h.app)
      .post("/v1/games")
      .set("authorization", user.device)
      .send({ games: [game] })
      .expect(202);
    expect(res.body.rejected).toEqual([]);
  }

  /** The stored row of an ingest payload, without going through ingest. */
  async function storeGame(user, game) {
    await addGame(h.db, user.userId, game.gameId, {
      date: new Date(game.date), startedAt: game.startedAt, durationSec: game.durationSec,
    });
  }

  function bind(user, game) {
    return h.services.buildIntents.bindIngestedGame(user.userId, game, { created: true });
  }

  const gameRow = (user, gameId) => h.db.games.findOne({ userId: user.userId, gameId });
  const liveRow = (user, gameKey) => h.db.buildIntentLive.findOne({ userId: user.userId, gameKey });

  describe("a failure after the claim", () => {
    test("releases the record so the next bind can take it", async () => {
      const user = await newUser();
      const game = ingestGame(1);
      const gameKey = keyAt(game, -20_000);
      await register(user, gameKey);
      await putLive(user, gameKey, { action: "declare", buildKey: PHOENIX_KEY });
      await storeGame(user, game);
      jest.spyOn(h.db.games, "updateOne").mockRejectedValueOnce(new Error("transient write failure"));
      await expect(bind(user, game)).rejects.toThrow("transient write failure");
      const released = await liveRow(user, gameKey);
      expect(released.gameId).toBeNull();
      expect(released.boundAt).toBeNull();
      expect((await gameRow(user, game.gameId)).buildIntent).toBeUndefined();

      jest.restoreAllMocks();
      expect(await bind(user, game)).toEqual({ bound: true, status: "confirmed" });
      expect((await liveRow(user, gameKey)).gameId).toBe(game.gameId);
      expect((await gameRow(user, game.gameId)).myBuild).toBe(PHOENIX);
    });

    test("keeps the claim when the game write landed before the error", async () => {
      const user = await newUser();
      const game = ingestGame(2);
      const gameKey = keyAt(game, -20_000);
      await register(user, gameKey);
      await putLive(user, gameKey, { action: "declare", buildKey: PHOENIX_KEY });
      await storeGame(user, game);
      const real = h.db.games.updateOne.bind(h.db.games);
      jest.spyOn(h.db.games, "updateOne").mockImplementationOnce(async (...args) => {
        await real(...args);
        throw new Error("connection reset after write");
      });
      await expect(bind(user, game)).rejects.toThrow("connection reset after write");
      expect((await liveRow(user, gameKey)).gameId).toBe(game.gameId);
      const row = await gameRow(user, game.gameId);
      expect(row.buildIntent.gameKey).toBe(gameKey);
      expect(row.myBuild).toBe(PHOENIX);
    });

    test("a failing release never hides the original error", async () => {
      const user = await newUser();
      const game = ingestGame(3);
      const gameKey = keyAt(game, -20_000);
      await register(user, gameKey);
      await storeGame(user, game);
      jest.spyOn(h.db.games, "updateOne").mockRejectedValueOnce(new Error("first failure"));
      jest.spyOn(h.db.buildIntentLive, "updateOne").mockRejectedValueOnce(new Error("release failure"));
      await expect(bind(user, game)).rejects.toThrow("first failure");
    });
  });

  describe("claim order", () => {
    test("a record with the post-game answer is claimed before a newer empty one", async () => {
      const user = await newUser();
      const game = ingestGame(4);
      const answered = keyAt(game, -40_000);
      const empty = keyAt(game, -10_000);
      await register(user, answered);
      await putLive(user, answered, { action: "postgame", buildKey: ROBO_KEY });
      await register(user, empty);
      await upload(user, game);
      expect((await liveRow(user, answered)).gameId).toBe(game.gameId);
      expect((await liveRow(user, empty)).gameId).toBeNull();
      const row = await gameRow(user, game.gameId);
      expect(row.myBuild).toBe(ROBO);
      expect(row.buildIntent).toEqual(expect.objectContaining({ status: "confirmed", origin: "postgame", gameKey: answered }));
    });

    test("a declaration is claimed before a newer empty record", async () => {
      const user = await newUser();
      const game = ingestGame(5);
      const declared = keyAt(game, -40_000);
      const empty = keyAt(game, -10_000);
      await register(user, declared);
      await putLive(user, declared, { action: "declare", buildKey: PHOENIX_KEY });
      await register(user, empty);
      await upload(user, game);
      expect((await gameRow(user, game.gameId)).buildIntent.gameKey).toBe(declared);
    });
  });

  describe("a record keyed mid-game", () => {
    test("binds its post-game answer when it names the opponent", async () => {
      const user = await newUser();
      const game = ingestGame(6);
      const late = keyAt(game, 3 * 60_000);
      await register(user, late);
      await putLive(user, late, { action: "postgame", buildKey: PHOENIX_KEY, notes: "agent restarted" });
      await upload(user, game);
      expect((await liveRow(user, late)).gameId).toBe(game.gameId);
      const row = await gameRow(user, game.gameId);
      expect(row.myBuild).toBe(PHOENIX);
      expect(row.buildIntent).toEqual(expect.objectContaining({
        status: "confirmed", applied: true, origin: "postgame", notes: "agent restarted", gameKey: late,
      }));
    });

    test("outranks an empty loading-screen record of the same game", async () => {
      const user = await newUser();
      const game = ingestGame(7);
      const loading = keyAt(game, -20_000);
      const late = keyAt(game, 4 * 60_000);
      await register(user, loading);
      await register(user, late);
      await putLive(user, late, { action: "postgame", buildKey: ROBO_KEY });
      await upload(user, game);
      expect((await gameRow(user, game.gameId)).buildIntent.gameKey).toBe(late);
      expect((await liveRow(user, loading)).gameId).toBeNull();
    });

    test.each([
      ["it carries no answer", async (user, key) => {
        await register(user, key);
      }],
      ["it names another opponent", async (user, key) => {
        await register(user, key, { myRace: "Protoss", oppRace: "Zerg", oppName: "Someone" });
        await putLive(user, key, { action: "postgame", buildKey: PHOENIX_KEY });
      }, "Someone|Streamer"],
      ["it names nobody", async (user, key) => {
        await register(user, key, { myRace: "Protoss", oppRace: "Zerg" });
        await putLive(user, key, { action: "postgame", buildKey: PHOENIX_KEY });
      }, "unknown"],
    ])("is left alone when %s", async (_label, arrange, names = "Opp|Streamer") => {
      const user = await newUser();
      const game = ingestGame(8 + userCounter);
      const late = keyAt(game, 3 * 60_000, names);
      await arrange(user, late);
      await upload(user, game);
      expect((await liveRow(user, late)).gameId).toBeNull();
      const row = await gameRow(user, game.gameId);
      expect(row.myBuild).toBe(UNCLASSIFIED);
      expect(row.buildIntent).toEqual(expect.objectContaining({ status: "pending" }));
      expect(row.buildIntent).not.toHaveProperty("gameKey");
    });
  });
});
