// @ts-nocheck
/* eslint-disable max-lines-per-function */
"use strict";

/**
 * Build check-in route guards: quarantined (resumed) games refuse every
 * PUT action, also when the quarantine lands between the read and the
 * write; a dismiss never touches a quarantined game; and preference writes
 * reach clients (``build-intent:changed {prefs: true}`` for the check-in
 * switches, fresh options after a randomizer change). Full app, real Mongo.
 */

jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());

const request = require("supertest");
const {
  HOUR_MS,
  startFullApp,
  signIn,
  randomizerPrefs,
  addCustomBuild,
  addGame,
} = require("./helpers/buildIntentHarness");

const UNCLASSIFIED = "PvZ - Macro Transition (Unclassified)";
const PHOENIX_KEY = "pvz-2-stargate-phoenix";
const BANE_KEY = "zvp-ling-bane-bust";

describe("build check-in route guards", () => {
  let h;
  let userCounter = 0;

  beforeAll(async () => {
    h = await startFullApp("build_intent_routes_guards_test");
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
    return signIn(h.app, h.db, `guards${userCounter}`);
  }

  function putIntent(auth, gameId, body) {
    return request(h.app)
      .put(`/v1/games/${encodeURIComponent(gameId)}/build-intent`)
      .set("authorization", auth)
      .send(body);
  }

  const gameRow = (user, gameId) => h.db.games.findOne({ userId: user.userId, gameId });

  /** A game with confirmed custom check-ins on both axes, then quarantined. */
  async function quarantinedCheckIn(user, gameId) {
    await addCustomBuild(h.db, user.userId, "my-dt", { name: "My DT" });
    await addCustomBuild(h.db, user.userId, "their-roach", {
      name: "Their Roach", race: "Zerg", vsRace: "Protoss", perspective: "opponent",
    });
    await addGame(h.db, user.userId, gameId, {
      myBuild: "Stargate Opener",
      _customBuildSlug: "stargate-opener",
      _customOpponentStrategySlug: "old-read",
      opponent: { displayName: "Opp", race: "Zerg", strategy: "Old Read" },
    });
    await putIntent(user.web, gameId, {
      action: "confirm", buildKey: "custom:my-dt", opponentBuildKey: "custom:their-roach",
    }).expect(200);
    const row = await gameRow(user, gameId);
    await h.services.games.quarantineResumedReplay(user.userId, { gameId, date: row.date });
    return gameRow(user, gameId);
  }

  /** The fields a refused PUT must leave untouched. */
  function labels(row) {
    return {
      myBuild: row.myBuild,
      customBuildSlug: row._customBuildSlug,
      strategy: row.opponent.strategy,
      customOpponentStrategySlug: row._customOpponentStrategySlug,
      buildIntent: row.buildIntent,
    };
  }

  describe("quarantined games", () => {
    test("refuse every action, and nothing is written back", async () => {
      const user = await newUser();
      const before = await quarantinedCheckIn(user, "resumed");
      expect(before.isResumedFromReplay).toBe(true);
      expect(before).not.toHaveProperty("_customBuildSlug");
      expect(before).not.toHaveProperty("_customOpponentStrategySlug");
      h.io.clear();
      for (const body of [
        { action: "confirm", buildKey: PHOENIX_KEY },
        { action: "skip" },
        { action: "skip", notes: "x", opponentBuildKey: null },
        { action: "defer" },
        { action: "notes", notes: "late thought" },
        { action: "opponent", opponentBuildKey: BANE_KEY },
        { action: "opponent", opponentBuildKey: null },
      ]) {
        const res = await putIntent(user.web, "resumed", body).expect(409);
        expect(res.body.error).toEqual(expect.objectContaining({ code: "not_eligible", reason: "resumed" }));
      }
      expect(labels(await gameRow(user, "resumed"))).toEqual(labels(before));
      expect(h.io.events("games:changed")).toHaveLength(0);
    });

    test("a quarantine between the read and the write is never undone", async () => {
      const user = await newUser();
      await addCustomBuild(h.db, user.userId, "my-dt", { name: "My DT" });
      await addGame(h.db, user.userId, "racing", { myBuild: "Stargate Opener", _customBuildSlug: "stargate-opener" });
      await putIntent(user.web, "racing", { action: "confirm", buildKey: "custom:my-dt" }).expect(200);
      const stale = await gameRow(user, "racing");
      await h.services.games.quarantineResumedReplay(user.userId, { gameId: "racing", date: stale.date });
      const quarantined = await gameRow(user, "racing");
      for (const body of [{ action: "skip" }, { action: "notes", notes: "n" }, { action: "defer" }]) {
        // The PUT's first read still sees the row as it was before the quarantine.
        jest.spyOn(h.db.games, "findOne").mockResolvedValueOnce({ ...stale });
        const res = await putIntent(user.web, "racing", body).expect(409);
        expect(res.body.error).toEqual(expect.objectContaining({ code: "not_eligible", reason: "resumed" }));
        jest.restoreAllMocks();
      }
      const after = await gameRow(user, "racing");
      expect(after).not.toHaveProperty("_customBuildSlug");
      expect(after.buildIntent).toEqual(quarantined.buildIntent);
    });

    test("a game deleted between the read and the write is a 404", async () => {
      const user = await newUser();
      await addGame(h.db, user.userId, "vanishing");
      const stale = await gameRow(user, "vanishing");
      await h.db.games.deleteOne({ userId: user.userId, gameId: "vanishing" });
      jest.spyOn(h.db.games, "findOne").mockResolvedValueOnce({ ...stale });
      const res = await putIntent(user.web, "vanishing", { action: "notes", notes: "n" }).expect(404);
      expect(res.body.error.code).toBe("not_found");
    });

    test("dismiss never skips a game quarantined after the queue was read", async () => {
      const user = await newUser();
      await addGame(h.db, user.userId, "queued", {
        date: new Date(Date.now() - HOUR_MS),
        isResumedFromReplay: true,
        buildIntent: {
          status: "pending", build: null, applied: false, detected: null, suggestion: null,
          randomizer: null, origin: null, via: null, notes: "", confirmedAt: null, updatedAt: new Date(),
        },
      });
      const realFind = h.db.games.find.bind(h.db.games);
      jest.spyOn(h.db.games, "find").mockImplementationOnce((filter, opts) => {
        // The queue read still lists the game: drop the resumed guard once.
        const { isResumedFromReplay, ...rest } = filter;
        expect(isResumedFromReplay).toEqual({ $ne: true });
        return realFind(rest, opts);
      });
      const res = await request(h.app)
        .post("/v1/build-intents/pending/dismiss")
        .set("authorization", user.web)
        .expect(200);
      expect(res.body).toEqual({ dismissed: 0 });
      expect((await gameRow(user, "queued")).buildIntent.status).toBe("pending");
    });
  });

  describe("preference writes", () => {
    function putPrefs(auth, type, body) {
      return request(h.app).put(`/v1/me/preferences/${type}`).set("authorization", auth).send(body);
    }

    test("the check-in switches ping the user room with {prefs: true}", async () => {
      const user = await newUser();
      await putPrefs(user.web, "buildCheckin", { askAtLoading: false }).expect(200);
      expect(h.io.events("build-intent:changed")).toEqual([
        { room: `user:${user.userId}`, event: "build-intent:changed", payload: { prefs: true } },
      ]);
      h.io.clear();
      await putPrefs(user.device, "buildCheckin", { enabled: false }).expect(200);
      expect(h.io.events("build-intent:changed").map((e) => e.payload)).toEqual([{ prefs: true }]);
      h.io.clear();
      await putPrefs(user.web, "misc", { theme: "dark" }).expect(200);
      expect(h.io.events("build-intent:changed")).toHaveLength(0);
      const invalid = await putPrefs(user.web, "buildCheckin", [true]).expect(400);
      expect(invalid.body.error.code).toBe("invalid_body");
      expect(h.io.events("build-intent:changed")).toHaveLength(0);
    });

    test("a randomizer change is reflected in the options at once", async () => {
      const user = await newUser();
      const read = () => request(h.app)
        .get("/v1/build-intents/options?matchup=PvZ")
        .set("authorization", user.web)
        .expect(200);
      expect((await read()).body.randomizerEnabled).toBe(false);
      await putPrefs(user.web, "randomizer", randomizerPrefs("PvZ", [PHOENIX_KEY])).expect(200);
      const after = await read();
      expect(after.body.randomizerEnabled).toBe(true);
      expect(after.body.builds.find((b) => b.key === PHOENIX_KEY).inRandomizer).toBe(true);
      expect(h.io.events("build-intent:changed")).toHaveLength(0);
    });

    test("a failing ping never fails the save", async () => {
      const user = await newUser();
      jest.spyOn(h.services.buildIntents, "preferencesChanged").mockImplementationOnce(() => {
        throw new Error("io down");
      });
      const res = await putPrefs(user.web, "buildCheckin", { askAfterGame: false }).expect(200);
      expect(res.body).toEqual({ enabled: false, askAtLoading: false, askAfterGame: false });
    });
  });

  test("an unchanged label sends no games:changed", async () => {
    const user = await newUser();
    await addGame(h.db, user.userId, "notes-only", { myBuild: UNCLASSIFIED });
    await putIntent(user.web, "notes-only", { action: "notes", notes: "just notes" }).expect(200);
    expect(h.io.events("games:changed")).toHaveLength(0);
    expect(h.io.events("build-intent:changed").map((e) => e.payload)).toEqual([{ gameId: "notes-only" }]);
  });
});
