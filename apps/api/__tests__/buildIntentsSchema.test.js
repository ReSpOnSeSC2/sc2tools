// @ts-nocheck
/* eslint-disable max-lines-per-function */
"use strict";

/**
 * Build check-in storage: games schema v8 (migration forward/backward),
 * the build_intent_live collection (registry, indexes, TTL, GDPR purge),
 * request-log redaction of live game keys and the small shared helpers.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");

const { COLLECTIONS } = require("../src/config/constants");
const {
  REGISTRY,
  VERSION_KEY,
  expectedVersion,
  migrateDoc,
} = require("../src/db/schemaVersioning");
const { loadAllMigrations } = require("../src/db/migrations");
const { connect } = require("../src/db/connect");
const { GdprService, PURGE_ONLY_COLLECTIONS, USER_SCOPED_COLLECTIONS } = require("../src/services/gdpr");
const { sanitiseRequestUrl } = require("../src/middleware/requestLogging");
const { normalizePlayerName } = require("../src/util/playerName");
const {
  sanitizeCheckinPrefs,
  randomizerPool,
} = require("../src/services/buildIntentPrefs");
const {
  isValidGameKey,
  keyStartedAtMs,
  playerNamesFromKey,
  normalizeRace,
  matchupFromRaces,
  overlayPayload,
} = require("../src/services/buildIntentCommon");
const {
  parsePendingLimit,
  validateLiveIntentBody,
  validateGameIntentBody,
} = require("../src/validation/buildIntent");

describe("games schema v8", () => {
  beforeAll(() => {
    loadAllMigrations();
  });

  test("registers games v8 and the live collection at v1", () => {
    expect(expectedVersion(COLLECTIONS.GAMES)).toBe(8);
    expect(COLLECTIONS.BUILD_INTENT_LIVE).toBe("build_intent_live");
    expect(REGISTRY[COLLECTIONS.BUILD_INTENT_LIVE]).toEqual({
      collection: "build_intent_live", currentVersion: 1, versionKey: VERSION_KEY,
    });
  });

  test("forwards v7 (and older) rows without synthetic fields", () => {
    expect(migrateDoc({ gameId: "g", myBuild: "PvZ - X", [VERSION_KEY]: 7 }, COLLECTIONS.GAMES))
      .toEqual({ gameId: "g", myBuild: "PvZ - X", [VERSION_KEY]: 8 });
    expect(migrateDoc({ gameId: "g", [VERSION_KEY]: 5 }, COLLECTIONS.GAMES))
      .toEqual({ gameId: "g", [VERSION_KEY]: 8 });
  });

  test("rollback restores the classifier's label exactly and drops the check-in", () => {
    const applied = {
      gameId: "a",
      myBuild: "Declared Custom",
      _customBuildSlug: "declared",
      buildIntent: {
        status: "confirmed",
        applied: true,
        build: { key: "custom:declared", name: "Declared Custom", slug: "declared", source: "custom" },
        detected: { name: "PvZ - Robo Opener", slug: null },
        notes: "private",
      },
      [VERSION_KEY]: 8,
    };
    expect(migrateDoc(applied, COLLECTIONS.GAMES, { targetVersion: 7 })).toEqual({
      gameId: "a", myBuild: "PvZ - Robo Opener", [VERSION_KEY]: 7,
    });

    const noLabel = {
      gameId: "b",
      myBuild: "PvZ - 2 Stargate Phoenix",
      buildIntent: {
        status: "confirmed",
        applied: true,
        build: { key: "pvz-2-stargate-phoenix", name: "PvZ - 2 Stargate Phoenix", slug: null, source: "catalog" },
        detected: { name: null, slug: "old-custom" },
      },
      [VERSION_KEY]: 8,
    };
    expect(migrateDoc(noLabel, COLLECTIONS.GAMES, { targetVersion: 7 })).toEqual({
      gameId: "b", _customBuildSlug: "old-custom", [VERSION_KEY]: 7,
    });

    const notApplied = {
      gameId: "c",
      myBuild: "PvZ - Game Too Short",
      _customBuildSlug: "keep",
      buildIntent: { status: "confirmed", applied: false, build: { key: "k", name: "K" }, detected: null },
      [VERSION_KEY]: 8,
    };
    expect(migrateDoc(notApplied, COLLECTIONS.GAMES, { targetVersion: 7 })).toEqual({
      gameId: "c", myBuild: "PvZ - Game Too Short", _customBuildSlug: "keep", [VERSION_KEY]: 7,
    });
  });
});

describe("build_intent_live storage", () => {
  let mongo;
  let db;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "build_intent_schema_test" });
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  test("has the unique key, bind lookup and TTL indexes; games has the partial pending index", async () => {
    const indexes = await db.buildIntentLive.indexes();
    const byKey = Object.fromEntries(indexes.map((ix) => [JSON.stringify(ix.key), ix]));
    expect(byKey[JSON.stringify({ userId: 1, gameKey: 1 })].unique).toBe(true);
    expect(byKey[JSON.stringify({ userId: 1, gameId: 1, keyStartedAtMs: 1 })]).toBeDefined();
    expect(byKey[JSON.stringify({ expiresAt: 1 })].expireAfterSeconds).toBe(0);
    const games = await db.games.indexes();
    const pending = games.find((ix) => ix.name === "build_intent_pending");
    expect(pending.key).toEqual({ userId: 1, "buildIntent.status": 1, date: -1 });
    expect(pending.partialFilterExpression).toEqual({ "buildIntent.status": "pending" });
  });

  test("is purged on account deletion and never exported", async () => {
    expect(PURGE_ONLY_COLLECTIONS).toContainEqual(["buildIntentLive", "userId"]);
    expect(USER_SCOPED_COLLECTIONS.map(([key]) => key)).not.toContain("buildIntentLive");
    await db.users.insertOne({ userId: "gdpr-user", clerkUserId: "clerk_gdpr" });
    await db.buildIntentLive.insertMany([
      { userId: "gdpr-user", gameKey: "A|B|1", gameId: null, _schemaVersion: 1 },
      { userId: "gdpr-user", gameKey: "A|B|2", gameId: "g", _schemaVersion: 1 },
      { userId: "someone-else", gameKey: "A|B|1", gameId: null, _schemaVersion: 1 },
    ]);
    const gdpr = new GdprService(db);
    const exported = await gdpr.export("gdpr-user");
    expect(exported.data).not.toHaveProperty("buildIntentLive");
    const counts = await gdpr.deleteAll("gdpr-user");
    expect(counts.buildIntentLive).toBe(2);
    expect(await db.buildIntentLive.countDocuments({ userId: "gdpr-user" })).toBe(0);
    expect(await db.buildIntentLive.countDocuments({ userId: "someone-else" })).toBe(1);
  });
});

describe("request logs", () => {
  test("redact the live game key segment (both players' names)", () => {
    expect(sanitiseRequestUrl("/v1/build-intents/live/%5BoM%5DCure%7CMe%23123%7C1717000000000"))
      .toBe("/v1/build-intents/live/[redacted]");
    expect(sanitiseRequestUrl("/v1/build-intents/live/Foo|Bar|1?x=1")).toBe("/v1/build-intents/live/[redacted]?x=1");
    expect(sanitiseRequestUrl("/v1/build-intents/options?matchup=PvZ")).toBe("/v1/build-intents/options?matchup=PvZ");
    expect(sanitiseRequestUrl("/v1/build-intents/pending?limit=5")).toBe("/v1/build-intents/pending?limit=5");
  });
});

describe("shared helpers", () => {
  test.each([
    [" [oM]Cure#123 ", "cure"],
    ["[TAG] Spaced Name", "spaced name"],
    ["Plain", "plain"],
    ["Bracket[In]Name#9", "bracket[in]name"],
    ["Café", "café"],
    ["", ""],
    [null, ""],
  ])("normalizePlayerName(%j) → %j", (raw, expected) => {
    expect(normalizePlayerName(raw)).toBe(expected);
  });

  test("live game keys", () => {
    expect(isValidGameKey("Opp|Me|1717000000000")).toBe(true);
    expect(isValidGameKey("unknown|1717000000000")).toBe(true);
    expect(isValidGameKey("no-pipe")).toBe(false);
    expect(isValidGameKey("a|b|12x")).toBe(false);
    expect(isValidGameKey(`a|${"x".repeat(400)}|1`)).toBe(false);
    expect(isValidGameKey(42)).toBe(false);
    expect(keyStartedAtMs("Opp|Me|1717000000000")).toBe(1717000000000);
    expect(keyStartedAtMs("Opp|Me|later")).toBeNull();
    expect(playerNamesFromKey("[oM]Cure#1|Me#2|Me|5")).toEqual(["cure", "me"]);
    expect(playerNamesFromKey("unknown|5")).toEqual(["unknown"]);
  });

  test("races and matchups", () => {
    expect(normalizeRace("prot")).toBe("Protoss");
    expect(normalizeRace("Z")).toBe("Zerg");
    expect(normalizeRace("Random")).toBe("Random");
    expect(normalizeRace("?")).toBeNull();
    expect(matchupFromRaces("Protoss", "Zerg")).toBe("PvZ");
    expect(matchupFromRaces("Random", "Zerg")).toBeNull();
    expect(matchupFromRaces(null, "Zerg")).toBeNull();
  });

  test("overlay payloads carry only the suppress flag and the hold", () => {
    const declared = { key: "pvz-x", name: "PvZ - X", slug: null, source: "catalog" };
    const base = { gameKey: "K|1", hold: { untilMs: 10_000, released: false } };
    expect(overlayPayload({ ...base, declared: null, randomizer: null }, 4000))
      .toEqual({ gameKey: "K|1", suppressRandomizer: false, holdRemainingMs: 6000 });
    expect(overlayPayload({ ...base, declared, randomizer: null }, 20_000))
      .toEqual({ gameKey: "K|1", suppressRandomizer: true, holdRemainingMs: 0 });
    expect(overlayPayload({ ...base, declared, randomizer: declared }, 0).suppressRandomizer).toBe(false);
    expect(overlayPayload({ ...base, declared, randomizer: { ...declared, key: "pvz-y" } }, 0).suppressRandomizer).toBe(true);
    expect(overlayPayload({ gameKey: "K|1", hold: { untilMs: 10_000, released: true } }, 0).holdRemainingMs).toBe(0);
  });

  test("check-in prefs default off and require an explicit true", () => {
    expect(sanitizeCheckinPrefs(undefined)).toEqual({ enabled: false, askAtLoading: false, askAfterGame: false });
    expect(sanitizeCheckinPrefs({ enabled: false, askAfterGame: 0, extra: true }))
      .toEqual({ enabled: false, askAtLoading: false, askAfterGame: false });
    expect(sanitizeCheckinPrefs([false])).toEqual({ enabled: false, askAtLoading: false, askAfterGame: false });
    const optedIn = { enabled: true, askAtLoading: true, askAfterGame: true };
    expect(sanitizeCheckinPrefs(optedIn)).toEqual(optedIn);
    expect(sanitizeCheckinPrefs({ enabled: 1, askAtLoading: "true" })).toEqual({ enabled: false, askAtLoading: false, askAfterGame: false });
  });

  test("randomizer pools mirror the widget's gate", () => {
    const prefs = {
      matchups: {
        PvZ: { enabled: true, builds: [{ id: "a", name: "A" }, { id: "a", name: "dup" }, { id: "", name: "x" }, { id: "b" }] },
        PvT: { enabled: false, builds: [{ id: "c", name: "C" }] },
        PvP: { enabled: true, builds: [] },
      },
    };
    expect(randomizerPool(prefs, "PvZ")).toEqual({ enabled: true, ids: ["a"] });
    expect(randomizerPool(prefs, "PvT")).toEqual({ enabled: false, ids: ["c"] });
    expect(randomizerPool(prefs, "PvP")).toEqual({ enabled: false, ids: [] });
    expect(randomizerPool(prefs, "ZvZ")).toEqual({ enabled: false, ids: [] });
    expect(randomizerPool(null, "PvZ")).toEqual({ enabled: false, ids: [] });
    expect(randomizerPool({ matchups: { constructor: { enabled: true, builds: [] } } }, "toString"))
      .toEqual({ enabled: false, ids: [] });
  });

  test("request validation maps problems to the contract's codes", () => {
    expect(parsePendingLimit(undefined)).toBe(10);
    expect(parsePendingLimit("3")).toBe(3);
    expect(parsePendingLimit("0")).toBe(1);
    expect(parsePendingLimit("99")).toBe(25);
    expect(parsePendingLimit("-1")).toBe(10);
    expect(validateLiveIntentBody({ action: "declare", buildKey: "pvz-x" })).toEqual({
      valid: true, value: { action: "declare", buildKey: "pvz-x" },
    });
    expect(validateLiveIntentBody(null)).toEqual(expect.objectContaining({ valid: false, code: "invalid_action" }));
    expect(validateLiveIntentBody({ action: "confirm" }).code).toBe("invalid_action");
    expect(validateLiveIntentBody({ action: "postgame", notes: 5 }).code).toBe("invalid_notes");
    expect(validateLiveIntentBody({ action: "declare", buildKey: "" }).code).toBe("unknown_build");
    expect(validateLiveIntentBody({ action: "register", myRace: 3 }).code).toBe("invalid_request");
    expect(validateGameIntentBody({ action: "register" }).code).toBe("invalid_action");
    expect(validateGameIntentBody({ action: "notes", notes: "x".repeat(4001) }).code).toBe("invalid_notes");
    expect(validateGameIntentBody({ action: "skip", gameKey: "k" }).code).toBe("invalid_request");
  });
});
