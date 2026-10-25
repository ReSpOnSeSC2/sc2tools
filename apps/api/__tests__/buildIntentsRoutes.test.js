// @ts-nocheck
/* eslint-disable max-lines-per-function */
"use strict";

/**
 * Build check-in HTTP surface on stored games: build options per matchup,
 * GET/PUT /v1/games/:gameId/build-intent, the pending queue and the
 * ``buildCheckin`` preference. Full app (real Mongo, real auth middleware
 * with a mocked Clerk verifier, fake Socket.io recording emits).
 */

jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());

const request = require("supertest");
const {
  HOUR_MS,
  DAY_MS,
  startFullApp,
  signIn,
  randomizerPrefs,
  setPrefs,
  addCustomBuild,
  addGame,
} = require("./helpers/buildIntentHarness");

const UNCLASSIFIED = "PvZ - Macro Transition (Unclassified)";
const PHOENIX = "PvZ - 2 Stargate Phoenix";
const PHOENIX_KEY = "pvz-2-stargate-phoenix";
const ROBO_KEY = "pvz-robo-opener";

/** @param {number} hours */
function hoursAgo(hours) {
  return new Date(Date.now() - hours * HOUR_MS);
}

describe("build check-in routes", () => {
  let h;
  let userCounter = 0;

  beforeAll(async () => {
    h = await startFullApp("build_intent_routes_test");
  });

  afterAll(async () => {
    if (h) await h.stop();
  });

  beforeEach(() => {
    h.io.clear();
  });

  async function newUser() {
    userCounter += 1;
    return signIn(h.app, h.db, `routes${userCounter}`);
  }

  function getIntent(user, gameId, query = "") {
    return request(h.app)
      .get(`/v1/games/${encodeURIComponent(gameId)}/build-intent${query}`)
      .set("authorization", user.web);
  }

  function putIntent(auth, gameId, body) {
    return request(h.app)
      .put(`/v1/games/${encodeURIComponent(gameId)}/build-intent`)
      .set("authorization", auth)
      .send(body);
  }

  describe("GET /v1/build-intents/options", () => {
    test("lists fitting custom builds and catalog builds with records, flags and order", async () => {
      const user = await newUser();
      const { userId } = user;
      await addCustomBuild(h.db, userId, "dt-rush", {
        name: "DT Rush",
        rules: [{ type: "before", name: "BuildDarkShrine", time_lt: 300 }],
      });
      await addCustomBuild(h.db, userId, "any-opener", { name: "Any Opener", vsRace: "Any" });
      await addCustomBuild(h.db, userId, "null-vs", { name: "Null vs", vsRace: null });
      await addCustomBuild(h.db, userId, "empty-vs", { name: "Empty vs", vsRace: "" });
      await addCustomBuild(h.db, userId, "vs-terran", { name: "Vs Terran", vsRace: "Terran" });
      await addCustomBuild(h.db, userId, "zerg-build", { name: "Zerg Build", race: "Zerg" });
      await addCustomBuild(h.db, userId, "their-build", { name: "Their Build", perspective: "opponent" });
      await addCustomBuild(h.db, userId, "gone", { name: "Gone", deletedAt: new Date() });
      await addGame(h.db, userId, "g1", {
        myBuild: "DT Rush", _customBuildSlug: "dt-rush", result: "Victory", date: hoursAgo(1),
      });
      await addGame(h.db, userId, "g2", {
        myBuild: "DT Rush", _customBuildSlug: "dt-rush", result: "Defeat", date: hoursAgo(2),
      });
      await addGame(h.db, userId, "g3", { myBuild: PHOENIX, result: "Victory", date: hoursAgo(3) });
      await addGame(h.db, userId, "g4", {
        myBuild: PHOENIX,
        result: "Defeat",
        date: hoursAgo(4),
        buildIntent: {
          status: "confirmed",
          applied: true,
          build: { key: PHOENIX_KEY, name: PHOENIX, slug: null, source: "catalog" },
          detected: { name: UNCLASSIFIED, slug: null },
          notes: "",
        },
      });
      await addGame(h.db, userId, "g5", { myBuild: PHOENIX, isResumedFromReplay: true });
      await addGame(h.db, userId, "g6", { myBuild: PHOENIX, opponent: { race: "Terran" } });
      await setPrefs(h.db, userId, {
        randomizer: randomizerPrefs("PvZ", [ROBO_KEY, "custom:any-opener", "not-a-build"]),
      });

      const res = await request(h.app)
        .get("/v1/build-intents/options?matchup=PvZ")
        .set("authorization", user.web)
        .expect(200);

      expect(res.headers["cache-control"]).toBe("private, no-store");
      expect(res.body.matchup).toBe("PvZ");
      expect(res.body.randomizerEnabled).toBe(true);
      expect(res.body.usualKey).toBe("custom:dt-rush");
      const byKey = new Map(res.body.builds.map((b) => [b.key, b]));
      for (const key of ["custom:vs-terran", "custom:zerg-build", "custom:their-build", "custom:gone"]) {
        expect(byKey.has(key)).toBe(false);
      }
      expect([...byKey.keys()].some((key) => /unclassified/.test(key))).toBe(false);
      expect(byKey.get("custom:dt-rush")).toEqual({
        key: "custom:dt-rush",
        name: "DT Rush",
        slug: "dt-rush",
        source: "custom",
        games: 2,
        wins: 1,
        losses: 1,
        checkins: 0,
        lastPlayedAt: expect.any(String),
        inRandomizer: false,
        group: "yours",
        ruleCount: 1,
      });
      expect(byKey.get(PHOENIX_KEY)).toEqual(expect.objectContaining({
        name: PHOENIX, slug: null, source: "catalog", games: 2, wins: 1, losses: 1, checkins: 1, group: "yours",
      }));
      expect(byKey.get(PHOENIX_KEY)).not.toHaveProperty("ruleCount");
      expect(byKey.get(ROBO_KEY)).toEqual(expect.objectContaining({
        games: 0, inRandomizer: true, group: "yours", lastPlayedAt: null,
      }));
      expect(byKey.get("custom:any-opener")).toEqual(expect.objectContaining({
        inRandomizer: true, ruleCount: 0, group: "yours",
      }));
      expect(byKey.get("custom:null-vs").group).toBe("yours");
      expect(byKey.get("custom:empty-vs").group).toBe("yours");
      expect(byKey.get("pvz-stargate-opener").group).toBe("all");

      const keys = res.body.builds.map((b) => b.key);
      expect(keys.slice(0, 6)).toEqual([
        "custom:dt-rush",
        PHOENIX_KEY,
        "custom:any-opener",
        "custom:empty-vs",
        "custom:null-vs",
        ROBO_KEY,
      ]);
      const catalogNames = res.body.builds.filter((b) => b.group === "all").map((b) => b.name);
      expect(catalogNames).toEqual([...catalogNames].sort((a, b) => a.localeCompare(b)));
    });

    test("counts 8-worker-patch pool openers under the era-neutral name", async () => {
      const user = await newUser();
      const zerg = { myRace: "Zerg", opponent: { race: "Protoss", displayName: "Opp" } };
      await addGame(h.db, user.userId, "z1", {
        ...zerg, myBuild: "ZvP - 8 Pool Rush", gameVersion: "5.0.16.97425",
      });
      await addGame(h.db, user.userId, "z2", { ...zerg, myBuild: "ZvP - 12 Pool Rush", result: "Defeat" });
      const res = await request(h.app)
        .get("/v1/build-intents/options?matchup=ZvP")
        .set("authorization", user.web)
        .expect(200);
      const pool = res.body.builds.find((b) => b.key === "zvp-12-pool-rush");
      expect(pool).toEqual(expect.objectContaining({ name: "ZvP - 12 Pool Rush", games: 2, wins: 1, losses: 1 }));
      expect(res.body.builds.some((b) => /8-pool/.test(b.key))).toBe(false);
      expect(res.body.randomizerEnabled).toBe(false);
      expect(res.body.usualKey).toBe("zvp-12-pool-rush");
    });

    test("rejects anything but a concrete matchup", async () => {
      const user = await newUser();
      for (const query of ["?matchup=PvX", "?matchup=pvz", "?matchup=PvR", ""]) {
        const res = await request(h.app)
          .get(`/v1/build-intents/options${query}`)
          .set("authorization", user.web)
          .expect(400);
        expect(res.body.error.code).toBe("invalid_matchup");
      }
    });

    test("a check-in write drops the cached records", async () => {
      const user = await newUser();
      await addGame(h.db, user.userId, "cache-1", { myBuild: UNCLASSIFIED });
      const before = await request(h.app)
        .get("/v1/build-intents/options?matchup=PvZ")
        .set("authorization", user.web)
        .expect(200);
      expect(before.body.builds.find((b) => b.key === PHOENIX_KEY).games).toBe(0);
      await putIntent(user.web, "cache-1", { action: "confirm", buildKey: PHOENIX_KEY }).expect(200);
      const after = await request(h.app)
        .get("/v1/build-intents/options?matchup=PvZ")
        .set("authorization", user.web)
        .expect(200);
      expect(after.body.builds.find((b) => b.key === PHOENIX_KEY)).toEqual(expect.objectContaining({
        games: 1, checkins: 1, group: "yours",
      }));
    });

    test("requires authentication", async () => {
      await request(h.app).get("/v1/build-intents/options?matchup=PvZ").expect(401);
    });
  });

  describe("GET /v1/games/:gameId/build-intent", () => {
    test("reports an undecided game with a computed (unsaved) suggestion", async () => {
      const user = await newUser();
      await addGame(h.db, user.userId, "plain", { myBuild: PHOENIX, durationSec: 842 });
      const res = await getIntent(user, "plain").expect(200);
      expect(res.headers["cache-control"]).toBe("private, no-store");
      expect(res.body).toEqual(expect.objectContaining({
        gameId: "plain",
        matchup: "PvZ",
        myRace: "Protoss",
        oppRace: "Zerg",
        oppName: "Opp",
        result: "Victory",
        durationSec: 842,
        map: "Site Delta LE",
        eligible: true,
        ineligibleReason: null,
        status: "none",
        applied: false,
        build: null,
        randomizer: null,
        randomizerDeviated: false,
        executed: false,
        notes: "",
        origin: null,
        via: null,
        confirmedAt: null,
        updatedAt: null,
        prefs: { enabled: true, askAtLoading: true, askAfterGame: true },
      }));
      expect(res.body.detected).toEqual({ name: PHOENIX, slug: null, key: PHOENIX_KEY });
      expect(res.body.suggestion).toEqual({
        key: PHOENIX_KEY,
        name: PHOENIX,
        slug: null,
        source: "catalog",
        reason: "detected",
        passedRules: null,
        ruleCount: null,
      });
      expect(res.body).not.toHaveProperty("options");
      const row = await h.db.games.findOne({ userId: user.userId, gameId: "plain" });
      expect(row.buildIntent).toBeUndefined();
    });

    test("include=options adds the matchup's options and usual build", async () => {
      const user = await newUser();
      await addGame(h.db, user.userId, "with-options");
      const res = await getIntent(user, "with-options", "?include=options").expect(200);
      expect(Array.isArray(res.body.options)).toBe(true);
      expect(res.body.options.some((b) => b.key === PHOENIX_KEY)).toBe(true);
      expect(res.body).toHaveProperty("usualKey", null);
    });

    test.each([
      ["resumed", { isResumedFromReplay: true }],
      ["not_1v1", { matchFormat: "team" }],
      ["not_1v1", { opponent: null }],
      ["no_matchup", { opponent: { race: "Random", displayName: "R" } }],
      ["too_short", { durationSec: 30 }],
      ["too_short", { myBuild: "PvZ - Game Too Short" }],
    ])("reports ineligible games (%s)", async (reason, fields) => {
      const user = await newUser();
      await addGame(h.db, user.userId, "inel", fields);
      const res = await getIntent(user, "inel").expect(200);
      expect(res.body.eligible).toBe(false);
      expect(res.body.ineligibleReason).toBe(reason);
      expect(res.body.suggestion).toBeNull();
    });

    test("404s for unknown and foreign games", async () => {
      const owner = await newUser();
      const other = await newUser();
      await addGame(h.db, owner.userId, "mine");
      expect((await getIntent(other, "mine").expect(404)).body.error.code).toBe("not_found");
      expect((await getIntent(owner, "nope").expect(404)).body.error.code).toBe("not_found");
    });
  });

  describe("PUT /v1/games/:gameId/build-intent", () => {
    test("confirm applies the build as the effective label and emits", async () => {
      const user = await newUser();
      await addGame(h.db, user.userId, "confirm-me", { myBuild: UNCLASSIFIED });
      const res = await putIntent(user.web, "confirm-me", {
        action: "confirm", buildKey: PHOENIX_KEY, notes: "  Got scouted \u0007 early ",
      }).expect(200);
      expect(res.headers["cache-control"]).toBe("private, no-store");
      expect(res.body).toEqual(expect.objectContaining({
        status: "confirmed",
        applied: true,
        build: { key: PHOENIX_KEY, name: PHOENIX, slug: null, source: "catalog" },
        detected: { name: UNCLASSIFIED, slug: null, key: null },
        executed: false,
        notes: "Got scouted  early",
        origin: "web",
        via: "web",
        confirmedAt: expect.any(String),
      }));
      expect(res.body).not.toHaveProperty("options");
      const row = await h.db.games.findOne({ userId: user.userId, gameId: "confirm-me" });
      expect(row.myBuild).toBe(PHOENIX);
      expect(row.buildIntent.detected).toEqual({ name: UNCLASSIFIED, slug: null });
      expect(row.buildIntent).not.toHaveProperty("gameKey");
      expect(row._schemaVersion).toBe(8);
      expect(h.io.events("games:changed")).toEqual([
        { room: `user:${user.userId}`, event: "games:changed", payload: { count: 1, inserted: 0, bulk: false, reason: "build_intent" } },
      ]);
      expect(h.io.events("build-intent:changed")).toEqual([
        { room: `user:${user.userId}`, event: "build-intent:changed", payload: { gameId: "confirm-me" } },
      ]);
    });

    test("via/origin come from the credential (device token = agent)", async () => {
      const user = await newUser();
      await addGame(h.db, user.userId, "agent-confirm");
      const res = await putIntent(user.device, "agent-confirm", {
        action: "confirm", buildKey: ROBO_KEY,
      }).expect(200);
      expect(res.body.via).toBe("agent");
      expect(res.body.origin).toBe("postgame");
    });

    test("changing a confirmed build keeps the classifier's label; skip restores it", async () => {
      const user = await newUser();
      await addGame(h.db, user.userId, "change-me", { myBuild: UNCLASSIFIED });
      await putIntent(user.web, "change-me", { action: "confirm", buildKey: PHOENIX_KEY, notes: "keep me" }).expect(200);
      await putIntent(user.web, "change-me", { action: "confirm", buildKey: ROBO_KEY }).expect(200);
      let row = await h.db.games.findOne({ userId: user.userId, gameId: "change-me" });
      expect(row.myBuild).toBe("PvZ - Robo Opener");
      expect(row.buildIntent.detected).toEqual({ name: UNCLASSIFIED, slug: null });
      h.io.clear();
      const res = await putIntent(user.web, "change-me", { action: "skip" }).expect(200);
      expect(res.body).toEqual(expect.objectContaining({
        status: "skipped", applied: false, build: null, notes: "keep me", confirmedAt: null,
      }));
      row = await h.db.games.findOne({ userId: user.userId, gameId: "change-me" });
      expect(row.myBuild).toBe(UNCLASSIFIED);
      expect(row._customBuildSlug).toBeUndefined();
      expect(h.io.events("games:changed")).toHaveLength(1);
    });

    test("skip on a custom-tagged override restores the detected slug and unsets a missing one", async () => {
      const user = await newUser();
      await addCustomBuild(h.db, user.userId, "my-dt", { name: "My DT" });
      await addGame(h.db, user.userId, "cust", { myBuild: "Old Custom", _customBuildSlug: "old-custom" });
      await putIntent(user.web, "cust", { action: "confirm", buildKey: "custom:my-dt" }).expect(200);
      let row = await h.db.games.findOne({ userId: user.userId, gameId: "cust" });
      expect(row.myBuild).toBe("My DT");
      expect(row._customBuildSlug).toBe("my-dt");
      expect(row.buildIntent.detected).toEqual({ name: "Old Custom", slug: "old-custom" });
      await putIntent(user.web, "cust", { action: "skip" }).expect(200);
      row = await h.db.games.findOne({ userId: user.userId, gameId: "cust" });
      expect(row.myBuild).toBe("Old Custom");
      expect(row._customBuildSlug).toBe("old-custom");

      await addGame(h.db, user.userId, "no-label", { myBuild: undefined });
      await h.db.games.updateOne({ userId: user.userId, gameId: "no-label" }, { $unset: { myBuild: "" } });
      await putIntent(user.web, "no-label", { action: "confirm", buildKey: "custom:my-dt" }).expect(200);
      await putIntent(user.web, "no-label", { action: "skip" }).expect(200);
      row = await h.db.games.findOne({ userId: user.userId, gameId: "no-label" });
      expect(row).not.toHaveProperty("myBuild");
      expect(row).not.toHaveProperty("_customBuildSlug");
    });

    test("generic labels and unknown keys are refused", async () => {
      const user = await newUser();
      await addGame(h.db, user.userId, "generic", { myBuild: UNCLASSIFIED });
      for (const buildKey of ["pvz-macro-transition-unclassified", "pvz-game-too-short", "tvz-3-rax-marine", "custom:nope", "Not A Key"]) {
        const res = await putIntent(user.web, "generic", { action: "confirm", buildKey }).expect(400);
        expect(res.body.error.code).toBe("unknown_build");
      }
      const missing = await putIntent(user.web, "generic", { action: "confirm" }).expect(400);
      expect(missing.body.error.code).toBe("unknown_build");
    });

    test("confirm accepts the game's randomizer roll even when it is no longer an option", async () => {
      const user = await newUser();
      const roll = { key: "custom:retired", name: "Retired Roll", slug: "retired", source: "custom" };
      await addGame(h.db, user.userId, "rolled", {
        buildIntent: {
          status: "pending", build: null, applied: false, detected: null, suggestion: null,
          randomizer: roll, origin: null, via: null, notes: "", confirmedAt: null, updatedAt: new Date(),
        },
      });
      const res = await putIntent(user.web, "rolled", { action: "confirm", buildKey: "custom:retired" }).expect(200);
      expect(res.body.build).toEqual({ ...roll, deleted: true });
      expect(res.body.randomizer).toEqual(roll);
      const row = await h.db.games.findOne({ userId: user.userId, gameId: "rolled" });
      expect(row.myBuild).toBe("Retired Roll");
      expect(row._customBuildSlug).toBe("retired");
    });

    test("ineligible games refuse confirm and defer with the reason; notes still work", async () => {
      const user = await newUser();
      await addGame(h.db, user.userId, "short", { durationSec: 20 });
      for (const action of ["confirm", "defer"]) {
        const res = await putIntent(user.web, "short", { action, buildKey: PHOENIX_KEY }).expect(409);
        expect(res.body.error).toEqual(expect.objectContaining({ code: "not_eligible", reason: "too_short" }));
      }
      await putIntent(user.web, "short", { action: "notes", notes: "left early" }).expect(200);
      const row = await h.db.games.findOne({ userId: user.userId, gameId: "short" });
      expect(row.buildIntent.status).toBe("none");
      expect(row.myBuild).toBe(UNCLASSIFIED);
    });

    test("notes create a status-none record and are sanitised and bounded", async () => {
      const user = await newUser();
      await addGame(h.db, user.userId, "noted");
      const res = await putIntent(user.web, "noted", { action: "notes", notes: "\u0000 Proxy gate \n scouted \u001F " }).expect(200);
      expect(res.body.status).toBe("none");
      expect(res.body.notes).toBe("Proxy gate \n scouted");
      const row = await h.db.games.findOne({ userId: user.userId, gameId: "noted" });
      expect(row.buildIntent).toEqual({
        status: "none",
        build: null,
        applied: false,
        detected: null,
        suggestion: null,
        randomizer: null,
        origin: null,
        via: null,
        notes: "Proxy gate \n scouted",
        confirmedAt: null,
        updatedAt: expect.any(Date),
      });
      const tooLong = await putIntent(user.web, "noted", { action: "notes", notes: "x".repeat(1001) }).expect(400);
      expect(tooLong.body.error.code).toBe("invalid_notes");
      const notString = await putIntent(user.web, "noted", { action: "notes", notes: 42 }).expect(400);
      expect(notString.body.error.code).toBe("invalid_notes");
      const missing = await putIntent(user.web, "noted", { action: "notes" }).expect(400);
      expect(missing.body.error.code).toBe("invalid_notes");
      const bogus = await putIntent(user.web, "noted", { action: "explode" }).expect(400);
      expect(bogus.body.error.code).toBe("invalid_action");
      const extra = await putIntent(user.web, "noted", { action: "skip", via: "agent" }).expect(400);
      expect(extra.body.error.code).toBe("invalid_request");
      await putIntent(user.web, "noted", { action: "notes", notes: "y".repeat(1000) }).expect(200);
    });

    test("defer makes an undecided game pending and never undoes a decision", async () => {
      const user = await newUser();
      await addGame(h.db, user.userId, "later");
      const deferred = await putIntent(user.device, "later", { action: "defer", notes: "typed before Later" }).expect(200);
      expect(deferred.body.status).toBe("pending");
      expect(deferred.body.notes).toBe("typed before Later");
      await putIntent(user.web, "later", { action: "confirm", buildKey: PHOENIX_KEY }).expect(200);
      const again = await putIntent(user.device, "later", { action: "defer", notes: "second thought" }).expect(200);
      expect(again.body.status).toBe("confirmed");
      expect(again.body.applied).toBe(true);
      expect(again.body.notes).toBe("second thought");
    });

    test("a confirmed custom build that was deleted is reported as deleted", async () => {
      const user = await newUser();
      await addCustomBuild(h.db, user.userId, "short-lived", { name: "Short Lived" });
      await addGame(h.db, user.userId, "frozen");
      await putIntent(user.web, "frozen", { action: "confirm", buildKey: "custom:short-lived" }).expect(200);
      await h.db.customBuilds.updateOne({ userId: user.userId, slug: "short-lived" }, { $set: { deletedAt: new Date() } });
      const res = await getIntent(user, "frozen").expect(200);
      expect(res.body.build).toEqual({
        key: "custom:short-lived", name: "Short Lived", slug: "short-lived", source: "custom", deleted: true,
      });
      expect(res.body.executed).toBe(false);
    });

    test("catalog names follow the game's patch era", async () => {
      const user = await newUser();
      await addGame(h.db, user.userId, "eight-worker", {
        myRace: "Zerg",
        opponent: { race: "Protoss", displayName: "Opp" },
        myBuild: "ZvP - Hatch First Macro",
        gameVersion: "5.0.16.97425",
      });
      const res = await putIntent(user.web, "eight-worker", { action: "confirm", buildKey: "zvp-12-pool-rush" }).expect(200);
      expect(res.body.build.name).toBe("ZvP - 8 Pool Rush");
      expect(res.body.build.key).toBe("zvp-12-pool-rush");
      const row = await h.db.games.findOne({ userId: user.userId, gameId: "eight-worker" });
      expect(row.myBuild).toBe("ZvP - 8 Pool Rush");
    });

    test("executed is true when the replay landed on the confirmed build", async () => {
      const user = await newUser();
      await addGame(h.db, user.userId, "landed", { myBuild: PHOENIX });
      const res = await putIntent(user.web, "landed", { action: "confirm", buildKey: PHOENIX_KEY }).expect(200);
      expect(res.body.executed).toBe(true);
      expect(res.body.detected).toEqual({ name: PHOENIX, slug: null, key: PHOENIX_KEY });
      expect(h.io.events("games:changed")).toHaveLength(0);
      expect(h.io.events("build-intent:changed")).toHaveLength(1);
    });
  });

  describe("pending queue", () => {
    async function pendingGame(userId, gameId, fields = {}) {
      await addGame(h.db, userId, gameId, {
        buildIntent: {
          status: "pending",
          build: null,
          applied: false,
          detected: null,
          suggestion: { key: ROBO_KEY, name: "PvZ - Robo Opener", slug: null, source: "catalog", reason: "usual", passedRules: null, ruleCount: null },
          randomizer: null,
          origin: null,
          via: null,
          notes: "",
          confirmedAt: null,
          updatedAt: new Date(),
          gameKey: `Opp|Me|${gameId.length}`,
        },
        ...fields,
      });
    }

    test("lists pending games of the last 72 h newest first, from the cache", async () => {
      const user = await newUser();
      await pendingGame(user.userId, "p-new", { date: hoursAgo(1) });
      await pendingGame(user.userId, "p-mid", { date: hoursAgo(30) });
      await pendingGame(user.userId, "p-old", { date: new Date(Date.now() - 4 * DAY_MS) });
      await pendingGame(user.userId, "p-resumed", { date: hoursAgo(2), isResumedFromReplay: true });
      await addGame(h.db, user.userId, "p-none", { date: hoursAgo(1) });
      const res = await request(h.app)
        .get("/v1/build-intents/pending")
        .set("authorization", user.web)
        .expect(200);
      expect(res.headers["cache-control"]).toBe("private, no-store");
      expect(res.body.disabled).toBe(false);
      expect(res.body.total).toBe(2);
      expect(res.body.items.map((i) => i.gameId)).toEqual(["p-new", "p-mid"]);
      expect(res.body.items[0].suggestion).toEqual(expect.objectContaining({ key: ROBO_KEY, reason: "usual" }));
      expect(res.body.items[0]).not.toHaveProperty("options");

      const limited = await request(h.app)
        .get("/v1/build-intents/pending?limit=1")
        .set("authorization", user.web)
        .expect(200);
      expect(limited.body.items).toHaveLength(1);
      expect(limited.body.total).toBe(2);
      for (const limit of ["0", "-3", "abc", "999"]) {
        const clamped = await request(h.app)
          .get(`/v1/build-intents/pending?limit=${limit}`)
          .set("authorization", user.web)
          .expect(200);
        expect(clamped.body.items.length).toBeGreaterThanOrEqual(1);
      }
    });

    test("a pending game without a cached suggestion gets one from its label", async () => {
      const user = await newUser();
      await pendingGame(user.userId, "p-label", { myBuild: PHOENIX });
      await h.db.games.updateOne({ userId: user.userId, gameId: "p-label" }, { $set: { "buildIntent.suggestion": null } });
      const res = await request(h.app).get("/v1/build-intents/pending").set("authorization", user.web).expect(200);
      expect(res.body.items[0].suggestion).toEqual(expect.objectContaining({ key: PHOENIX_KEY, reason: "detected" }));
    });

    test("is empty and flagged when check-ins are off", async () => {
      const user = await newUser();
      await pendingGame(user.userId, "p-off", { date: hoursAgo(1) });
      await setPrefs(h.db, user.userId, { buildCheckin: { enabled: false } });
      const res = await request(h.app).get("/v1/build-intents/pending").set("authorization", user.web).expect(200);
      expect(res.body).toEqual({ items: [], total: 0, disabled: true });
    });

    test("dismiss skips every pending game of the window", async () => {
      const user = await newUser();
      await pendingGame(user.userId, "d-1", { date: hoursAgo(1) });
      await pendingGame(user.userId, "d-2", { date: hoursAgo(5) });
      await pendingGame(user.userId, "d-old", { date: new Date(Date.now() - 4 * DAY_MS) });
      const res = await request(h.app)
        .post("/v1/build-intents/pending/dismiss")
        .set("authorization", user.web)
        .expect(200);
      expect(res.headers["cache-control"]).toBe("private, no-store");
      expect(res.body).toEqual({ dismissed: 2 });
      const rows = await h.db.games.find({ userId: user.userId }).toArray();
      const status = Object.fromEntries(rows.map((r) => [r.gameId, r.buildIntent.status]));
      expect(status).toEqual({ "d-1": "skipped", "d-2": "skipped", "d-old": "pending" });
      expect(rows.find((r) => r.gameId === "d-1").buildIntent).toEqual(expect.objectContaining({
        origin: "web", via: "web", build: null, applied: false,
      }));
      expect(h.io.events("build-intent:changed").map((e) => e.payload)).toEqual([
        { gameId: "d-1" }, { gameId: "d-2" },
      ]);
      const again = await request(h.app)
        .post("/v1/build-intents/pending/dismiss")
        .set("authorization", user.web)
        .expect(200);
      expect(again.body).toEqual({ dismissed: 0 });
    });
  });

  describe("buildCheckin preference", () => {
    test("GET returns the defaults and PUT stores exactly three booleans", async () => {
      const user = await signIn(h.app, h.db, "quiet-defaults", { enableCheckins: false });
      const empty = await request(h.app)
        .get("/v1/me/preferences/buildCheckin")
        .set("authorization", user.web)
        .expect(200);
      expect(empty.body).toEqual({ enabled: false, askAtLoading: false, askAfterGame: false });
      const saved = await request(h.app)
        .put("/v1/me/preferences/buildCheckin")
        .set("authorization", user.device)
        .send({ enabled: false, askAtLoading: "no", junk: { nested: true } })
        .expect(200);
      expect(saved.body).toEqual({ enabled: false, askAtLoading: false, askAfterGame: false });
      const row = await h.db.users.findOne({ userId: user.userId });
      expect(row.preferences.buildCheckin).toEqual({ enabled: false, askAtLoading: false, askAfterGame: false });
      const read = await request(h.app)
        .get("/v1/me/preferences/buildCheckin")
        .set("authorization", user.web)
        .expect(200);
      expect(read.body).toEqual({ enabled: false, askAtLoading: false, askAfterGame: false });
    });
  });
});
