// @ts-nocheck
/* eslint-disable max-lines-per-function */
"use strict";

/**
 * Build check-in ingest bind: POST /v1/games binds the live record of the
 * game that was just played (pre-game declaration, post-game answer,
 * randomizer roll) to the stored game, first-wins on both sides. Full app,
 * real Mongo.
 */

jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());

const request = require("supertest");
const {
  DAY_MS,
  startFullApp,
  signIn,
  setPrefs,
  addGame,
  ingestGame,
} = require("./helpers/buildIntentHarness");

const UNCLASSIFIED = "PvZ - Macro Transition (Unclassified)";
const PHOENIX = "PvZ - 2 Stargate Phoenix";
const PHOENIX_KEY = "pvz-2-stargate-phoenix";
const ROBO = "PvZ - Robo Opener";
const ROBO_KEY = "pvz-robo-opener";
const PHOENIX_REF = { key: PHOENIX_KEY, name: PHOENIX, slug: null, source: "catalog" };

describe("build check-in ingest bind", () => {
  let h;
  let userCounter = 0;

  beforeAll(async () => {
    h = await startFullApp("build_intent_bind_test");
  });

  afterAll(async () => {
    if (h) await h.stop();
  });

  beforeEach(() => {
    h.io.clear();
  });

  async function newUser() {
    userCounter += 1;
    return signIn(h.app, h.db, `bind${userCounter}`);
  }

  /** The live key of a game: loading started 20 s before the replay's start. */
  function keyFor(game, names = "Opp|Streamer", offsetMs = -20_000) {
    const startMs = Date.parse(game.startedAt);
    return `${names}|${startMs + offsetMs}`;
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

  async function upload(user, ...games) {
    const res = await request(h.app)
      .post("/v1/games")
      .set("authorization", user.device)
      .send({ games })
      .expect(202);
    expect(res.body.rejected).toEqual([]);
    return res.body;
  }

  function gameRow(user, gameId) {
    return h.db.games.findOne({ userId: user.userId, gameId });
  }

  function liveRow(user, gameKey) {
    return h.db.buildIntentLive.findOne({ userId: user.userId, gameKey });
  }

  test("a pre-game declaration becomes a confirmed, applied check-in", async () => {
    const user = await newUser();
    const game = ingestGame(1);
    const gameKey = keyFor(game);
    await register(user, gameKey);
    await putLive(user, gameKey, { action: "declare", buildKey: PHOENIX_KEY });
    await upload(user, game);

    const row = await gameRow(user, game.gameId);
    expect(row.myBuild).toBe(PHOENIX);
    expect(row._customBuildSlug).toBeUndefined();
    expect(row.buildIntent).toEqual({
      status: "confirmed",
      build: PHOENIX_REF,
      applied: true,
      detected: { name: UNCLASSIFIED, slug: null },
      suggestion: { ...PHOENIX_REF, reason: "declared", passedRules: null, ruleCount: null },
      randomizer: null,
      origin: "pregame",
      via: "agent",
      gameKey,
      notes: "",
      confirmedAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });
    const live = await liveRow(user, gameKey);
    expect(live.gameId).toBe(game.gameId);
    expect(live.boundAt).toEqual(expect.any(Date));
    expect(h.io.events("build-intent:changed").map((e) => e.payload)).toContainEqual({ gameId: game.gameId });

    const state = await request(h.app)
      .get(`/v1/games/${encodeURIComponent(game.gameId)}/build-intent`)
      .set("authorization", user.device)
      .expect(200);
    expect(state.body).toEqual(expect.objectContaining({
      status: "confirmed", applied: true, executed: false, origin: "pregame", via: "agent",
    }));
    const again = await request(h.app)
      .put(`/v1/build-intents/live/${encodeURIComponent(gameKey)}`)
      .set("authorization", user.device)
      .send({ action: "declare", buildKey: ROBO_KEY })
      .expect(409);
    expect(again.body.error).toEqual(expect.objectContaining({ code: "already_bound", gameId: game.gameId }));
  });

  test("the post-game answer wins over the declaration and carries its notes", async () => {
    const user = await newUser();
    const game = ingestGame(2);
    const gameKey = keyFor(game);
    await register(user, gameKey);
    await putLive(user, gameKey, { action: "declare", buildKey: PHOENIX_KEY });
    await putLive(user, gameKey, { action: "postgame", buildKey: ROBO_KEY, notes: "switched after scouting" });
    await upload(user, game);
    const row = await gameRow(user, game.gameId);
    expect(row.myBuild).toBe(ROBO);
    expect(row.buildIntent).toEqual(expect.objectContaining({
      status: "confirmed",
      applied: true,
      build: { key: ROBO_KEY, name: ROBO, slug: null, source: "catalog" },
      origin: "postgame",
      notes: "switched after scouting",
      suggestion: expect.objectContaining({ key: PHOENIX_KEY, reason: "declared" }),
    }));
  });

  test("a post-game skip is stored as skipped and leaves the label", async () => {
    const user = await newUser();
    const game = ingestGame(3);
    const gameKey = keyFor(game);
    await register(user, gameKey);
    await putLive(user, gameKey, { action: "declare", buildKey: PHOENIX_KEY });
    await putLive(user, gameKey, { action: "postgame", skip: true });
    await upload(user, game);
    const row = await gameRow(user, game.gameId);
    expect(row.myBuild).toBe(UNCLASSIFIED);
    expect(row.buildIntent).toEqual(expect.objectContaining({
      status: "skipped", applied: false, build: null, origin: "postgame", gameKey,
    }));
  });

  test("a declaration that does not fit the replay's matchup stays a pending suggestion", async () => {
    const user = await newUser();
    const game = ingestGame(4, { opponent: { ...ingestGame(0).opponent, race: "Terran" } });
    const gameKey = keyFor(game);
    await register(user, gameKey);
    await putLive(user, gameKey, { action: "declare", buildKey: PHOENIX_KEY });
    await upload(user, game);
    const row = await gameRow(user, game.gameId);
    expect(row.myBuild).toBe(UNCLASSIFIED);
    expect(row.buildIntent).toEqual(expect.objectContaining({
      status: "pending",
      applied: false,
      build: null,
      gameKey,
      suggestion: { ...PHOENIX_REF, reason: "declared", passedRules: null, ruleCount: null },
    }));
  });

  test("a too-short game takes the answer without applying it", async () => {
    const user = await newUser();
    const game = ingestGame(5, { durationSec: 30 });
    const gameKey = keyFor(game);
    await register(user, gameKey);
    await putLive(user, gameKey, { action: "declare", buildKey: PHOENIX_KEY });
    await upload(user, game);
    const row = await gameRow(user, game.gameId);
    expect(row.myBuild).toBe(UNCLASSIFIED);
    expect(row.buildIntent).toEqual(expect.objectContaining({
      status: "confirmed", applied: false, build: PHOENIX_REF, confirmedAt: expect.any(Date),
    }));
  });

  test("clan-tagged live names match the replay's opponent", async () => {
    const user = await newUser();
    const game = ingestGame(6);
    const byOppName = keyFor(game, "[oM]Opp#123|Streamer#1");
    await register(user, byOppName, { myRace: "Protoss", oppRace: "Zerg", oppName: "[oM]Opp" });
    await putLive(user, byOppName, { action: "declare", buildKey: PHOENIX_KEY });
    await upload(user, game);
    expect((await gameRow(user, game.gameId)).buildIntent.gameKey).toBe(byOppName);

    const second = ingestGame(7);
    const byKeyNames = keyFor(second, "[oM]Opp|Streamer");
    await register(user, byKeyNames, { myRace: "Protoss", oppRace: "Zerg" });
    await upload(user, second);
    const row = await gameRow(user, second.gameId);
    expect(row.buildIntent.gameKey).toBe(byKeyNames);
    expect(row.buildIntent.status).toBe("pending");
  });

  test("a nameless key binds only when it is the only candidate", async () => {
    const user = await newUser();
    const game = ingestGame(8);
    const sole = keyFor(game, "unknown");
    await register(user, sole, {});
    await putLive(user, sole, { action: "postgame", buildKey: PHOENIX_KEY });
    await upload(user, game);
    expect((await gameRow(user, game.gameId)).buildIntent).toEqual(expect.objectContaining({
      gameKey: sole, status: "confirmed", applied: true,
    }));

    const crowded = ingestGame(9);
    const a = keyFor(crowded, "unknown", -30_000);
    const b = keyFor(crowded, "Streamer", -15_000);
    await register(user, a, {});
    await register(user, b, {});
    await upload(user, crowded);
    const row = await gameRow(user, crowded.gameId);
    expect(row.buildIntent).toEqual(expect.objectContaining({ status: "pending" }));
    expect(row.buildIntent).not.toHaveProperty("gameKey");
    expect((await liveRow(user, a)).gameId).toBeNull();
    expect((await liveRow(user, b)).gameId).toBeNull();
  });

  test("the next game's record and other opponents' records never bind", async () => {
    const user = await newUser();
    const game = ingestGame(10);
    const next = `Opp|Streamer|${Date.parse(game.date) + 30_000}`;
    const otherOpponent = keyFor(game, "Someone|Streamer");
    await register(user, next);
    await putLive(user, next, { action: "declare", buildKey: PHOENIX_KEY });
    await register(user, otherOpponent, { myRace: "Protoss", oppRace: "Zerg", oppName: "Someone" });
    await upload(user, game);
    expect((await liveRow(user, next)).gameId).toBeNull();
    expect((await liveRow(user, otherOpponent)).gameId).toBeNull();
    const row = await gameRow(user, game.gameId);
    expect(row.myBuild).toBe(UNCLASSIFIED);
    expect(row.buildIntent).not.toHaveProperty("gameKey");
  });

  test("re-uploading a bound game changes nothing", async () => {
    const user = await newUser();
    const game = ingestGame(11);
    const first = keyFor(game, "Opp|Streamer", -40_000);
    await register(user, first);
    await putLive(user, first, { action: "declare", buildKey: PHOENIX_KEY });
    await upload(user, game);
    const bound = await gameRow(user, game.gameId);
    const latecomer = keyFor(game, "Opp|Streamer", -10_000);
    await register(user, latecomer);
    await putLive(user, latecomer, { action: "declare", buildKey: ROBO_KEY });
    await upload(user, game);
    const after = await gameRow(user, game.gameId);
    expect(after.myBuild).toBe(PHOENIX);
    expect(after.buildIntent).toEqual(bound.buildIntent);
    expect((await liveRow(user, latecomer)).gameId).toBeNull();
  });

  test("concurrent binds of one game bind exactly one record", async () => {
    const user = await newUser();
    const game = ingestGame(12);
    const a = keyFor(game, "Opp|Streamer", -40_000);
    const b = keyFor(game, "Opp|Streamer", -10_000);
    await register(user, a);
    await register(user, b);
    await putLive(user, a, { action: "declare", buildKey: ROBO_KEY });
    await putLive(user, b, { action: "declare", buildKey: PHOENIX_KEY });
    await addGame(h.db, user.userId, game.gameId, {
      date: new Date(game.date), startedAt: game.startedAt, durationSec: game.durationSec,
    });
    const outcomes = await Promise.all([
      h.services.buildIntents.bindIngestedGame(user.userId, game, { created: true }),
      h.services.buildIntents.bindIngestedGame(user.userId, game, { created: true }),
      h.services.buildIntents.bindIngestedGame(user.userId, game, { created: false }),
    ]);
    expect(outcomes.filter((o) => o && o.bound)).toHaveLength(1);
    const row = await gameRow(user, game.gameId);
    const bound = await h.db.buildIntentLive.find({ userId: user.userId, gameId: game.gameId }).toArray();
    expect(bound).toHaveLength(1);
    expect(row.buildIntent.gameKey).toBe(bound[0].gameKey);
    expect(row.myBuild).toBe(bound[0].gameKey === b ? PHOENIX : ROBO);
  });

  test("a check-in made on the web before the bind is kept; only the key and roll are filled", async () => {
    const user = await newUser();
    const game = ingestGame(13);
    await upload(user, game);
    expect((await gameRow(user, game.gameId)).buildIntent.status).toBe("pending");
    await request(h.app)
      .put(`/v1/games/${encodeURIComponent(game.gameId)}/build-intent`)
      .set("authorization", user.web)
      .send({ action: "confirm", buildKey: ROBO_KEY, notes: "web note" })
      .expect(200);
    const gameKey = keyFor(game);
    await register(user, gameKey);
    await putLive(user, gameKey, { action: "declare", buildKey: PHOENIX_KEY });
    await putLive(user, gameKey, { action: "postgame", buildKey: PHOENIX_KEY, notes: "agent note" });
    await h.db.buildIntentLive.updateOne(
      { userId: user.userId, gameKey },
      { $set: { randomizer: { ...PHOENIX_REF, at: new Date(), verifiedPool: true } } },
    );
    await upload(user, game);
    const row = await gameRow(user, game.gameId);
    expect(row.myBuild).toBe(ROBO);
    expect(row.buildIntent).toEqual(expect.objectContaining({
      status: "confirmed",
      applied: true,
      build: { key: ROBO_KEY, name: ROBO, slug: null, source: "catalog" },
      origin: "web",
      via: "web",
      notes: "web note",
      gameKey,
      randomizer: PHOENIX_REF,
    }));
  });

  test("web notes written before the bind survive the post-game answer", async () => {
    const user = await newUser();
    const game = ingestGame(14, { endMs: Date.now() - 3 * DAY_MS });
    await upload(user, game);
    expect((await gameRow(user, game.gameId)).buildIntent).toBeUndefined();
    await request(h.app)
      .put(`/v1/games/${encodeURIComponent(game.gameId)}/build-intent`)
      .set("authorization", user.web)
      .send({ action: "notes", notes: "typed on the web" })
      .expect(200);
    const gameKey = keyFor(game);
    await register(user, gameKey);
    await putLive(user, gameKey, { action: "postgame", buildKey: PHOENIX_KEY, notes: "agent note" });
    await upload(user, game);
    const row = await gameRow(user, game.gameId);
    expect(row.buildIntent).toEqual(expect.objectContaining({
      status: "confirmed", applied: true, notes: "typed on the web", gameKey,
    }));
  });

  test("a randomizer roll the replay agrees with is the pending suggestion", async () => {
    const user = await newUser();
    const game = ingestGame(15);
    const gameKey = keyFor(game);
    await register(user, gameKey);
    await h.db.buildIntentLive.updateOne(
      { userId: user.userId, gameKey },
      { $set: { randomizer: { ...PHOENIX_REF, at: new Date(), verifiedPool: true } } },
    );
    await upload(user, game);
    const row = await gameRow(user, game.gameId);
    expect(row.buildIntent).toEqual(expect.objectContaining({
      status: "pending",
      randomizer: PHOENIX_REF,
      suggestion: { ...PHOENIX_REF, reason: "randomizer", passedRules: null, ruleCount: null },
    }));
    const state = await request(h.app)
      .get(`/v1/games/${encodeURIComponent(game.gameId)}/build-intent`)
      .set("authorization", user.web)
      .expect(200);
    expect(state.body.randomizerDeviated).toBe(false);
  });

  test("a roll the replay deviated from is flagged and the detected build suggested", async () => {
    const user = await newUser();
    const game = ingestGame(16, { myBuild: ROBO });
    const gameKey = keyFor(game);
    await register(user, gameKey);
    await h.db.buildIntentLive.updateOne(
      { userId: user.userId, gameKey },
      { $set: { randomizer: { ...PHOENIX_REF, at: new Date(), verifiedPool: true } } },
    );
    await upload(user, game);
    const row = await gameRow(user, game.gameId);
    expect(row.buildIntent.suggestion).toEqual(expect.objectContaining({ key: ROBO_KEY, reason: "detected" }));
    const state = await request(h.app)
      .get(`/v1/games/${encodeURIComponent(game.gameId)}/build-intent`)
      .set("authorization", user.web)
      .expect(200);
    expect(state.body.randomizerDeviated).toBe(true);
    expect(state.body.randomizer).toEqual(PHOENIX_REF);
  });

  test("a bound record without an answer leaves the game undecided (none when check-ins are off)", async () => {
    const user = await newUser();
    await setPrefs(h.db, user.userId, { buildCheckin: { enabled: false } });
    const game = ingestGame(17);
    const gameKey = keyFor(game);
    await register(user, gameKey);
    await upload(user, game);
    expect((await gameRow(user, game.gameId)).buildIntent).toEqual(expect.objectContaining({
      status: "none", gameKey,
    }));
  });

  describe("games without a live record", () => {
    test("a fresh eligible game becomes pending with a suggestion", async () => {
      const user = await newUser();
      const game = ingestGame(20, { myBuild: PHOENIX });
      await upload(user, game);
      const row = await gameRow(user, game.gameId);
      expect(row.buildIntent).toEqual({
        status: "pending",
        build: null,
        applied: false,
        detected: null,
        suggestion: { ...PHOENIX_REF, reason: "detected", passedRules: null, ruleCount: null },
        randomizer: null,
        origin: null,
        via: null,
        notes: "",
        confirmedAt: null,
        updatedAt: expect.any(Date),
      });
      const pending = await request(h.app)
        .get("/v1/build-intents/pending")
        .set("authorization", user.web)
        .expect(200);
      expect(pending.body.items.map((i) => i.gameId)).toEqual([game.gameId]);
    });

    test.each([
      ["an old game", { endMs: Date.now() - 2 * DAY_MS }, null],
      ["a team game", { matchFormat: "team" }, null],
      ["a too-short game", { durationSec: 20 }, null],
      ["a user with check-ins off", {}, { enabled: false }],
    ])("%s stays without a check-in", async (_label, over, prefs) => {
      const user = await newUser();
      if (prefs) await setPrefs(h.db, user.userId, { buildCheckin: prefs });
      const game = ingestGame(30, over);
      await upload(user, game);
      expect((await gameRow(user, game.gameId)).buildIntent).toBeUndefined();
    });

    test("a re-upload never creates a pending check-in", async () => {
      const user = await newUser();
      const game = ingestGame(31);
      await addGame(h.db, user.userId, game.gameId, { date: new Date(game.date) });
      await upload(user, game);
      expect((await gameRow(user, game.gameId)).buildIntent).toBeUndefined();
    });
  });

  test("a bind failure never rejects the upload", async () => {
    const user = await newUser();
    const game = ingestGame(40);
    const original = h.services.buildIntents.bindIngestedGame;
    h.services.buildIntents.bindIngestedGame = jest.fn(async () => {
      throw new Error("bind exploded");
    });
    try {
      const body = await upload(user, game);
      expect(body.accepted.map((a) => a.gameId)).toEqual([game.gameId]);
    } finally {
      h.services.buildIntents.bindIngestedGame = original;
    }
  });
});
