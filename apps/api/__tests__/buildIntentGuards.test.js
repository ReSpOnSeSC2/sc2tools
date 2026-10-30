// @ts-nocheck
"use strict";

/**
 * Build check-in writer guards (contract §4): the custom-build classifier
 * never sees, clears or replaces a confirmed check-in. It keeps deciding
 * the detector's "you" label, which lands in ``buildIntent.detected`` on
 * override rows; every row without an override is classified exactly as
 * before.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");

const { CustomBuildsService } = require("../src/services/customBuilds");
const { PerGameComputeService } = require("../src/services/perGameCompute");
const {
  applyOverridePipeline,
  clearOverridePipeline,
} = require("../src/services/buildIntentAttribution");
const {
  tagClassificationPipeline,
  youClaimFilter,
} = require("../src/services/buildIntentGuards");

const USER = "u-guards";
const DATE = new Date("2026-10-20T18:00:00Z");
const AGENT_LABEL = "PvZ - Macro Transition (Unclassified)";

const STARGATE_LOG = ["[0:17] Pylon", "[0:49] Gateway", "[1:30] CyberneticsCore", "[3:00] Stargate"];
const GATEWAY_LOG = ["[0:17] Pylon", "[0:49] Gateway", "[1:30] CyberneticsCore"];
const POOL_LOG = ["[0:50] SpawningPool"];

function definition(slug, name, rules, extra = {}) {
  return {
    userId: USER,
    slug,
    name,
    race: "Protoss",
    vsRace: "Zerg",
    perspective: "you",
    rules,
    updatedAt: new Date("2026-10-01T00:00:00Z"),
    ...extra,
  };
}

const STARGATE = definition("stargate-opener", "Stargate Opener", [
  { type: "before", name: "BuildStargate", time_lt: 300 },
]);
const DT = definition("dt-rush", "DT Rush", [
  { type: "before", name: "BuildDarkShrine", time_lt: 420 },
]);
const POOL_FIRST = definition("pool-first", "Pool First", [
  { type: "before", name: "BuildSpawningPool", time_lt: 120 },
], { race: "Zerg", vsRace: "Protoss", perspective: "opponent" });

const DT_REF = { key: "custom:dt-rush", name: "DT Rush", slug: "dt-rush", source: "custom" };
const CATALOG_REF = { key: "pvz-dt-rush", name: "PvZ - DT Rush", slug: null, source: "catalog" };

let mongo;
let client;
let games;
let builds;
let jobs;
let definitionContext;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  const connected = await connect({ uri: mongo.getUri(), dbName: "build_intent_guards" });
  client = connected.client;
  const db = client.db("build_intent_guards");
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

/** Upload payload: what the agent sends (detector label in myBuild). */
function payload(gameId, overrides = {}) {
  return {
    gameId,
    date: DATE,
    myRace: "Protoss",
    myBuild: AGENT_LABEL,
    buildLog: STARGATE_LOG,
    oppBuildLog: POOL_LOG,
    opponent: { race: "Zerg", strategy: "Zerg - 12 Pool" },
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

async function declare(gameId, build, patch = {}) {
  await games.updateOne(
    { userId: USER, gameId },
    applyOverridePipeline(build, { origin: "web", via: "web", notes: "", ...patch }),
  );
}

/** What upsertWithRevision does on a re-upload: fresh agent label + revision. */
async function reupload(gameId, label, revision) {
  await games.updateOne(
    { userId: USER, gameId },
    { $set: { myBuild: label, _customBuildRevision: revision } },
  );
}

async function row(gameId) {
  return games.findOne({ userId: USER, gameId }, { projection: { _id: 0 } });
}

function expectDeclared(stored, build = DT_REF) {
  expect(stored.myBuild).toBe(build.name);
  if (build.source === "custom") {
    expect(stored._customBuildSlug).toBe(build.slug);
  } else {
    expect(stored).not.toHaveProperty("_customBuildSlug");
  }
  expect(stored.buildIntent).toEqual(expect.objectContaining({
    status: "confirmed",
    applied: true,
    build,
  }));
}

describe("tagSingleGame on build check-in rows", () => {
  beforeEach(async () => {
    await builds.insertMany([{ ...STARGATE }, { ...DT }, { ...POOL_FIRST }]);
  });

  test("a fresh winner refreshes detected, keeps the declared build, and returns the detector slug", async () => {
    await seedRow("t-winner", {
      _customBuildReclassify: [{ runId: "old", sequence: 1, action: "clear" }],
      _customBuildClassificationSequence: 1,
    });
    await declare("t-winner", DT_REF);

    const result = await newService().tagSingleGame(USER, payload("t-winner"), {
      expectedRevision: "rev-t-winner",
    });

    expect(result).toEqual(expect.objectContaining({
      matched: 2,
      chosenByPerspective: { you: "Stargate Opener", opponent: "Pool First" },
      userSlug: "stargate-opener",
    }));
    const stored = await row("t-winner");
    expectDeclared(stored);
    expect(stored.buildIntent.detected).toEqual({ name: "Stargate Opener", slug: "stargate-opener" });
    expect(stored.opponent.strategy).toBe("Pool First");
    expect(stored._customOpponentStrategySlug).toBe("pool-first");
    expect(stored).not.toHaveProperty("_customBuildReclassify");
    expect(stored).not.toHaveProperty("_customBuildClassificationSequence");
  });

  test("a re-upload keeps the override and refreshes detected from the agent label", async () => {
    await seedRow("t-reupload", { myBuild: "Stargate Opener", _customBuildSlug: "stargate-opener" });
    await declare("t-reupload", DT_REF);
    expect((await row("t-reupload")).buildIntent.detected)
      .toEqual({ name: "Stargate Opener", slug: "stargate-opener" });
    // GamesService patched the fresh agent label over the declared name and
    // preserved the slug; the replay no longer shows a Stargate.
    await reupload("t-reupload", "PvZ - Phoenix (agent)", "rev-2");

    const result = await newService().tagSingleGame(
      USER,
      payload("t-reupload", { myBuild: "PvZ - Phoenix (agent)", buildLog: GATEWAY_LOG }),
      { expectedRevision: "rev-2" },
    );

    expect(result.userSlug).toBeNull();
    const stored = await row("t-reupload");
    expectDeclared(stored);
    expect(stored.buildIntent.detected).toEqual({ name: "PvZ - Phoenix (agent)", slug: null });
  });

  test("an upload without a label keeps the previous detector name", async () => {
    await seedRow("t-nolabel");
    await declare("t-nolabel", DT_REF);
    const unlabelled = payload("t-nolabel", { buildLog: GATEWAY_LOG });
    delete unlabelled.myBuild;

    await newService().tagSingleGame(USER, unlabelled, { expectedRevision: "rev-t-nolabel" });

    const stored = await row("t-nolabel");
    expectDeclared(stored);
    expect(stored.buildIntent.detected).toEqual({ name: AGENT_LABEL, slug: null });
  });

  test("a deferred axis restores the detector's slug, never the declared one", async () => {
    await seedRow("t-deferred", { myBuild: "Stargate Opener", _customBuildSlug: "stargate-opener" });
    await declare("t-deferred", DT_REF);
    await builds.updateOne({ userId: USER, slug: "stargate-opener" }, { $set: { name: "Stargate Opener v2" } });
    await reupload("t-deferred", "Agent label", "rev-2");
    const service = newService();
    const lookup = jest.spyOn(service, "_getForClassification");

    // No "you" events: every "you" definition is unknown, so that axis defers.
    const result = await service.tagSingleGame(
      USER,
      payload("t-deferred", { myBuild: "Agent label", buildLog: [] }),
      { expectedRevision: "rev-2" },
    );

    expect(lookup).toHaveBeenCalledWith(USER, "stargate-opener");
    expect(lookup).not.toHaveBeenCalledWith(USER, "dt-rush");
    expect(result.userSlug).toBe("stargate-opener");
    const stored = await row("t-deferred");
    expectDeclared(stored);
    expect(stored.buildIntent.detected).toEqual({ name: "Stargate Opener v2", slug: "stargate-opener" });
    expect(stored._customOpponentStrategySlug).toBe("pool-first");
  });

  test("a deferred detector slug whose build is gone is dropped from detected only", async () => {
    await seedRow("t-deferred-gone", { myBuild: "Gone Build", _customBuildSlug: "gone-build" });
    await declare("t-deferred-gone", DT_REF);
    await reupload("t-deferred-gone", "Agent label", "rev-2");

    await newService().tagSingleGame(
      USER,
      payload("t-deferred-gone", { myBuild: "Agent label", buildLog: [] }),
      { expectedRevision: "rev-2" },
    );

    const stored = await row("t-deferred-gone");
    expectDeclared(stored);
    expect(stored.buildIntent.detected).toEqual({ name: "Agent label", slug: null });
  });

  test("with nothing to classify a re-upload still restores the declared build", async () => {
    await seedRow("t-shortcut", {
      _customBuildReclassify: [{ runId: "in-flight", sequence: 9, action: "set" }],
    });
    await declare("t-shortcut", DT_REF);
    await reupload("t-shortcut", "Agent label", "rev-2");
    await seedRow("t-shortcut-plain", { myBuild: "Agent label" });
    const service = newService();
    const write = jest.spyOn(games, "findOneAndUpdate");

    // Both axes defer (no events) and neither has a preserved slug.
    const result = await service.tagSingleGame(
      USER,
      payload("t-shortcut", { myBuild: "Agent label", buildLog: [], oppBuildLog: [] }),
      { expectedRevision: "rev-2" },
    );
    expect(result).toEqual({ gameId: "t-shortcut", matched: 0, chosen: null, ruleCount: 0 });
    const stored = await row("t-shortcut");
    expectDeclared(stored);
    expect(stored.buildIntent.detected).toEqual({ name: "Agent label", slug: null });
    // Not a classification decision: in-flight reclassify staging survives.
    expect(stored._customBuildReclassify).toEqual([{ runId: "in-flight", sequence: 9, action: "set" }]);
    expect(write).toHaveBeenCalledTimes(1);

    // A row without a check-in is not written at all, exactly as before.
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

  test("the restore-only write is revision fenced", async () => {
    await seedRow("t-shortcut-fence");
    await declare("t-shortcut-fence", DT_REF);
    await reupload("t-shortcut-fence", "Agent label", "rev-newer");

    await expect(newService().tagSingleGame(
      USER,
      payload("t-shortcut-fence", { myBuild: "Agent label", buildLog: [], oppBuildLog: [] }),
      { expectedRevision: "rev-older" },
    )).rejects.toMatchObject({ code: "custom_build_tag_superseded" });
    expect((await row("t-shortcut-fence")).myBuild).toBe("Agent label");
  });

  test("a superseded write changes nothing", async () => {
    await seedRow("t-superseded");
    await declare("t-superseded", DT_REF);
    const before = await row("t-superseded");

    await expect(newService().tagSingleGame(USER, payload("t-superseded"), {
      expectedRevision: "rev-older",
    })).rejects.toMatchObject({ code: "custom_build_tag_superseded" });
    expect(await row("t-superseded")).toEqual(before);
  });

  test("a deleted or flipped declared build stays frozen through the tagger", async () => {
    await seedRow("t-frozen");
    await declare("t-frozen", DT_REF);
    await builds.updateOne({ userId: USER, slug: "dt-rush" }, { $set: { deletedAt: new Date() } });

    await newService().tagSingleGame(USER, payload("t-frozen"), { expectedRevision: "rev-t-frozen" });
    let stored = await row("t-frozen");
    expectDeclared(stored);
    expect(stored.buildIntent.detected).toEqual({ name: "Stargate Opener", slug: "stargate-opener" });

    await builds.updateOne(
      { userId: USER, slug: "dt-rush" },
      { $unset: { deletedAt: "" }, $set: { perspective: "opponent", race: "Zerg", vsRace: "Protoss" } },
    );
    await newService().tagSingleGame(
      USER,
      payload("t-frozen", { buildLog: GATEWAY_LOG }),
      { expectedRevision: "rev-t-frozen" },
    );
    stored = await row("t-frozen");
    expectDeclared(stored);
    expect(stored.buildIntent.detected).toEqual({ name: AGENT_LABEL, slug: null });
  });

  test("a check-in confirmed mid-classification still keeps the declared build", async () => {
    await seedRow("t-race-apply");
    const service = newService();
    const iterate = service._iterateForClassification.bind(service);
    service._iterateForClassification = async function* (...args) {
      yield* iterate(...args);
      await declare("t-race-apply", DT_REF);
    };

    await service.tagSingleGame(USER, payload("t-race-apply"), { expectedRevision: "rev-t-race-apply" });

    const stored = await row("t-race-apply");
    expectDeclared(stored);
    expect(stored.buildIntent.detected).toEqual({ name: "Stargate Opener", slug: "stargate-opener" });
  });

  test("a check-in cleared mid-classification gets the plain classification", async () => {
    await seedRow("t-race-clear");
    await declare("t-race-clear", DT_REF);
    const service = newService();
    const iterate = service._iterateForClassification.bind(service);
    service._iterateForClassification = async function* (...args) {
      yield* iterate(...args);
      await games.updateOne(
        { userId: USER, gameId: "t-race-clear" },
        clearOverridePipeline({ status: "skipped", build: null }),
      );
    };

    await service.tagSingleGame(USER, payload("t-race-clear"), { expectedRevision: "rev-t-race-clear" });

    const stored = await row("t-race-clear");
    expect(stored.myBuild).toBe("Stargate Opener");
    expect(stored._customBuildSlug).toBe("stargate-opener");
    expect(stored.buildIntent).toEqual(expect.objectContaining({
      status: "skipped",
      applied: false,
      detected: null,
    }));
  });

  test("rows without a check-in are classified exactly as before", async () => {
    await seedRow("t-plain");
    await seedRow("t-plain-pending", {
      buildIntent: { status: "pending", applied: false, build: null, detected: null, notes: "x" },
    });
    await seedRow("t-plain-stale", { myBuild: "DT Rush", _customBuildSlug: "dt-rush" });

    const service = newService();
    await service.tagSingleGame(USER, payload("t-plain"), { expectedRevision: "rev-t-plain" });
    await service.tagSingleGame(USER, payload("t-plain-pending"), {
      expectedRevision: "rev-t-plain-pending",
    });
    await service.tagSingleGame(
      USER,
      payload("t-plain-stale", { myBuild: "PvZ - Agent", buildLog: GATEWAY_LOG }),
      { expectedRevision: "rev-t-plain-stale" },
    );

    const plain = await row("t-plain");
    expect(plain.myBuild).toBe("Stargate Opener");
    expect(plain._customBuildSlug).toBe("stargate-opener");
    expect(plain).not.toHaveProperty("buildIntent");
    const pending = await row("t-plain-pending");
    expect(pending.myBuild).toBe("Stargate Opener");
    expect(pending.buildIntent).toEqual({
      status: "pending", applied: false, build: null, detected: null, notes: "x",
    });
    // A definite nonmatch drops only the slug; the stored label is untouched.
    const stale = await row("t-plain-stale");
    expect(stale.myBuild).toBe("DT Rush");
    expect(stale).not.toHaveProperty("_customBuildSlug");
  });
});

describe("tagSingleGame for a user without custom builds", () => {
  test("a catalog check-in survives a re-upload and other rows lose stale slugs", async () => {
    await seedRow("z-catalog", { myBuild: "PvZ - Macro" });
    await declare("z-catalog", CATALOG_REF);
    await reupload("z-catalog", "PvZ - Macro (agent v2)", "rev-2");
    await seedRow("z-plain", {
      myBuild: "Deleted Custom",
      _customBuildSlug: "deleted-custom",
      _customOpponentStrategySlug: "deleted-opp",
    });

    const service = newService();
    const declaredResult = await service.tagSingleGame(
      USER,
      payload("z-catalog", { myBuild: "PvZ - Macro (agent v2)" }),
      { expectedRevision: "rev-2" },
    );
    await service.tagSingleGame(USER, payload("z-plain", { myBuild: "Agent" }), {
      expectedRevision: "rev-z-plain",
    });

    expect(declaredResult).toEqual({ gameId: "z-catalog", matched: 0, chosen: null, ruleCount: 0 });
    const declared = await row("z-catalog");
    expectDeclared(declared, CATALOG_REF);
    expect(declared.buildIntent.detected).toEqual({ name: "PvZ - Macro (agent v2)", slug: null });
    const plain = await row("z-plain");
    expect(plain.myBuild).toBe("Deleted Custom");
    expect(plain).not.toHaveProperty("_customBuildSlug");
    expect(plain).not.toHaveProperty("_customOpponentStrategySlug");
    expect(plain).not.toHaveProperty("buildIntent");

    await expect(service.tagSingleGame(USER, payload("z-catalog"), {
      expectedRevision: "rev-older",
    })).rejects.toMatchObject({ code: "custom_build_tag_superseded" });
  });
});

describe("tagClassificationPipeline", () => {
  test("inlines every value literally", async () => {
    await seedRow("p-literal");
    await declare("p-literal", DT_REF);
    await seedRow("p-literal-plain");
    const decision = {
      you: { mode: "set", name: "$myBuild", slug: "$slug" },
      opponent: { mode: "set", name: "$$ROOT", slug: "$opp" },
      payloadBuild: "$payload",
      clearStaging: true,
    };
    await games.updateMany(
      { userId: USER, gameId: { $in: ["p-literal", "p-literal-plain"] } },
      tagClassificationPipeline(decision),
    );

    const declared = await row("p-literal");
    expectDeclared(declared);
    expect(declared.buildIntent.detected).toEqual({ name: "$myBuild", slug: "$slug" });
    expect(declared.opponent.strategy).toBe("$$ROOT");
    const plain = await row("p-literal-plain");
    expect(plain.myBuild).toBe("$myBuild");
    expect(plain._customBuildSlug).toBe("$slug");
    expect(plain._customOpponentStrategySlug).toBe("$opp");
  });

  test("youClaimFilter matches the detector's claim, never the declared slug", async () => {
    await seedRow("f-declared", { myBuild: "Stargate Opener", _customBuildSlug: "stargate-opener" });
    await declare("f-declared", DT_REF);
    await seedRow("f-plain", { myBuild: "DT Rush", _customBuildSlug: "dt-rush" });
    const ids = async (slug) => (await games
      .find({ userId: USER, ...youClaimFilter(slug) })
      .project({ _id: 0, gameId: 1 })
      .toArray()).map((doc) => doc.gameId).sort();

    expect(await ids("dt-rush")).toEqual(["f-plain"]);
    expect(await ids("stargate-opener")).toEqual(["f-declared"]);
  });
});

describe("background reclassification on build check-in rows", () => {
  beforeEach(async () => {
    await builds.insertMany([{ ...STARGATE }, { ...DT }]);
    // Declared DT, detector generic, replay matches nothing.
    await seedRow("r-generic", { buildLog: GATEWAY_LOG });
    await declare("r-generic", DT_REF, { notes: "got scouted" });
    // Declared DT, detector already the Stargate winner.
    await seedRow("r-agree", { myBuild: "Stargate Opener", _customBuildSlug: "stargate-opener" });
    await declare("r-agree", DT_REF);
    // Declared DT, detector Stargate, but the replay no longer matches it.
    await seedRow("r-stale", {
      myBuild: "Stargate Opener",
      _customBuildSlug: "stargate-opener",
      buildLog: GATEWAY_LOG,
    });
    await declare("r-stale", DT_REF);
    // Declared DT, detector generic, the replay now matches Stargate.
    await seedRow("r-new");
    await declare("r-new", DT_REF);
    // Plain rows for comparison.
    await seedRow("r-plain-stale", {
      myBuild: "Stargate Opener",
      _customBuildSlug: "stargate-opener",
      buildLog: GATEWAY_LOG,
    });
    await seedRow("r-plain-new");
  });

  async function expectRoutedToDetected() {
    for (const gameId of ["r-generic", "r-agree", "r-stale", "r-new"]) {
      const stored = await row(gameId);
      expectDeclared(stored);
      expect([gameId, stored._customBuildReclassify]).toEqual([gameId, undefined]);
    }
    expect((await row("r-generic")).buildIntent.detected).toEqual({ name: AGENT_LABEL, slug: null });
    expect((await row("r-generic")).buildIntent.notes).toBe("got scouted");
    expect((await row("r-agree")).buildIntent.detected)
      .toEqual({ name: "Stargate Opener", slug: "stargate-opener" });
    expect((await row("r-stale")).buildIntent.detected).toEqual({ name: null, slug: null });
    expect((await row("r-new")).buildIntent.detected)
      .toEqual({ name: "Stargate Opener", slug: "stargate-opener" });
    const plainStale = await row("r-plain-stale");
    expect(plainStale).not.toHaveProperty("myBuild");
    expect(plainStale).not.toHaveProperty("_customBuildSlug");
    expect(plainStale).not.toHaveProperty("buildIntent");
    const plainNew = await row("r-plain-new");
    expect(plainNew.myBuild).toBe("Stargate Opener");
    expect(plainNew._customBuildSlug).toBe("stargate-opener");
    expect(plainNew).not.toHaveProperty("buildIntent");
  }

  test("Save & Reclassify (clearUnmatched) of the declared build routes every verdict to detected", async () => {
    const result = await newService().reclassifyAll(USER, {
      clearUnmatched: true,
      previousNamesBySlug: { "dt-rush": ["DT Rush"] },
    });
    expect(result).toEqual(expect.objectContaining({ tagged: 2, cleared: 2 }));
    await expectRoutedToDetected();
  });

  test("the single-build mode never clears the declared slug", async () => {
    const service = newService();
    // The declared build fails its own rules everywhere.
    const dt = await service.reclassify(USER, "dt-rush", { replace: true });
    expect(dt).toEqual(expect.objectContaining({ matched: 0, tagged: 0, cleared: 0 }));
    for (const gameId of ["r-generic", "r-agree", "r-stale", "r-new"]) {
      expectDeclared(await row(gameId));
    }
    const stargate = await service.reclassify(USER, "stargate-opener", { replace: true });
    expect(stargate).toEqual(expect.objectContaining({ tagged: 2, cleared: 2 }));
    await expectRoutedToDetected();
  });

  test("deleting the declared build leaves the check-in frozen", async () => {
    await builds.updateOne({ userId: USER, slug: "dt-rush" }, { $set: { deletedAt: new Date() } });
    await newService().reclassifyAll(USER, {
      clearUnmatched: true,
      previousNamesBySlug: { "dt-rush": ["DT Rush"] },
    });
    await expectRoutedToDetected();
  });

  test("flipping the declared build to the opponent perspective leaves the check-in frozen", async () => {
    await builds.updateOne(
      { userId: USER, slug: "dt-rush" },
      { $set: { perspective: "opponent", race: "Zerg", vsRace: "Protoss" } },
    );
    await newService().reclassifyAll(USER, {
      clearUnmatched: true,
      previousNamesBySlug: { "dt-rush": ["DT Rush"] },
    });
    await expectRoutedToDetected();
  });

  test("a check-in confirmed between staging and commit takes the verdict as detected", async () => {
    const service = newService();
    const pages = service._rulePages.bind(service);
    service._rulePages = async function* (...args) {
      yield* pages(...args);
      await declare("r-plain-new", DT_REF);
    };
    await service.reclassifyAll(USER, { clearUnmatched: true });

    const stored = await row("r-plain-new");
    expectDeclared(stored);
    expect(stored.buildIntent.detected).toEqual({ name: "Stargate Opener", slug: "stargate-opener" });
  });

  test("a check-in cleared between staging and commit gets the plain verdict", async () => {
    const service = newService();
    const pages = service._rulePages.bind(service);
    service._rulePages = async function* (...args) {
      yield* pages(...args);
      await games.updateOne(
        { userId: USER, gameId: "r-stale" },
        clearOverridePipeline({ status: "skipped", build: null }),
      );
    };
    await service.reclassifyAll(USER, { clearUnmatched: true });

    const stored = await row("r-stale");
    expect(stored).not.toHaveProperty("myBuild");
    expect(stored).not.toHaveProperty("_customBuildSlug");
    expect(stored.buildIntent).toEqual(expect.objectContaining({ status: "skipped", applied: false }));
  });

  test("a committed verdict heals a check-in whose ingest tagger was superseded", async () => {
    // A re-upload patched the agent's label over the declared build and its
    // tagger lost the revision race, so nothing restored it.
    await reupload("r-new", "Agent label", "rev-r-new");
    expect((await row("r-new")).myBuild).toBe("Agent label");

    await newService().reclassifyAll(USER, { clearUnmatched: true });

    const stored = await row("r-new");
    expectDeclared(stored);
    expect(stored.buildIntent.detected)
      .toEqual({ name: "Stargate Opener", slug: "stargate-opener" });
  });

  test("the classifier pages read the detector view", async () => {
    const service = newService();
    const seen = [];
    const pages = service._rulePages.bind(service);
    service._rulePages = async function* (userId, opts) {
      for await (const page of pages(userId, opts)) {
        seen.push(...page.games.map((game) => [game.gameId, game.myBuild, game.customBuildSlug]));
        yield page;
      }
    };
    await service.reclassifyAll(USER, {});
    expect(seen).toEqual(expect.arrayContaining([
      ["r-generic", AGENT_LABEL, null],
      ["r-stale", "Stargate Opener", "stargate-opener"],
    ]));
  });
});

describe("custom build rename", () => {
  beforeEach(async () => {
    await builds.insertMany([{ ...STARGATE }, { ...DT }]);
    await seedRow("n-declared", { myBuild: "PvZ - Macro" });
    await declare("n-declared", DT_REF);
    await seedRow("n-declared-2", { myBuild: "PvZ - Macro" });
    await declare("n-declared-2", DT_REF);
    // The classifier's own claim: renamed by reclassification, not here.
    await seedRow("n-plain", { myBuild: "DT Rush", _customBuildSlug: "dt-rush" });
  });

  test("renames declared rows regardless of the reclassify flag and reports the change", async () => {
    const onGamesChanged = jest.fn();
    const service = newService({ onGamesChanged });
    await service.upsert(USER, { ...DT, userId: undefined, name: "DT Rush v2" });

    expect(onGamesChanged).toHaveBeenCalledWith(USER, 2);
    for (const gameId of ["n-declared", "n-declared-2"]) {
      const stored = await row(gameId);
      expectDeclared(stored, { ...DT_REF, name: "DT Rush v2" });
      expect(stored.buildIntent.detected).toEqual({ name: "PvZ - Macro", slug: null });
    }
    expect((await row("n-plain")).myBuild).toBe("DT Rush");
    expect((await builds.findOne({ userId: USER, slug: "dt-rush" })).name).toBe("DT Rush v2");
  });

  test("an unchanged name writes nothing and reports nothing", async () => {
    const onGamesChanged = jest.fn();
    const write = jest.spyOn(games, "updateMany");
    await newService({ onGamesChanged }).upsert(USER, { ...DT, description: "edited" });
    expect(write).not.toHaveBeenCalled();
    expect(onGamesChanged).not.toHaveBeenCalled();
  });

  test("a flip to the opponent perspective keeps the declared name frozen", async () => {
    const onGamesChanged = jest.fn();
    await newService({ onGamesChanged }).upsert(USER, {
      ...DT, name: "Opp DT", perspective: "opponent", race: "Protoss", vsRace: "Zerg",
    });
    expect(onGamesChanged).not.toHaveBeenCalled();
    expectDeclared(await row("n-declared"));
  });

  test("an undeleted build saved under a new name renames its frozen check-ins", async () => {
    const service = newService({ onGamesChanged: jest.fn() });
    await builds.updateOne({ userId: USER, slug: "dt-rush" }, { $set: { deletedAt: new Date() } });
    await service.upsert(USER, { ...DT, name: "DT Rush (restored)" });
    expectDeclared(await row("n-declared"), { ...DT_REF, name: "DT Rush (restored)" });
    expect(await builds.findOne({ userId: USER, slug: "dt-rush" })).not.toHaveProperty("deletedAt");
  });

  test("hosts wiring only onReclassified hear the rename as tagged games", async () => {
    const onReclassified = jest.fn();
    await newService({ onReclassified }).upsert(USER, { ...DT, name: "DT Rush v3" });
    expect(onReclassified).toHaveBeenCalledWith(USER, expect.objectContaining({ tagged: 2, cleared: 0 }));
  });

  test("a failing listener never fails the save", async () => {
    const warn = jest.fn();
    const service = newService({
      onGamesChanged: () => { throw new Error("socket down"); },
      logger: { warn },
    });
    await expect(service.upsert(USER, { ...DT, name: "DT Rush v4" })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.any(Object), "custom_build_games_changed_notify_failed");
    expect((await row("n-declared")).myBuild).toBe("DT Rush v4");
  });
});

describe("rule-preview views (perGameCompute)", () => {
  beforeEach(async () => {
    await seedRow("v-declared", { myBuild: "Stargate Opener", _customBuildSlug: "stargate-opener" });
    await declare("v-declared", DT_REF);
    await seedRow("v-declared-generic", { date: new Date("2026-10-19T18:00:00Z") });
    await declare("v-declared-generic", CATALOG_REF);
    await seedRow("v-executed", { date: new Date("2026-10-18T18:00:00Z"), myBuild: "DT Rush", _customBuildSlug: "dt-rush" });
    await declare("v-executed", DT_REF);
    await seedRow("v-plain", { date: new Date("2026-10-17T18:00:00Z"), myBuild: "Plain", _customBuildSlug: "plain" });
  });

  async function collect(opts) {
    const perGame = new PerGameComputeService({ games });
    const out = [];
    for await (const page of perGame.iterateRulePreviewPages(USER, opts)) out.push(...page.games);
    return out;
  }

  test("the detector view relabels override rows for the caller and the metadata gate", async () => {
    const gated = [];
    const viewed = await collect({
      view: "detector",
      metadataFilter: (game) => {
        gated.push([game.gameId, game.myBuild, game._customBuildSlug ?? null]);
        return true;
      },
    });
    const labels = viewed.map((game) => [game.gameId, game.myBuild, game.customBuildSlug]);
    expect(labels).toEqual([
      ["v-declared", "Stargate Opener", "stargate-opener"],
      ["v-declared-generic", AGENT_LABEL, null],
      ["v-executed", "DT Rush", "dt-rush"],
      ["v-plain", "Plain", "plain"],
    ]);
    expect(gated).toEqual(labels);
    expect(viewed.every((game) => !("buildIntent" in game))).toBe(true);

    const effective = await collect({});
    expect(effective.map((game) => [game.gameId, game.myBuild, game.customBuildSlug])).toEqual([
      ["v-declared", "DT Rush", "dt-rush"],
      ["v-declared-generic", "PvZ - DT Rush", null],
      ["v-executed", "DT Rush", "dt-rush"],
      ["v-plain", "Plain", "plain"],
    ]);
  });

  test("the agreeing view drops disagreeing check-ins and keeps filter-bar clauses", async () => {
    await games.updateMany({ userId: USER }, { $set: { matchFormat: "1v1" } });
    await seedRow("v-team", { date: new Date("2026-10-16T18:00:00Z"), matchFormat: "team" });
    const ids = (rows) => rows.map((game) => game.gameId);

    expect(ids(await collect({ view: "agreeing" })))
      .toEqual(["v-executed", "v-plain", "v-team"]);
    expect(ids(await collect({ view: "agreeing", filters: { gameSize: "1v1" } })))
      .toEqual(["v-executed", "v-plain"]);
    // A caller's own $and joins the filter bar's instead of replacing it.
    expect(ids(await collect({
      filters: { gameSize: "1v1" },
      match: { $and: [{ myBuild: { $ne: "Plain" } }] },
    }))).toEqual(["v-declared", "v-declared-generic", "v-executed"]);
  });

  test("listForRulePreview honours both views", async () => {
    const perGame = new PerGameComputeService({ games });
    const detector = await perGame.listForRulePreview(USER, { view: "detector" });
    expect(detector.map((game) => [game.gameId, game.myBuild, game.customBuildSlug])).toEqual([
      ["v-declared", "Stargate Opener", "stargate-opener"],
      ["v-declared-generic", AGENT_LABEL, null],
      ["v-executed", "DT Rush", "dt-rush"],
      ["v-plain", "Plain", "plain"],
    ]);
    const agreeing = await perGame.listForRulePreview(USER, { view: "agreeing" });
    expect(agreeing.map((game) => game.gameId)).toEqual(["v-executed", "v-plain"]);
    const effective = await perGame.listForRulePreview(USER, {});
    expect(effective[0]).toEqual(expect.objectContaining({ gameId: "v-declared", myBuild: "DT Rush" }));
    expect(effective[0]).not.toHaveProperty("customBuildSlug");
    expect(effective[0]).not.toHaveProperty("buildIntent");
  });
});
