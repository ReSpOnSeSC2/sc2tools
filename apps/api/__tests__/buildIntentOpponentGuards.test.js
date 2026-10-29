// @ts-nocheck
/* eslint-disable max-lines-per-function */
"use strict";

/**
 * Opponent-axis writer guards (addendum §A.3): the custom-build classifier
 * never sees, clears or replaces a confirmed opponent correction. It keeps
 * deciding the detector's opponent label, which lands in
 * ``buildIntent.opponent.detected`` on correction rows, while
 * ``opponent.strategy``/``_customOpponentStrategySlug`` keep the declared
 * build. Every row without a correction is classified exactly as before,
 * and the "you" axis composes with it in the same atomic write.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");

const { CustomBuildsService } = require("../src/services/customBuilds");
const { PerGameComputeService } = require("../src/services/perGameCompute");
const {
  applyOverridePipeline,
  applyOpponentOverridePipeline,
  clearOpponentOverridePipeline,
} = require("../src/services/buildIntentAttribution");
const {
  opponentClaimFilter,
  tagClassificationPipeline,
} = require("../src/services/buildIntentGuards");

const USER = "u-opp-guards";
const DATE = new Date("2026-10-20T18:00:00Z");
const AGENT_LABEL = "PvZ - Macro Transition (Unclassified)";
const AGENT_STRATEGY = "Zerg - Standard Play (Unclassified)";

const STARGATE_LOG = ["[0:17] Pylon", "[0:49] Gateway", "[1:30] CyberneticsCore", "[3:00] Stargate"];
const GATEWAY_LOG = ["[0:17] Pylon", "[0:49] Gateway", "[1:30] CyberneticsCore"];
const POOL_LOG = ["[0:50] SpawningPool"];
const ROACH_LOG = ["[0:50] SpawningPool", "[2:30] RoachWarren"];
const LATE_POOL_LOG = ["[2:50] SpawningPool"];

function definition(slug, name, rules, extra = {}) {
  return {
    userId: USER,
    slug,
    name,
    race: "Zerg",
    vsRace: "Protoss",
    perspective: "opponent",
    rules,
    updatedAt: new Date("2026-10-01T00:00:00Z"),
    ...extra,
  };
}

const POOL_FIRST = definition("pool-first", "Pool First", [
  { type: "before", name: "BuildSpawningPool", time_lt: 120 },
]);
const ROACH_RUSH = definition("roach-rush", "Roach Rush", [
  { type: "before", name: "BuildSpawningPool", time_lt: 120 },
  { type: "before", name: "BuildRoachWarren", time_lt: 240 },
]);
// The declared opponent build: the replay never satisfies its rules.
const LING_FLOOD = definition("ling-flood", "Ling Flood", [
  { type: "before", name: "BuildBanelingNest", time_lt: 200 },
]);
const STARGATE = definition("stargate-opener", "Stargate Opener", [
  { type: "before", name: "BuildStargate", time_lt: 300 },
], { race: "Protoss", vsRace: "Zerg", perspective: "you" });
const DT = definition("dt-rush", "DT Rush", [
  { type: "before", name: "BuildDarkShrine", time_lt: 420 },
], { race: "Protoss", vsRace: "Zerg", perspective: "you" });

const LING_REF = { key: "custom:ling-flood", name: "Ling Flood", slug: "ling-flood", source: "custom" };
const CATALOG_OPP_REF = { key: "zerg-12-pool", name: "Zerg - 12 Pool", slug: null, source: "catalog" };
const DT_REF = { key: "custom:dt-rush", name: "DT Rush", slug: "dt-rush", source: "custom" };

let mongo;
let client;
let games;
let builds;
let jobs;
let definitionContext;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  const connected = await connect({ uri: mongo.getUri(), dbName: "build_intent_opponent_guards" });
  client = connected.client;
  const db = client.db("build_intent_opponent_guards");
  definitionContext = { client, users: connected.users, gameStatsTransactions: connected.gameStatsTransactions };
  await connected.users.insertOne({ userId: USER });
  games = db.collection("games");
  builds = db.collection("custom_builds");
  jobs = db.collection("custom_build_jobs");
  await builds.createIndex({ userId: 1, slug: 1 }, { unique: true });
  await games.createIndex({ userId: 1, date: -1, _id: -1 });
});

afterAll(async () => {
  if (client) await client.close();
  if (mongo) await mongo.stop();
});

afterEach(async () => {
  jest.restoreAllMocks();
  await Promise.all([games.deleteMany({}), builds.deleteMany({}), jobs.deleteMany({})]);
});

function newService(opts = {}) {
  return new CustomBuildsService(
    { ...definitionContext, games, customBuilds: builds, customBuildJobs: jobs },
    { perGame: new PerGameComputeService({ games }), ...opts },
  );
}

/** Upload payload: what the agent sends (detector labels on both axes). */
function payload(gameId, overrides = {}) {
  return {
    gameId,
    date: DATE,
    myRace: "Protoss",
    myBuild: AGENT_LABEL,
    buildLog: STARGATE_LOG,
    oppBuildLog: POOL_LOG,
    opponent: { race: "Zerg", strategy: AGENT_STRATEGY },
    ...overrides,
  };
}

/** A stored row as GamesService leaves it (logs inline for the preview). */
async function seedRow(gameId, overrides = {}) {
  await games.insertOne({
    userId: USER,
    ...payload(gameId),
    _customBuildRevision: `rev-${gameId}`,
    ...overrides,
  });
}

async function correct(gameId, build = LING_REF) {
  await games.updateOne(
    { userId: USER, gameId },
    applyOpponentOverridePipeline(build, { origin: "web", via: "web" }),
  );
}

/** What upsertWithRevision does on a re-upload: fresh agent labels + revision. */
async function reupload(gameId, strategy, revision, extra = {}) {
  await games.updateOne(
    { userId: USER, gameId },
    { $set: { "opponent.strategy": strategy, _customBuildRevision: revision, ...extra } },
  );
}

async function row(gameId) {
  return games.findOne({ userId: USER, gameId }, { projection: { _id: 0 } });
}

function expectCorrected(stored, build = LING_REF) {
  expect(stored.opponent.strategy).toBe(build.name);
  if (build.source === "custom") {
    expect(stored._customOpponentStrategySlug).toBe(build.slug);
  } else {
    expect(stored).not.toHaveProperty("_customOpponentStrategySlug");
  }
  expect(stored.buildIntent.opponent).toEqual(expect.objectContaining({
    status: "confirmed",
    applied: true,
    build,
  }));
}

function expectDeclared(stored, build = DT_REF) {
  expect(stored.myBuild).toBe(build.name);
  expect(stored._customBuildSlug).toBe(build.slug);
  expect(stored.buildIntent).toEqual(expect.objectContaining({
    status: "confirmed",
    applied: true,
    build,
  }));
}

describe("tagSingleGame on opponent correction rows", () => {
  beforeEach(async () => {
    await builds.insertMany([
      { ...STARGATE }, { ...DT }, { ...POOL_FIRST }, { ...ROACH_RUSH }, { ...LING_FLOOD },
    ]);
  });

  test("a fresh winner refreshes opponent detected and keeps the declared build", async () => {
    await seedRow("t-winner", {
      _customBuildReclassify: [{ runId: "old", sequence: 1, action: "clear" }],
      _customBuildClassificationSequence: 1,
    });
    await correct("t-winner");

    const result = await newService().tagSingleGame(USER, payload("t-winner"), {
      expectedRevision: "rev-t-winner",
    });

    expect(result).toEqual(expect.objectContaining({
      chosenByPerspective: { you: "Stargate Opener", opponent: "Pool First" },
      userSlug: "stargate-opener",
    }));
    const stored = await row("t-winner");
    expectCorrected(stored);
    expect(stored.buildIntent.opponent.detected).toEqual({ name: "Pool First", slug: "pool-first" });
    // The "you" axis has no check-in: plain classification, no detected.
    expect(stored.myBuild).toBe("Stargate Opener");
    expect(stored._customBuildSlug).toBe("stargate-opener");
    expect(Object.keys(stored.buildIntent)).toEqual(["opponent"]);
    expect(stored.opponent.race).toBe("Zerg");
    expect(stored).not.toHaveProperty("_customBuildReclassify");
    expect(stored).not.toHaveProperty("_customBuildClassificationSequence");
  });

  test("a re-upload keeps the correction and refreshes detected from the agent's label", async () => {
    await seedRow("t-reupload", {
      opponent: { race: "Zerg", strategy: "Pool First" },
      _customOpponentStrategySlug: "pool-first",
    });
    await correct("t-reupload");
    expect((await row("t-reupload")).buildIntent.opponent.detected)
      .toEqual({ name: "Pool First", slug: "pool-first" });
    // GamesService patched the fresh agent label over the declared name and
    // preserved the slug; the replay no longer shows an early pool.
    await reupload("t-reupload", "Zerg - Agent v2", "rev-2");
    expect((await row("t-reupload")).opponent.strategy).toBe("Zerg - Agent v2");

    await newService().tagSingleGame(
      USER,
      payload("t-reupload", {
        oppBuildLog: LATE_POOL_LOG,
        opponent: { race: "Zerg", strategy: "Zerg - Agent v2" },
      }),
      { expectedRevision: "rev-2" },
    );

    const stored = await row("t-reupload");
    expectCorrected(stored);
    expect(stored.buildIntent.opponent.detected).toEqual({ name: "Zerg - Agent v2", slug: null });
  });

  test("an upload without an opponent label keeps the previous detector name", async () => {
    await seedRow("t-nolabel");
    await correct("t-nolabel");

    await newService().tagSingleGame(
      USER,
      payload("t-nolabel", { oppBuildLog: LATE_POOL_LOG, opponent: { race: "Zerg" } }),
      { expectedRevision: "rev-t-nolabel" },
    );

    const stored = await row("t-nolabel");
    expectCorrected(stored);
    expect(stored.buildIntent.opponent.detected).toEqual({ name: AGENT_STRATEGY, slug: null });
  });

  test("a deferred opponent axis restores the detector's slug, never the declared one", async () => {
    await seedRow("t-deferred", {
      opponent: { race: "Zerg", strategy: "Pool First" },
      _customOpponentStrategySlug: "pool-first",
    });
    await correct("t-deferred");
    await builds.updateOne({ userId: USER, slug: "pool-first" }, { $set: { name: "Pool First v2" } });
    await reupload("t-deferred", "Agent opp label", "rev-2");
    const service = newService();
    const lookup = jest.spyOn(service, "_getForClassification");

    // No opponent events: every opponent definition is unknown, so that axis defers.
    const result = await service.tagSingleGame(
      USER,
      payload("t-deferred", {
        oppBuildLog: [],
        opponent: { race: "Zerg", strategy: "Agent opp label" },
      }),
      { expectedRevision: "rev-2" },
    );

    expect(lookup).toHaveBeenCalledWith(USER, "pool-first");
    expect(lookup).not.toHaveBeenCalledWith(USER, "ling-flood");
    expect(result.userSlug).toBe("stargate-opener");
    const stored = await row("t-deferred");
    expectCorrected(stored);
    expect(stored.buildIntent.opponent.detected).toEqual({ name: "Pool First v2", slug: "pool-first" });
    expect(stored._customBuildSlug).toBe("stargate-opener");
  });

  test("a deferred detector slug whose opponent build is gone is dropped from detected only", async () => {
    await seedRow("t-deferred-gone", {
      opponent: { race: "Zerg", strategy: "Gone Opp" },
      _customOpponentStrategySlug: "gone-opp",
    });
    await correct("t-deferred-gone");
    await reupload("t-deferred-gone", "Agent opp label", "rev-2");

    await newService().tagSingleGame(
      USER,
      payload("t-deferred-gone", {
        oppBuildLog: [],
        opponent: { race: "Zerg", strategy: "Agent opp label" },
      }),
      { expectedRevision: "rev-2" },
    );

    const stored = await row("t-deferred-gone");
    expectCorrected(stored);
    expect(stored.buildIntent.opponent.detected).toEqual({ name: "Agent opp label", slug: null });
  });

  test("with nothing to classify a re-upload still restores an opponent-only correction", async () => {
    await seedRow("t-shortcut", {
      _customBuildReclassify: [{ runId: "in-flight", sequence: 9, action: "set" }],
    });
    await correct("t-shortcut");
    await reupload("t-shortcut", "Agent opp label", "rev-2", { myBuild: "Agent label" });
    await seedRow("t-shortcut-plain", { myBuild: "Agent label" });
    const service = newService();
    const write = jest.spyOn(games, "findOneAndUpdate");

    // Both axes defer (no events) and neither has a preserved slug.
    const result = await service.tagSingleGame(
      USER,
      payload("t-shortcut", {
        myBuild: "Agent label",
        buildLog: [],
        oppBuildLog: [],
        opponent: { race: "Zerg", strategy: "Agent opp label" },
      }),
      { expectedRevision: "rev-2" },
    );
    expect(result).toEqual({ gameId: "t-shortcut", matched: 0, chosen: null, ruleCount: 0 });
    const stored = await row("t-shortcut");
    expectCorrected(stored);
    expect(stored.buildIntent.opponent.detected).toEqual({ name: "Agent opp label", slug: null });
    expect(stored.myBuild).toBe("Agent label");
    expect(stored.buildIntent).not.toHaveProperty("detected");
    // Not a classification decision: in-flight reclassify staging survives.
    expect(stored._customBuildReclassify).toEqual([{ runId: "in-flight", sequence: 9, action: "set" }]);
    expect(write).toHaveBeenCalledTimes(1);

    // A row without a correction is not written at all, exactly as before.
    write.mockClear();
    const before = await row("t-shortcut-plain");
    await service.tagSingleGame(
      USER,
      payload("t-shortcut-plain", { myBuild: "Agent label", buildLog: [], oppBuildLog: [] }),
      { expectedRevision: "rev-stale" },
    );
    expect(write).not.toHaveBeenCalled();
    expect(await row("t-shortcut-plain")).toEqual(before);
  });

  test("the opponent restore-only write is revision fenced", async () => {
    await seedRow("t-shortcut-fence");
    await correct("t-shortcut-fence");
    await reupload("t-shortcut-fence", "Agent opp label", "rev-newer");

    await expect(newService().tagSingleGame(
      USER,
      payload("t-shortcut-fence", { buildLog: [], oppBuildLog: [] }),
      { expectedRevision: "rev-older" },
    )).rejects.toMatchObject({ code: "custom_build_tag_superseded" });
    expect((await row("t-shortcut-fence")).opponent.strategy).toBe("Agent opp label");
  });

  test("both axes overridden at once keep both declared builds and refresh both detectors", async () => {
    await seedRow("t-both", {
      myBuild: "Stargate Opener",
      _customBuildSlug: "stargate-opener",
      opponent: { race: "Zerg", strategy: "Pool First" },
      _customOpponentStrategySlug: "pool-first",
    });
    // One atomic update: the concatenated pipelines.
    await games.updateOne({ userId: USER, gameId: "t-both" }, [
      ...applyOverridePipeline(DT_REF, { origin: "web", via: "web", notes: "both" }),
      ...applyOpponentOverridePipeline(LING_REF, { origin: "web", via: "web" }),
    ]);
    await reupload("t-both", "Agent opp label", "rev-2", { myBuild: "Agent label" });

    const result = await newService().tagSingleGame(
      USER,
      payload("t-both", {
        myBuild: "Agent label",
        buildLog: GATEWAY_LOG,
        oppBuildLog: ROACH_LOG,
        opponent: { race: "Zerg", strategy: "Agent opp label" },
      }),
      { expectedRevision: "rev-2" },
    );

    expect(result.userSlug).toBeNull();
    const stored = await row("t-both");
    expectDeclared(stored);
    expectCorrected(stored);
    expect(stored.buildIntent.detected).toEqual({ name: "Agent label", slug: null });
    expect(stored.buildIntent.opponent.detected).toEqual({ name: "Roach Rush", slug: "roach-rush" });
    expect(stored.buildIntent.notes).toBe("both");
  });

  test("both axes overridden with nothing to classify restore both declared builds", async () => {
    await seedRow("t-both-keep");
    await games.updateOne({ userId: USER, gameId: "t-both-keep" }, [
      ...applyOverridePipeline(DT_REF, {}),
      ...applyOpponentOverridePipeline(CATALOG_OPP_REF, {}),
    ]);
    await reupload("t-both-keep", "Agent opp label", "rev-2", { myBuild: "Agent label" });

    await newService().tagSingleGame(
      USER,
      payload("t-both-keep", {
        myBuild: "Agent label",
        buildLog: [],
        oppBuildLog: [],
        opponent: { race: "Zerg", strategy: "Agent opp label" },
      }),
      { expectedRevision: "rev-2" },
    );

    const stored = await row("t-both-keep");
    expectDeclared(stored);
    expectCorrected(stored, CATALOG_OPP_REF);
    expect(stored.buildIntent.detected).toEqual({ name: "Agent label", slug: null });
    expect(stored.buildIntent.opponent.detected).toEqual({ name: "Agent opp label", slug: null });
  });

  test("a superseded write changes nothing", async () => {
    await seedRow("t-superseded");
    await correct("t-superseded");
    const before = await row("t-superseded");

    await expect(newService().tagSingleGame(USER, payload("t-superseded"), {
      expectedRevision: "rev-older",
    })).rejects.toMatchObject({ code: "custom_build_tag_superseded" });
    expect(await row("t-superseded")).toEqual(before);
  });

  test("a deleted or flipped declared opponent build stays frozen through the tagger", async () => {
    await seedRow("t-frozen");
    await correct("t-frozen");
    await builds.updateOne({ userId: USER, slug: "ling-flood" }, { $set: { deletedAt: new Date() } });

    await newService().tagSingleGame(USER, payload("t-frozen"), { expectedRevision: "rev-t-frozen" });
    let stored = await row("t-frozen");
    expectCorrected(stored);
    expect(stored.buildIntent.opponent.detected).toEqual({ name: "Pool First", slug: "pool-first" });

    await builds.updateOne(
      { userId: USER, slug: "ling-flood" },
      { $unset: { deletedAt: "" }, $set: { perspective: "you", race: "Protoss", vsRace: "Zerg" } },
    );
    await newService().tagSingleGame(
      USER,
      payload("t-frozen", { oppBuildLog: LATE_POOL_LOG }),
      { expectedRevision: "rev-t-frozen" },
    );
    stored = await row("t-frozen");
    expectCorrected(stored);
    expect(stored.buildIntent.opponent.detected).toEqual({ name: AGENT_STRATEGY, slug: null });
  });

  test("a correction confirmed mid-classification still keeps the declared build", async () => {
    await seedRow("t-race-apply");
    const service = newService();
    const iterate = service._iterateForClassification.bind(service);
    service._iterateForClassification = async function* (...args) {
      yield* iterate(...args);
      await correct("t-race-apply");
    };

    await service.tagSingleGame(USER, payload("t-race-apply"), { expectedRevision: "rev-t-race-apply" });

    const stored = await row("t-race-apply");
    expectCorrected(stored);
    expect(stored.buildIntent.opponent.detected).toEqual({ name: "Pool First", slug: "pool-first" });
  });

  test("a correction cleared mid-classification gets the plain classification", async () => {
    await seedRow("t-race-clear");
    await correct("t-race-clear");
    const service = newService();
    const iterate = service._iterateForClassification.bind(service);
    service._iterateForClassification = async function* (...args) {
      yield* iterate(...args);
      await games.updateOne(
        { userId: USER, gameId: "t-race-clear" },
        clearOpponentOverridePipeline({ status: "none", build: null }),
      );
    };

    await service.tagSingleGame(USER, payload("t-race-clear"), { expectedRevision: "rev-t-race-clear" });

    const stored = await row("t-race-clear");
    expect(stored.opponent.strategy).toBe("Pool First");
    expect(stored._customOpponentStrategySlug).toBe("pool-first");
    expect(stored.buildIntent.opponent).toEqual(expect.objectContaining({
      status: "none",
      applied: false,
      detected: null,
    }));
  });

  test("rows without a correction are classified exactly as before", async () => {
    await seedRow("t-plain");
    await seedRow("t-plain-you-checkin");
    await games.updateOne(
      { userId: USER, gameId: "t-plain-you-checkin" },
      applyOverridePipeline(DT_REF, {}),
    );
    await seedRow("t-plain-stale", {
      opponent: { race: "Zerg", strategy: "Roach Rush" },
      _customOpponentStrategySlug: "roach-rush",
    });
    await seedRow("t-plain-not-applied", {
      buildIntent: { opponent: { status: "confirmed", applied: false, build: CATALOG_OPP_REF, detected: null } },
    });

    const service = newService();
    await service.tagSingleGame(USER, payload("t-plain"), { expectedRevision: "rev-t-plain" });
    await service.tagSingleGame(USER, payload("t-plain-you-checkin"), {
      expectedRevision: "rev-t-plain-you-checkin",
    });
    await service.tagSingleGame(
      USER,
      payload("t-plain-stale", { oppBuildLog: LATE_POOL_LOG }),
      { expectedRevision: "rev-t-plain-stale" },
    );
    await service.tagSingleGame(USER, payload("t-plain-not-applied"), {
      expectedRevision: "rev-t-plain-not-applied",
    });

    const plain = await row("t-plain");
    expect(plain.opponent).toEqual({ race: "Zerg", strategy: "Pool First" });
    expect(plain._customOpponentStrategySlug).toBe("pool-first");
    expect(plain).not.toHaveProperty("buildIntent");
    // A "you"-side check-in leaves the opponent axis to the classifier.
    const youCheckin = await row("t-plain-you-checkin");
    expectDeclared(youCheckin);
    expect(youCheckin.opponent.strategy).toBe("Pool First");
    expect(youCheckin._customOpponentStrategySlug).toBe("pool-first");
    expect(youCheckin.buildIntent).not.toHaveProperty("opponent");
    // A definite nonmatch drops only the slug; the stored label is untouched.
    const stale = await row("t-plain-stale");
    expect(stale.opponent.strategy).toBe("Roach Rush");
    expect(stale).not.toHaveProperty("_customOpponentStrategySlug");
    const notApplied = await row("t-plain-not-applied");
    expect(notApplied.opponent.strategy).toBe("Pool First");
    expect(notApplied.buildIntent.opponent).toEqual({
      status: "confirmed", applied: false, build: CATALOG_OPP_REF, detected: null,
    });
  });
});

describe("tagSingleGame for a user without custom builds", () => {
  test("a catalog correction survives a re-upload and other rows lose stale slugs", async () => {
    await seedRow("z-catalog");
    await correct("z-catalog", CATALOG_OPP_REF);
    await reupload("z-catalog", "Zerg - Agent v2", "rev-2");
    await seedRow("z-plain", {
      opponent: { race: "Zerg", strategy: "Deleted Opp" },
      _customOpponentStrategySlug: "deleted-opp",
    });
    // A row without an opponent (team game) never gains an empty one.
    await seedRow("z-no-opponent", { _customBuildSlug: "old" });
    await games.updateOne({ userId: USER, gameId: "z-no-opponent" }, { $unset: { opponent: "" } });

    const service = newService();
    const declaredResult = await service.tagSingleGame(
      USER,
      payload("z-catalog", { opponent: { race: "Zerg", strategy: "Zerg - Agent v2" } }),
      { expectedRevision: "rev-2" },
    );
    await service.tagSingleGame(USER, payload("z-plain"), { expectedRevision: "rev-z-plain" });
    const noOpponent = payload("z-no-opponent");
    delete noOpponent.opponent;
    await service.tagSingleGame(USER, noOpponent, { expectedRevision: "rev-z-no-opponent" });

    expect(declaredResult).toEqual({ gameId: "z-catalog", matched: 0, chosen: null, ruleCount: 0 });
    const declared = await row("z-catalog");
    expectCorrected(declared, CATALOG_OPP_REF);
    expect(declared.buildIntent.opponent.detected).toEqual({ name: "Zerg - Agent v2", slug: null });
    const plain = await row("z-plain");
    expect(plain.opponent.strategy).toBe("Deleted Opp");
    expect(plain).not.toHaveProperty("_customOpponentStrategySlug");
    expect(plain).not.toHaveProperty("buildIntent");
    const bare = await row("z-no-opponent");
    expect(bare).not.toHaveProperty("opponent");
    expect(bare).not.toHaveProperty("_customBuildSlug");

    await expect(service.tagSingleGame(USER, payload("z-catalog"), {
      expectedRevision: "rev-older",
    })).rejects.toMatchObject({ code: "custom_build_tag_superseded" });
  });
});

describe("opponent pipeline fragments", () => {
  test("tagClassificationPipeline inlines every opponent value literally", async () => {
    await seedRow("p-literal");
    await correct("p-literal");
    await seedRow("p-literal-plain");
    await games.updateMany(
      { userId: USER, gameId: { $in: ["p-literal", "p-literal-plain"] } },
      tagClassificationPipeline({
        you: { mode: "keep" },
        opponent: { mode: "set", name: "$opponent.strategy", slug: "$slug" },
        payloadBuild: null,
        payloadStrategy: "$payload",
        clearStaging: true,
      }),
    );

    const declared = await row("p-literal");
    expectCorrected(declared);
    expect(declared.buildIntent.opponent.detected).toEqual({ name: "$opponent.strategy", slug: "$slug" });
    const plain = await row("p-literal-plain");
    expect(plain.opponent.strategy).toBe("$opponent.strategy");
    expect(plain._customOpponentStrategySlug).toBe("$slug");

    await games.updateOne(
      { userId: USER, gameId: "p-literal" },
      tagClassificationPipeline({
        you: { mode: "keep" },
        opponent: { mode: "unset" },
        payloadBuild: null,
        payloadStrategy: "$$ROOT",
        clearStaging: false,
      }),
    );
    const unset = await row("p-literal");
    expectCorrected(unset);
    expect(unset.buildIntent.opponent.detected).toEqual({ name: "$$ROOT", slug: null });
  });

  test("opponentClaimFilter matches the detector's claim, never the declared slug", async () => {
    await seedRow("f-declared", {
      opponent: { race: "Zerg", strategy: "Pool First" },
      _customOpponentStrategySlug: "pool-first",
    });
    await correct("f-declared");
    await seedRow("f-plain", {
      opponent: { race: "Zerg", strategy: "Ling Flood" },
      _customOpponentStrategySlug: "ling-flood",
    });
    const ids = async (slug) => (await games
      .find({ userId: USER, ...opponentClaimFilter(slug) })
      .project({ _id: 0, gameId: 1 })
      .toArray()).map((doc) => doc.gameId).sort();

    expect(await ids("ling-flood")).toEqual(["f-plain"]);
    expect(await ids("pool-first")).toEqual(["f-declared"]);
  });
});

describe("background reclassification on opponent correction rows", () => {
  beforeEach(async () => {
    await builds.insertMany([{ ...POOL_FIRST }, { ...ROACH_RUSH }, { ...LING_FLOOD }]);
    // Declared Ling Flood, detector generic, replay matches nothing.
    await seedRow("r-generic", { oppBuildLog: LATE_POOL_LOG });
    await correct("r-generic");
    // Declared Ling Flood, detector already the Pool First winner.
    await seedRow("r-agree", {
      opponent: { race: "Zerg", strategy: "Pool First" },
      _customOpponentStrategySlug: "pool-first",
    });
    await correct("r-agree");
    // Declared Ling Flood, detector Pool First, but the replay no longer matches it.
    await seedRow("r-stale", {
      opponent: { race: "Zerg", strategy: "Pool First" },
      _customOpponentStrategySlug: "pool-first",
      oppBuildLog: LATE_POOL_LOG,
    });
    await correct("r-stale");
    // Declared Ling Flood, detector generic, the replay now matches Roach Rush.
    await seedRow("r-new", { oppBuildLog: ROACH_LOG });
    await correct("r-new");
    // Plain rows for comparison.
    await seedRow("r-plain-stale", {
      opponent: { race: "Zerg", strategy: "Pool First" },
      _customOpponentStrategySlug: "pool-first",
      oppBuildLog: LATE_POOL_LOG,
    });
    await seedRow("r-plain-new", { oppBuildLog: ROACH_LOG });
  });

  async function expectRoutedToDetected() {
    for (const gameId of ["r-generic", "r-agree", "r-stale", "r-new"]) {
      const stored = await row(gameId);
      expectCorrected(stored);
      expect([gameId, stored._customBuildReclassify]).toEqual([gameId, undefined]);
    }
    expect((await row("r-generic")).buildIntent.opponent.detected)
      .toEqual({ name: AGENT_STRATEGY, slug: null });
    expect((await row("r-agree")).buildIntent.opponent.detected)
      .toEqual({ name: "Pool First", slug: "pool-first" });
    expect((await row("r-stale")).buildIntent.opponent.detected).toEqual({ name: null, slug: null });
    expect((await row("r-new")).buildIntent.opponent.detected)
      .toEqual({ name: "Roach Rush", slug: "roach-rush" });
    const plainStale = await row("r-plain-stale");
    expect(plainStale.opponent).toEqual({ race: "Zerg" });
    expect(plainStale).not.toHaveProperty("_customOpponentStrategySlug");
    expect(plainStale).not.toHaveProperty("buildIntent");
    const plainNew = await row("r-plain-new");
    expect(plainNew.opponent.strategy).toBe("Roach Rush");
    expect(plainNew._customOpponentStrategySlug).toBe("roach-rush");
    expect(plainNew).not.toHaveProperty("buildIntent");
  }

  test("Save & Reclassify (clearUnmatched) of the declared build routes every verdict to detected", async () => {
    const result = await newService().reclassifyAll(USER, {
      clearUnmatched: true,
      previousNamesBySlug: { "ling-flood": ["Ling Flood"] },
    });
    expect(result).toEqual(expect.objectContaining({ tagged: 2, cleared: 2 }));
    await expectRoutedToDetected();
  });

  test("the single-build mode never clears the declared slug", async () => {
    const service = newService();
    // The declared build fails its own rules everywhere.
    const ling = await service.reclassify(USER, "ling-flood", { replace: true });
    expect(ling).toEqual(expect.objectContaining({ matched: 0, tagged: 0, cleared: 0 }));
    for (const gameId of ["r-generic", "r-agree", "r-stale", "r-new"]) {
      expectCorrected(await row(gameId));
    }
    const pool = await service.reclassify(USER, "pool-first", { replace: true });
    expect(pool).toEqual(expect.objectContaining({ cleared: 2 }));
    await service.reclassify(USER, "roach-rush", { replace: true });
    await expectRoutedToDetected();
  });

  test("deleting the declared build leaves the correction frozen", async () => {
    await builds.updateOne({ userId: USER, slug: "ling-flood" }, { $set: { deletedAt: new Date() } });
    await newService().reclassifyAll(USER, {
      clearUnmatched: true,
      previousNamesBySlug: { "ling-flood": ["Ling Flood"] },
    });
    await expectRoutedToDetected();
  });

  test("flipping the declared build to the \"you\" perspective leaves the correction frozen", async () => {
    await builds.updateOne(
      { userId: USER, slug: "ling-flood" },
      { $set: { perspective: "you", race: "Protoss", vsRace: "Zerg" } },
    );
    await newService().reclassifyAll(USER, {
      clearUnmatched: true,
      previousNamesBySlug: { "ling-flood": ["Ling Flood"] },
    });
    await expectRoutedToDetected();
  });

  test("a correction confirmed between staging and commit takes the verdict as detected", async () => {
    const service = newService();
    const pages = service._rulePages.bind(service);
    service._rulePages = async function* (...args) {
      yield* pages(...args);
      await correct("r-plain-new");
    };
    await service.reclassifyAll(USER, { clearUnmatched: true });

    const stored = await row("r-plain-new");
    expectCorrected(stored);
    expect(stored.buildIntent.opponent.detected).toEqual({ name: "Roach Rush", slug: "roach-rush" });
  });

  test("a correction cleared between staging and commit gets the plain verdict", async () => {
    const service = newService();
    const pages = service._rulePages.bind(service);
    service._rulePages = async function* (...args) {
      yield* pages(...args);
      await games.updateOne(
        { userId: USER, gameId: "r-stale" },
        clearOpponentOverridePipeline({ status: "none", build: null }),
      );
    };
    await service.reclassifyAll(USER, { clearUnmatched: true });

    const stored = await row("r-stale");
    expect(stored.opponent).toEqual({ race: "Zerg" });
    expect(stored).not.toHaveProperty("_customOpponentStrategySlug");
    expect(stored.buildIntent.opponent).toEqual(expect.objectContaining({ status: "none", applied: false }));
  });

  test("a committed verdict heals a correction whose ingest tagger was superseded", async () => {
    // A re-upload patched the agent's label over the declared build and its
    // tagger lost the revision race, so nothing restored it.
    await reupload("r-new", "Agent opp label", "rev-r-new");
    expect((await row("r-new")).opponent.strategy).toBe("Agent opp label");

    await newService().reclassifyAll(USER, { clearUnmatched: true });

    const stored = await row("r-new");
    expectCorrected(stored);
    expect(stored.buildIntent.opponent.detected).toEqual({ name: "Roach Rush", slug: "roach-rush" });
  });

  test("both axes overridden at once route each verdict to its own detected", async () => {
    await builds.insertMany([{ ...STARGATE }, { ...DT }]);
    await seedRow("r-both", {
      myBuild: "Stargate Opener",
      _customBuildSlug: "stargate-opener",
      buildLog: GATEWAY_LOG,
      oppBuildLog: ROACH_LOG,
    });
    await games.updateOne({ userId: USER, gameId: "r-both" }, [
      ...applyOverridePipeline(DT_REF, { notes: "kept" }),
      ...applyOpponentOverridePipeline(LING_REF, {}),
    ]);

    await newService().reclassifyAll(USER, {
      clearUnmatched: true,
      previousNamesBySlug: { "stargate-opener": ["Stargate Opener"] },
    });

    const stored = await row("r-both");
    expectDeclared(stored);
    expectCorrected(stored);
    expect(stored.buildIntent.detected).toEqual({ name: null, slug: null });
    expect(stored.buildIntent.opponent.detected).toEqual({ name: "Roach Rush", slug: "roach-rush" });
    expect(stored.buildIntent.notes).toBe("kept");
    expect(stored).not.toHaveProperty("_customBuildReclassify");
  });

  test("the classifier pages read the opponent detector view", async () => {
    const service = newService();
    const seen = [];
    const pages = service._rulePages.bind(service);
    service._rulePages = async function* (userId, opts) {
      for await (const page of pages(userId, opts)) {
        seen.push(...page.games.map((game) => [
          game.gameId, game.opponent?.strategy ?? null, game.customOpponentStrategySlug,
        ]));
        yield page;
      }
    };
    await service.reclassifyAll(USER, {});
    expect(seen).toEqual(expect.arrayContaining([
      ["r-generic", AGENT_STRATEGY, null],
      ["r-stale", "Pool First", "pool-first"],
      ["r-plain-new", AGENT_STRATEGY, null],
    ]));
    expect(seen.some(([, strategy, slug]) => strategy === "Ling Flood" || slug === "ling-flood"))
      .toBe(false);
  });
});

describe("opponent custom build rename", () => {
  beforeEach(async () => {
    await builds.insertMany([{ ...POOL_FIRST }, { ...LING_FLOOD }]);
    await seedRow("n-corrected", { opponent: { race: "Zerg", strategy: "Zerg - Macro" } });
    await correct("n-corrected");
    await seedRow("n-corrected-2", { opponent: { race: "Zerg", strategy: "Zerg - Macro" } });
    await correct("n-corrected-2");
    // The replay itself matched the declared build: detected follows the rename.
    await seedRow("n-agree", {
      opponent: { race: "Zerg", strategy: "Ling Flood" },
      _customOpponentStrategySlug: "ling-flood",
    });
    await correct("n-agree");
    // The classifier's own claim: renamed by reclassification, not here.
    await seedRow("n-plain", {
      opponent: { race: "Zerg", strategy: "Ling Flood" },
      _customOpponentStrategySlug: "ling-flood",
    });
  });

  test("renames corrected rows regardless of the reclassify flag and reports the change", async () => {
    const onGamesChanged = jest.fn();
    const service = newService({ onGamesChanged });
    await service.upsert(USER, { ...LING_FLOOD, userId: undefined, name: "Ling Flood v2" });

    expect(onGamesChanged).toHaveBeenCalledWith(USER, 3);
    const renamed = { ...LING_REF, name: "Ling Flood v2" };
    for (const gameId of ["n-corrected", "n-corrected-2"]) {
      const stored = await row(gameId);
      expectCorrected(stored, renamed);
      expect(stored.buildIntent.opponent.detected).toEqual({ name: "Zerg - Macro", slug: null });
    }
    const agree = await row("n-agree");
    expectCorrected(agree, renamed);
    expect(agree.buildIntent.opponent.detected).toEqual({ name: "Ling Flood v2", slug: "ling-flood" });
    expect((await row("n-plain")).opponent.strategy).toBe("Ling Flood");
    expect((await builds.findOne({ userId: USER, slug: "ling-flood" })).name).toBe("Ling Flood v2");
  });

  test("an unchanged name writes nothing and reports nothing", async () => {
    const onGamesChanged = jest.fn();
    const write = jest.spyOn(games, "updateMany");
    await newService({ onGamesChanged }).upsert(USER, { ...LING_FLOOD, description: "edited" });
    expect(write).not.toHaveBeenCalled();
    expect(onGamesChanged).not.toHaveBeenCalled();
  });

  test("a flip to the \"you\" perspective keeps the declared name frozen", async () => {
    const onGamesChanged = jest.fn();
    await newService({ onGamesChanged }).upsert(USER, {
      ...LING_FLOOD, name: "My Ling Flood", perspective: "you", race: "Protoss", vsRace: "Zerg",
    });
    expect(onGamesChanged).not.toHaveBeenCalled();
    expectCorrected(await row("n-corrected"));
  });

  test("a build flipped back to the opponent perspective renames its frozen corrections", async () => {
    await builds.updateOne(
      { userId: USER, slug: "ling-flood" },
      { $set: { perspective: "you", race: "Protoss", vsRace: "Zerg" } },
    );
    await newService({ onGamesChanged: jest.fn() }).upsert(USER, { ...LING_FLOOD, name: "Ling Flood II" });
    expectCorrected(await row("n-corrected"), { ...LING_REF, name: "Ling Flood II" });
  });

  test("an undeleted build saved under a new name renames its frozen corrections", async () => {
    const service = newService({ onGamesChanged: jest.fn() });
    await builds.updateOne({ userId: USER, slug: "ling-flood" }, { $set: { deletedAt: new Date() } });
    await service.upsert(USER, { ...LING_FLOOD, name: "Ling Flood (restored)" });
    expectCorrected(await row("n-corrected"), { ...LING_REF, name: "Ling Flood (restored)" });
    expect(await builds.findOne({ userId: USER, slug: "ling-flood" })).not.toHaveProperty("deletedAt");
  });

  test("a \"you\" build rename never touches opponent corrections", async () => {
    await builds.insertOne({ ...DT });
    await newService({ onGamesChanged: jest.fn() }).upsert(USER, { ...DT, name: "DT Rush v2" });
    expectCorrected(await row("n-corrected"));
  });
});

describe("onDefinitionsChanged", () => {
  // A delete queues a background reclassification: stop it before cleanup.
  const started = [];
  function trackedService(opts) {
    const service = newService(opts);
    started.push(service);
    return service;
  }

  afterEach(async () => {
    await Promise.all(started.splice(0).map((service) => service.stopReclassifications()));
  });

  test("hears every save and delete, including a hook assigned after construction", async () => {
    const fromOptions = jest.fn();
    const service = trackedService({ onDefinitionsChanged: fromOptions });
    await service.upsert(USER, { ...POOL_FIRST });
    expect(fromOptions).toHaveBeenCalledWith(USER);

    const assigned = jest.fn();
    service.onDefinitionsChanged = assigned;
    await service.upsert(USER, { ...POOL_FIRST, name: "Pool First v2" });
    await service.softDelete(USER, "pool-first");
    await service.softDelete(USER, "never-saved");
    expect(assigned.mock.calls).toEqual([[USER], [USER], [USER]]);
    expect(fromOptions).toHaveBeenCalledTimes(1);
  });

  test("fires only once the definition write landed", async () => {
    const onDefinitionsChanged = jest.fn(async () => {
      expect(await builds.findOne({ userId: USER, slug: "pool-first" }))
        .toEqual(expect.objectContaining({ name: "Pool First" }));
    });
    await trackedService({ onDefinitionsChanged }).upsert(USER, { ...POOL_FIRST });
    await onDefinitionsChanged.mock.results[0].value;
    expect(onDefinitionsChanged).toHaveBeenCalledTimes(1);
  });

  test("a failing listener never fails the save or the delete", async () => {
    const warn = jest.fn();
    const throwing = trackedService({
      onDefinitionsChanged: () => { throw new Error("cache down"); },
      logger: { warn },
    });
    await expect(throwing.upsert(USER, { ...POOL_FIRST })).resolves.toBeUndefined();
    await expect(throwing.softDelete(USER, "pool-first")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.any(Object), "custom_build_definitions_changed_notify_failed");
    expect(warn).toHaveBeenCalledTimes(2);

    warn.mockClear();
    const rejecting = trackedService({
      onDefinitionsChanged: () => Promise.reject(new Error("cache down")),
      logger: { warn },
    });
    await expect(rejecting.upsert(USER, { ...ROACH_RUSH })).resolves.toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));
    expect(warn).toHaveBeenCalledWith(expect.any(Object), "custom_build_definitions_changed_notify_failed");
    expect(await builds.findOne({ userId: USER, slug: "roach-rush" })).not.toBeNull();
  });
});
