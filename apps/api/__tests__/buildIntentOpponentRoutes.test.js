// @ts-nocheck
/* eslint-disable max-lines-per-function */
"use strict";

/**
 * Build check-in, opponent's build: ``GET /v1/build-intents/options?side=
 * opponent``, the ``opponent`` block of ``GameIntentState`` and
 * ``opponentBuildKey`` / ``action: "opponent"`` on
 * ``PUT /v1/games/:gameId/build-intent``. Also the "Add new build" path: a
 * custom build saved a moment ago is listed and confirmable at once, on
 * both axes. Full app, real Mongo.
 */

jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());

const request = require("supertest");
const {
  HOUR_MS,
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
const POOL = "Zerg - 12 Pool";
const POOL_KEY = "zerg-12-pool";
const BANE = "ZvP - Ling Bane Bust";
const BANE_KEY = "zvp-ling-bane-bust";
const OPP_GENERIC = "Zerg - Standard Play (Unclassified)";

/** A Zerg opponent with a classified strategy, on the 12-worker patch. */
function vsZerg(strategy, extra = {}) {
  return {
    opponent: { displayName: "Opp", race: "Zerg", pulseId: "p-1", strategy },
    gameVersion: "5.0.17.98000",
    ...extra,
  };
}

/** An opponent-perspective custom build (their race Zerg, mine Protoss). */
function theirBuild(fields = {}) {
  return { race: "Zerg", vsRace: "Protoss", perspective: "opponent", ...fields };
}

describe("build check-in: the opponent's build", () => {
  let h;
  let userCounter = 0;

  beforeAll(async () => {
    h = await startFullApp("build_intent_opponent_routes_test");
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
    return signIn(h.app, h.db, `opp${userCounter}`);
  }

  function options(user, matchup, side) {
    const query = side === undefined ? "" : `&side=${side}`;
    return request(h.app)
      .get(`/v1/build-intents/options?matchup=${matchup}${query}`)
      .set("authorization", user.web);
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

  function gameRow(user, gameId) {
    return h.db.games.findOne({ userId: user.userId, gameId });
  }

  function saveBuild(user, slug, body) {
    return request(h.app)
      .put(`/v1/custom-builds/${slug}`)
      .set("authorization", user.web)
      .send({ race: "Protoss", vsRace: "Zerg", reclassify: false, ...body });
  }

  describe("GET /v1/build-intents/options?side=opponent", () => {
    test("lists the matchup's opponent strategies and fitting opponent builds with records", async () => {
      const user = await newUser();
      const { userId } = user;
      await addCustomBuild(h.db, userId, "their-roach", theirBuild({
        name: "Their Roach Rush",
        rules: [{ type: "before", name: "BuildRoachWarren", time_lt: 200 }],
      }));
      await addCustomBuild(h.db, userId, "their-any", theirBuild({ name: "Their Any", vsRace: "Any" }));
      await addCustomBuild(h.db, userId, "their-null", theirBuild({ name: "Their Null", vsRace: null }));
      await addCustomBuild(h.db, userId, "their-vs-terran", theirBuild({ name: "Vs Terran", vsRace: "Terran" }));
      await addCustomBuild(h.db, userId, "their-protoss", theirBuild({ name: "Protoss Read", race: "Protoss" }));
      await addCustomBuild(h.db, userId, "their-gone", theirBuild({ name: "Gone", deletedAt: new Date() }));
      await addCustomBuild(h.db, userId, "my-build", { name: "My Build" });
      await addGame(h.db, userId, "o1", vsZerg(POOL, { result: "Victory" }));
      await addGame(h.db, userId, "o2", vsZerg("Zerg - 8 Pool", { result: "Defeat", gameVersion: "5.0.16.97425" }));
      await addGame(h.db, userId, "o3", vsZerg("Their Roach Rush", { _customOpponentStrategySlug: "their-roach" }));
      await addGame(h.db, userId, "o4", vsZerg(BANE, {
        result: "Defeat",
        buildIntent: {
          status: "none",
          notes: "",
          opponent: {
            status: "confirmed",
            applied: true,
            build: { key: BANE_KEY, name: BANE, slug: null, source: "catalog" },
            detected: { name: OPP_GENERIC, slug: null },
          },
        },
      }));
      await addGame(h.db, userId, "o5", vsZerg(POOL, { isResumedFromReplay: true }));
      await addGame(h.db, userId, "o6", { opponent: { race: "Terran", displayName: "T", strategy: POOL } });
      await setPrefs(h.db, userId, { randomizer: randomizerPrefs("PvZ", [PHOENIX_KEY]) });

      const res = await options(user, "PvZ", "opponent").expect(200);
      expect(res.headers["cache-control"]).toBe("private, no-store");
      expect(res.body).toEqual(expect.objectContaining({
        matchup: "PvZ", side: "opponent", randomizerEnabled: false, usualKey: null,
      }));
      const byKey = new Map(res.body.builds.map((b) => [b.key, b]));
      for (const key of ["custom:their-vs-terran", "custom:their-protoss", "custom:their-gone", "custom:my-build"]) {
        expect(byKey.has(key)).toBe(false);
      }
      for (const key of byKey.keys()) {
        expect(key).not.toMatch(/unclassified|^pvz-|8-pool/);
      }
      expect(res.body.builds.every((b) => b.inRandomizer === false)).toBe(true);
      expect(byKey.get("custom:their-roach")).toEqual({
        key: "custom:their-roach",
        name: "Their Roach Rush",
        slug: "their-roach",
        source: "custom",
        games: 1,
        wins: 1,
        losses: 0,
        checkins: 0,
        lastPlayedAt: expect.any(String),
        inRandomizer: false,
        group: "yours",
        ruleCount: 1,
      });
      expect(byKey.get(POOL_KEY)).toEqual(expect.objectContaining({
        name: POOL, source: "catalog", games: 2, wins: 1, losses: 1, checkins: 0, group: "yours",
      }));
      expect(byKey.get(POOL_KEY)).not.toHaveProperty("ruleCount");
      expect(byKey.get(BANE_KEY)).toEqual(expect.objectContaining({ games: 1, losses: 1, checkins: 1, group: "yours" }));
      expect(byKey.get("custom:their-any").group).toBe("yours");
      expect(byKey.get("custom:their-null").group).toBe("yours");
      expect(byKey.get("zerg-proxy-hatch").group).toBe("all");
      const all = res.body.builds.filter((b) => b.group === "all").map((b) => b.name);
      expect(all).toEqual([...all].sort((a, b) => a.localeCompare(b)));
    });

    test("the opponent's catalog follows the user's matchup, not the opponent race's own builds", async () => {
      const user = await newUser();
      const res = await options(user, "ZvP", "opponent").expect(200);
      const keys = res.body.builds.map((b) => b.key);
      expect(keys).toHaveLength(14);
      expect(keys.every((key) => key.startsWith("protoss-"))).toBe(true);
      expect(keys).toContain("protoss-dt-rush");
    });

    test("the default side is the user's own builds; an unknown side is refused", async () => {
      const user = await newUser();
      const you = await options(user, "PvZ").expect(200);
      expect(you.body.side).toBe("you");
      expect(you.body.builds.some((b) => b.key === PHOENIX_KEY)).toBe(true);
      expect((await options(user, "PvZ", "you").expect(200)).body.side).toBe("you");
      for (const side of ["them", "", "OPPONENT"]) {
        const res = await options(user, "PvZ", side).expect(400);
        expect(res.body.error.code).toBe("invalid_side");
      }
    });

    test("both sides are cached separately and a check-in write drops both", async () => {
      const user = await newUser();
      await addGame(h.db, user.userId, "cache-game", vsZerg(POOL));
      await options(user, "PvZ", "you").expect(200);
      await options(user, "PvZ", "opponent").expect(200);
      await addCustomBuild(h.db, user.userId, "late-you", { name: "Late You" });
      await addCustomBuild(h.db, user.userId, "late-opp", theirBuild({ name: "Late Opp" }));
      const keysOf = async (side) => (await options(user, "PvZ", side).expect(200)).body.builds.map((b) => b.key);
      expect(await keysOf("you")).not.toContain("custom:late-you");
      expect(await keysOf("opponent")).not.toContain("custom:late-opp");
      expect(await keysOf("you")).not.toContain("custom:late-opp");
      await putIntent(user.web, "cache-game", { action: "notes", notes: "x" }).expect(200);
      expect(await keysOf("you")).toContain("custom:late-you");
      expect(await keysOf("opponent")).toContain("custom:late-opp");
      expect(await keysOf("opponent")).not.toContain("custom:late-you");
    });

    test("saving or deleting a custom build drops the cached options at once", async () => {
      const user = await newUser();
      await options(user, "PvZ", "you").expect(200);
      await options(user, "PvZ", "opponent").expect(200);
      await saveBuild(user, "fresh-you", { name: "Fresh You" }).expect(200);
      await saveBuild(user, "fresh-opp", {
        name: "Fresh Opp", race: "Zerg", vsRace: "Protoss", perspective: "opponent",
      }).expect(200);
      const you = (await options(user, "PvZ", "you").expect(200)).body.builds.map((b) => b.key);
      const opp = (await options(user, "PvZ", "opponent").expect(200)).body.builds.map((b) => b.key);
      expect(you).toContain("custom:fresh-you");
      expect(opp).toContain("custom:fresh-opp");
      await request(h.app).delete("/v1/custom-builds/fresh-opp").set("authorization", user.web).expect(204);
      const after = (await options(user, "PvZ", "opponent").expect(200)).body.builds.map((b) => b.key);
      expect(after).not.toContain("custom:fresh-opp");
    });
  });

  describe("GET /v1/games/:gameId/build-intent", () => {
    test("reports the opponent axis of an undecided game", async () => {
      const user = await newUser();
      await addGame(h.db, user.userId, "plain", vsZerg(POOL));
      const res = await getIntent(user, "plain").expect(200);
      expect(res.body.opponent).toEqual({
        label: POOL,
        status: "none",
        build: null,
        applied: false,
        detected: { name: POOL, slug: null, key: POOL_KEY },
        suggestion: {
          key: POOL_KEY, name: POOL, slug: null, source: "catalog", reason: "detected", passedRules: null, ruleCount: null,
        },
        executed: null,
      });
      const withOptions = await getIntent(user, "plain", "?include=options").expect(200);
      expect(withOptions.body.opponent.options.some((b) => b.key === BANE_KEY)).toBe(true);
      expect(withOptions.body.opponent.options.some((b) => b.key === PHOENIX_KEY)).toBe(false);
      expect(withOptions.body.options.some((b) => b.key === PHOENIX_KEY)).toBe(true);
    });

    test("suggests the closest opponent build by rules when the label is generic", async () => {
      const user = await newUser();
      await addCustomBuild(h.db, user.userId, "their-pool", theirBuild({
        name: "Their Pool First",
        rules: [{ type: "before", name: "BuildSpawningPool", time_lt: 90 }],
      }));
      await addGame(h.db, user.userId, "generic-opp", vsZerg(OPP_GENERIC, { oppBuildLog: ["[0:17] SpawningPool"] }));
      const res = await getIntent(user, "generic-opp").expect(200);
      expect(res.body.opponent.detected).toEqual({ name: OPP_GENERIC, slug: null, key: null });
      expect(res.body.opponent.suggestion).toEqual(expect.objectContaining({
        key: "custom:their-pool", reason: "rules", passedRules: 1, ruleCount: 1,
      }));
    });

    test("is null without a matchup and has no suggestion on an ineligible game", async () => {
      const user = await newUser();
      await addGame(h.db, user.userId, "random-opp", { opponent: { race: "Random", displayName: "R", strategy: POOL } });
      expect((await getIntent(user, "random-opp").expect(200)).body.opponent).toBeNull();
      await addGame(h.db, user.userId, "short-opp", vsZerg(POOL, { durationSec: 20 }));
      const short = await getIntent(user, "short-opp").expect(200);
      expect(short.body.opponent).toEqual(expect.objectContaining({ label: POOL, suggestion: null }));
    });
  });

  describe("PUT opponentBuildKey", () => {
    test("confirm and the opponent correction land in one update", async () => {
      const user = await newUser();
      await addGame(h.db, user.userId, "both", vsZerg(POOL, { myBuild: UNCLASSIFIED }));
      const updates = jest.spyOn(h.db.games, "updateOne");
      const res = await putIntent(user.web, "both", {
        action: "confirm", buildKey: PHOENIX_KEY, opponentBuildKey: BANE_KEY, notes: "they busted",
      }).expect(200);
      expect(updates).toHaveBeenCalledTimes(1);
      expect(res.body).toEqual(expect.objectContaining({ status: "confirmed", applied: true, notes: "they busted" }));
      expect(res.body.opponent).toEqual({
        label: BANE,
        status: "confirmed",
        build: { key: BANE_KEY, name: BANE, slug: null, source: "catalog" },
        applied: true,
        detected: { name: POOL, slug: null, key: POOL_KEY },
        suggestion: expect.objectContaining({ key: POOL_KEY, reason: "detected" }),
        executed: false,
      });
      const row = await gameRow(user, "both");
      expect(row.myBuild).toBe(PHOENIX);
      expect(row.opponent.strategy).toBe(BANE);
      expect(row).not.toHaveProperty("_customOpponentStrategySlug");
      expect(row.buildIntent.opponent).toEqual({
        status: "confirmed",
        applied: true,
        build: { key: BANE_KEY, name: BANE, slug: null, source: "catalog" },
        detected: { name: POOL, slug: null },
        origin: "web",
        via: "web",
        confirmedAt: expect.any(Date),
        updatedAt: expect.any(Date),
      });
      expect(row.buildIntent.detected).toEqual({ name: UNCLASSIFIED, slug: null });
      expect(h.io.events("games:changed")).toHaveLength(1);
      expect(h.io.events("build-intent:changed").map((e) => e.payload)).toEqual([{ gameId: "both" }]);
    });

    test("the opponent action changes only the opponent axis and still pings games:changed", async () => {
      const user = await newUser();
      await addGame(h.db, user.userId, "only-opp", vsZerg(POOL));
      const res = await putIntent(user.device, "only-opp", {
        action: "opponent", opponentBuildKey: BANE_KEY, notes: "read it wrong",
      }).expect(200);
      expect(res.body).toEqual(expect.objectContaining({
        status: "none", applied: false, build: null, notes: "read it wrong",
      }));
      expect(res.body.opponent).toEqual(expect.objectContaining({ label: BANE, status: "confirmed", applied: true }));
      const row = await gameRow(user, "only-opp");
      expect(row.myBuild).toBe(UNCLASSIFIED);
      expect(row.buildIntent).toEqual(expect.objectContaining({
        status: "none", build: null, applied: false, notes: "read it wrong",
      }));
      expect(row.buildIntent).not.toHaveProperty("gameKey");
      expect(row.buildIntent.opponent).toEqual(expect.objectContaining({ origin: "postgame", via: "agent" }));
      expect(h.io.events("games:changed")).toHaveLength(1);
    });

    test("null clears the correction and restores the detector's label exactly", async () => {
      const user = await newUser();
      await addCustomBuild(h.db, user.userId, "their-roach", theirBuild({ name: "Their Roach Rush" }));
      await addGame(h.db, user.userId, "restore", vsZerg("Old Read", { _customOpponentStrategySlug: "old-read" }));
      await putIntent(user.web, "restore", { action: "opponent", opponentBuildKey: "custom:their-roach" }).expect(200);
      let row = await gameRow(user, "restore");
      expect(row.opponent.strategy).toBe("Their Roach Rush");
      expect(row._customOpponentStrategySlug).toBe("their-roach");
      expect(row.buildIntent.opponent.detected).toEqual({ name: "Old Read", slug: "old-read" });
      // Changing the correction keeps the original detector label.
      await putIntent(user.web, "restore", { action: "opponent", opponentBuildKey: BANE_KEY }).expect(200);
      row = await gameRow(user, "restore");
      expect(row).not.toHaveProperty("_customOpponentStrategySlug");
      expect(row.buildIntent.opponent.detected).toEqual({ name: "Old Read", slug: "old-read" });
      h.io.clear();
      const res = await putIntent(user.web, "restore", { action: "skip", opponentBuildKey: null }).expect(200);
      expect(res.body.status).toBe("skipped");
      expect(res.body.opponent).toEqual(expect.objectContaining({
        label: "Old Read", status: "none", build: null, applied: false,
        detected: { name: "Old Read", slug: "old-read", key: null },
      }));
      row = await gameRow(user, "restore");
      expect(row.opponent.strategy).toBe("Old Read");
      expect(row._customOpponentStrategySlug).toBe("old-read");
      expect(row.buildIntent.opponent).toEqual({
        status: "none", build: null, applied: false, detected: null,
        origin: null, via: null, confirmedAt: null, updatedAt: expect.any(Date),
      });
      expect(h.io.events("games:changed")).toHaveLength(1);

      await addGame(h.db, user.userId, "no-strategy", { opponent: { race: "Zerg", displayName: "Opp" } });
      await putIntent(user.web, "no-strategy", { action: "opponent", opponentBuildKey: POOL_KEY }).expect(200);
      await putIntent(user.web, "no-strategy", { action: "opponent", opponentBuildKey: null }).expect(200);
      row = await gameRow(user, "no-strategy");
      expect(row.opponent).not.toHaveProperty("strategy");
      expect(row).not.toHaveProperty("_customOpponentStrategySlug");
    });

    test("the detected build's key is a no-op without a correction and clears one", async () => {
      const user = await newUser();
      await addGame(h.db, user.userId, "same", vsZerg(POOL));
      await putIntent(user.web, "same", { action: "opponent", opponentBuildKey: POOL_KEY }).expect(200);
      let row = await gameRow(user, "same");
      expect(row).not.toHaveProperty("buildIntent");
      expect(h.io.events("games:changed")).toHaveLength(0);
      await putIntent(user.web, "same", { action: "opponent", opponentBuildKey: BANE_KEY }).expect(200);
      const res = await putIntent(user.web, "same", { action: "opponent", opponentBuildKey: POOL_KEY }).expect(200);
      expect(res.body.opponent).toEqual(expect.objectContaining({ label: POOL, status: "none", applied: false }));
      row = await gameRow(user, "same");
      expect(row.opponent.strategy).toBe(POOL);
      // null with nothing to clear writes nothing either.
      await addGame(h.db, user.userId, "untouched", vsZerg(POOL));
      await putIntent(user.web, "untouched", { action: "opponent", opponentBuildKey: null }).expect(200);
      expect(await gameRow(user, "untouched")).not.toHaveProperty("buildIntent");
    });

    test("an unknown opponent key refuses the whole request", async () => {
      const user = await newUser();
      await addCustomBuild(h.db, user.userId, "mine", { name: "Mine" });
      await addGame(h.db, user.userId, "refuse", vsZerg(POOL, { myBuild: UNCLASSIFIED }));
      for (const opponentBuildKey of [
        "zerg-standard-play-unclassified",
        PHOENIX_KEY,
        "protoss-dt-rush",
        "custom:mine",
        "custom:nope",
        "Not A Key",
      ]) {
        const res = await putIntent(user.web, "refuse", {
          action: "confirm", buildKey: PHOENIX_KEY, opponentBuildKey,
        }).expect(400);
        expect(res.body.error.code).toBe("unknown_opponent_build");
      }
      for (const opponentBuildKey of [42, "", "x".repeat(201), { key: POOL_KEY }]) {
        const res = await putIntent(user.web, "refuse", { action: "notes", notes: "n", opponentBuildKey }).expect(400);
        expect(res.body.error.code).toBe("unknown_opponent_build");
      }
      const row = await gameRow(user, "refuse");
      expect(row.myBuild).toBe(UNCLASSIFIED);
      expect(row).not.toHaveProperty("buildIntent");
      const missing = await putIntent(user.web, "refuse", { action: "opponent" }).expect(400);
      expect(missing.body.error.code).toBe("invalid_request");
    });

    test("ineligible games refuse a correction but accept clearing", async () => {
      const user = await newUser();
      await addGame(h.db, user.userId, "short", vsZerg(POOL, { durationSec: 20 }));
      for (const action of ["opponent", "skip", "notes"]) {
        const res = await putIntent(user.web, "short", {
          action, notes: "n", opponentBuildKey: BANE_KEY,
        }).expect(409);
        expect(res.body.error).toEqual(expect.objectContaining({ code: "not_eligible", reason: "too_short" }));
      }
      expect(await gameRow(user, "short")).not.toHaveProperty("buildIntent");
      await putIntent(user.web, "short", { action: "skip", opponentBuildKey: null }).expect(200);
      expect((await gameRow(user, "short")).opponent.strategy).toBe(POOL);
    });

    test("catalog names follow the game's patch era", async () => {
      const user = await newUser();
      await addGame(h.db, user.userId, "eight", vsZerg(BANE, { gameVersion: "5.0.16.97425" }));
      const res = await putIntent(user.web, "eight", { action: "opponent", opponentBuildKey: POOL_KEY }).expect(200);
      expect(res.body.opponent.build).toEqual({ key: POOL_KEY, name: "Zerg - 8 Pool", slug: null, source: "catalog" });
      expect((await gameRow(user, "eight")).opponent.strategy).toBe("Zerg - 8 Pool");
    });

    test("a deleted opponent build stays frozen and reported as deleted", async () => {
      const user = await newUser();
      await addCustomBuild(h.db, user.userId, "short-lived", theirBuild({ name: "Short Lived" }));
      await addGame(h.db, user.userId, "frozen", vsZerg(POOL));
      await putIntent(user.web, "frozen", { action: "opponent", opponentBuildKey: "custom:short-lived" }).expect(200);
      await h.db.customBuilds.updateOne({ userId: user.userId, slug: "short-lived" }, { $set: { deletedAt: new Date() } });
      const res = await getIntent(user, "frozen").expect(200);
      expect(res.body.opponent.build).toEqual({
        key: "custom:short-lived", name: "Short Lived", slug: "short-lived", source: "custom", deleted: true,
      });
      expect(res.body.opponent.executed).toBe(false);
      // Re-sending the game's own correction is idempotent.
      await putIntent(user.web, "frozen", {
        action: "notes", notes: "still them", opponentBuildKey: "custom:short-lived",
      }).expect(200);
      expect((await gameRow(user, "frozen"))._customOpponentStrategySlug).toBe("short-lived");
    });

    test("defer and skip carry the opponent change too", async () => {
      const user = await newUser();
      await addGame(h.db, user.userId, "deferred", vsZerg(POOL));
      const deferred = await putIntent(user.device, "deferred", {
        action: "defer", opponentBuildKey: BANE_KEY,
      }).expect(200);
      expect(deferred.body.status).toBe("pending");
      expect(deferred.body.opponent.applied).toBe(true);
      await putIntent(user.web, "deferred", { action: "confirm", buildKey: PHOENIX_KEY }).expect(200);
      // A decided game stays decided; the opponent change still applies.
      const again = await putIntent(user.device, "deferred", { action: "defer", opponentBuildKey: null }).expect(200);
      expect(again.body.status).toBe("confirmed");
      expect(again.body.opponent.applied).toBe(false);
      const row = await gameRow(user, "deferred");
      expect(row.myBuild).toBe(PHOENIX);
      expect(row.opponent.strategy).toBe(POOL);
    });

    test("pending items carry the opponent axis without its options", async () => {
      const user = await newUser();
      await addGame(h.db, user.userId, "queued", vsZerg(POOL, {
        date: new Date(Date.now() - HOUR_MS),
        buildIntent: {
          status: "pending", build: null, applied: false, detected: null, suggestion: null,
          randomizer: null, origin: null, via: null, notes: "", confirmedAt: null, updatedAt: new Date(),
        },
      }));
      const res = await request(h.app).get("/v1/build-intents/pending").set("authorization", user.web).expect(200);
      expect(res.body.items[0].opponent).toEqual(expect.objectContaining({
        label: POOL, status: "none", suggestion: expect.objectContaining({ key: POOL_KEY, reason: "detected" }),
      }));
      expect(res.body.items[0].opponent).not.toHaveProperty("options");
    });
  });

  describe("a build saved a moment ago is confirmable at once", () => {
    test("through the custom-build save (cache dropped)", async () => {
      const user = await newUser();
      await addGame(h.db, user.userId, "new-build", vsZerg(OPP_GENERIC, { myBuild: UNCLASSIFIED }));
      await getIntent(user, "new-build", "?include=options").expect(200);
      await saveBuild(user, "made-now", { name: "Made Now" }).expect(200);
      await saveBuild(user, "their-made-now", {
        name: "Their Made Now", race: "Zerg", vsRace: "Protoss", perspective: "opponent",
      }).expect(200);
      const res = await putIntent(user.web, "new-build", {
        action: "confirm", buildKey: "custom:made-now", opponentBuildKey: "custom:their-made-now",
      }).expect(200);
      expect(res.body.build).toEqual({ key: "custom:made-now", name: "Made Now", slug: "made-now", source: "custom" });
      expect(res.body.opponent.build).toEqual(expect.objectContaining({ key: "custom:their-made-now" }));
      const row = await gameRow(user, "new-build");
      expect(row._customBuildSlug).toBe("made-now");
      expect(row._customOpponentStrategySlug).toBe("their-made-now");
    });

    test("from the database when the cached options are stale (another API instance)", async () => {
      const user = await newUser();
      await addGame(h.db, user.userId, "stale", vsZerg(POOL, { myBuild: UNCLASSIFIED }));
      await getIntent(user, "stale", "?include=options").expect(200);
      await addCustomBuild(h.db, user.userId, "direct-you", { name: "Direct You" });
      await addCustomBuild(h.db, user.userId, "direct-opp", theirBuild({ name: "Direct Opp" }));
      await addCustomBuild(h.db, user.userId, "direct-misfit", { name: "Misfit", vsRace: "Terran" });
      await addCustomBuild(h.db, user.userId, "direct-opp-misfit", theirBuild({ name: "Opp Misfit", race: "Terran" }));
      const misfit = await putIntent(user.web, "stale", { action: "confirm", buildKey: "custom:direct-misfit" }).expect(400);
      expect(misfit.body.error.code).toBe("unknown_build");
      const oppMisfit = await putIntent(user.web, "stale", {
        action: "opponent", opponentBuildKey: "custom:direct-opp-misfit",
      }).expect(400);
      expect(oppMisfit.body.error.code).toBe("unknown_opponent_build");
      // A "you" build is never an opponent build and vice versa.
      const crossed = await putIntent(user.web, "stale", { action: "confirm", buildKey: "custom:direct-opp" }).expect(400);
      expect(crossed.body.error.code).toBe("unknown_build");
      await putIntent(user.web, "stale", {
        action: "confirm", buildKey: "custom:direct-you", opponentBuildKey: "custom:direct-opp",
      }).expect(200);
      const row = await gameRow(user, "stale");
      expect(row.myBuild).toBe("Direct You");
      expect(row.opponent.strategy).toBe("Direct Opp");
    });

    test("a live declaration of a build saved after the options were cached", async () => {
      const user = await newUser();
      const gameKey = `Opp|Streamer|${Date.now()}`;
      const live = (body) => request(h.app)
        .put(`/v1/build-intents/live/${encodeURIComponent(gameKey)}`)
        .set("authorization", user.device)
        .send(body);
      await live({ action: "register", myRace: "Protoss", oppRace: "Zerg", oppName: "Opp" }).expect(200);
      await options(user, "PvZ", "you").expect(200);
      await addCustomBuild(h.db, user.userId, "declared-now", { name: "Declared Now" });
      const res = await live({ action: "declare", buildKey: "custom:declared-now" }).expect(200);
      expect(res.body.declared).toEqual(expect.objectContaining({ key: "custom:declared-now", name: "Declared Now" }));
    });
  });
});
