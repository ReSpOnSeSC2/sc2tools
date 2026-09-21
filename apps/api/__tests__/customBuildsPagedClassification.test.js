// @ts-nocheck
"use strict";

const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");
const { CustomBuildsService } = require("../src/services/customBuilds");
const { PerGameComputeService } = require("../src/services/perGameCompute");

const USER_ID = "paged-classification";
const PYLON = { type: "before", name: "BuildPylon", time_lt: 60 };
const GATEWAY = { type: "before", name: "BuildGateway", time_lt: 90 };
const DEPOT = { type: "before", name: "BuildSupplyDepot", time_lt: 60 };

function definition(index, overrides = {}) {
  return {
    userId: USER_ID,
    slug: `build-${String(index).padStart(3, "0")}`,
    name: `Build ${index}`,
    race: "Protoss",
    vsRace: "Terran",
    perspective: "you",
    rules: [{ type: "before", name: "BuildStargate", time_lt: 60 }],
    updatedAt: new Date("2026-08-01T00:00:00Z"),
    ...overrides,
  };
}

function replay(index = 0, overrides = {}) {
  return {
    userId: USER_ID,
    gameId: `game-${index}`,
    date: new Date("2026-08-02T00:00:00Z"),
    myRace: "Protoss",
    myBuild: "Agent build",
    buildLog: ["[0:17] Pylon", "[0:49] Gateway"],
    oppBuildLog: ["[0:17] SupplyDepot", "[1:00] Barracks"],
    opponent: { race: "Terran", strategy: "Agent strategy" },
    ...overrides,
  };
}

describe("classification across bounded custom-build pages", () => {
  let mongo;
  let client;
  let db;
  let games;
  let builds;
  let service;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = new MongoClient(mongo.getUri());
    await client.connect();
    db = client.db("custom_build_paged_classification");
    games = db.collection("games");
    builds = db.collection("custom_builds");
    await builds.createIndex({ userId: 1, slug: 1 }, { unique: true });
    await games.createIndex({ userId: 1, date: -1, _id: -1 });
  });

  beforeEach(() => {
    service = new CustomBuildsService(
      { games, customBuilds: builds },
      { perGame: new PerGameComputeService({ games }) },
    );
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await games.deleteMany({});
    await builds.deleteMany({});
  });

  afterAll(async () => {
    await client?.close();
    await mongo?.stop();
  });

  test("finds both winners beyond 100 builds while paging builds and replays", async () => {
    const definitions = Array.from({ length: 137 }, (_, i) => definition(i));
    definitions[0] = definition(0, { rules: [PYLON] });
    definitions[135] = definition(135, {
      race: "Terran", vsRace: "Protoss", perspective: "opponent", rules: [DEPOT],
    });
    definitions[136] = definition(136, { rules: [PYLON, GATEWAY] });
    await builds.insertMany(definitions);
    await games.insertMany(Array.from({ length: 51 }, (_, i) => replay(i)));
    const iterator = service._iterateForClassification.bind(service);
    const sizes = [];
    service._iterateForClassification = async function* (...args) {
      for await (const batch of iterator(...args)) {
        sizes.push(batch.length);
        yield batch;
      }
    };
    const progress = [];
    const result = await service.reclassifyAll(USER_ID, {
      onProgress: (value) => progress.push(value),
    });
    expect(result).toMatchObject({
      builds: 137, scanned: 51, tagged: 102, cleared: 0, deferred: 0,
      perBuildTruncated: true,
    });
    expect(result.perBuild).toHaveLength(100);
    expect(result.perBuild[0]).toMatchObject({ matched: 51, tagged: 0 });
    expect(Math.max(...sizes)).toBeLessThanOrEqual(50);
    expect(sizes.filter((size) => size === 37)).toHaveLength(progress.length + 1);
    expect(progress.length).toBeGreaterThan(1);
    expect(progress.every((value) => value.builds === 137)).toBe(true);
    expect(await games.countDocuments({
      _customBuildSlug: "build-136", _customOpponentStrategySlug: "build-135",
    })).toBe(51);
    const single = await service.tagSingleGame(USER_ID, replay(0));
    expect(single).toMatchObject({
      matched: 3,
      chosenByPerspective: { you: "Build 136", opponent: "Build 135" },
    });
  });

  test.each(["history", "ingest"])(
    "%s resolves equal-specificity ties by newest edit then slug across page boundaries",
    async (mode) => {
      const definitions = Array.from({ length: 125 }, (_, i) => definition(i));
      definitions[49] = definition(49, { rules: [PYLON] });
      definitions[50] = definition(50, { rules: [PYLON] });
      definitions[124] = definition(124, { rules: [PYLON] });
      await builds.insertMany(definitions);
      await games.insertOne(replay());
      const classify = () => mode === "history"
        ? service.reclassifyAll(USER_ID)
        : service.tagSingleGame(USER_ID, replay());
      await classify();
      expect((await games.findOne({ gameId: "game-0" }))._customBuildSlug)
        .toBe("build-049");
      await builds.updateOne({ slug: "build-124" }, {
        $set: { updatedAt: new Date("2026-08-03T00:00:00Z") },
      });
      await classify();
      expect((await games.findOne({ gameId: "game-0" }))._customBuildSlug)
        .toBe("build-124");
    },
  );

  test.each(["history", "ingest"])(
    "%s defers a later higher-priority proxy candidate and keeps the other axis independent",
    async (mode) => {
      const definitions = Array.from({ length: 125 }, (_, i) => definition(i));
      definitions[0] = definition(0, { rules: [PYLON] });
      definitions[123] = definition(123, {
        race: "Terran", vsRace: "Protoss", perspective: "opponent", rules: [DEPOT],
      });
      definitions[124] = definition(124, {
        name: "Renamed proxy opener",
        rules: [PYLON, { ...GATEWAY, proxy: true }],
      });
      await builds.insertMany(definitions);
      await games.insertOne(replay(0, {
        myBuild: "Renamed proxy opener", _customBuildSlug: "build-124",
      }));
      const lookup = jest.spyOn(service, "_getForClassification");
      if (mode === "history") {
        const result = await service.reclassifyAll(USER_ID, { clearUnmatched: true });
        expect(result.deferred).toBe(1);
      } else {
        // Re-upload initially restores the agent name. The deferred classifier
        // must restore the saved definition's current name together with its slug.
        await games.updateOne({ gameId: "game-0" }, { $set: { myBuild: "Agent build" } });
        await service.tagSingleGame(USER_ID, replay());
        expect(lookup).toHaveBeenCalledWith(USER_ID, "build-124");
      }
      const stored = await games.findOne({ gameId: "game-0" });
      expect(stored.myBuild).toBe("Renamed proxy opener");
      expect(stored._customBuildSlug).toBe("build-124");
      expect(stored._customOpponentStrategySlug).toBe("build-123");
    },
  );

  test.each(["history", "ingest"])(
    "%s publishes no early winner when a later build page fails",
    async (mode) => {
      const definitions = Array.from({ length: 125 }, (_, i) => definition(i));
      definitions[0] = definition(0, { rules: [PYLON] });
      await builds.insertMany(definitions);
      await games.insertOne(replay());
      const iterator = service._iterateForClassification.bind(service);
      let scans = 0;
      service._iterateForClassification = async function* (...args) {
        scans += 1;
        const failThisScan = mode === "ingest" || scans === 2;
        for await (const batch of iterator(...args)) {
          yield batch;
          if (failThisScan) throw new Error("later_build_page_failed");
        }
      };
      const write = jest.spyOn(games, mode === "history" ? "bulkWrite" : "updateOne");
      const result = mode === "history"
        ? service.reclassifyAll(USER_ID)
        : service.tagSingleGame(USER_ID, replay());
      await expect(result).rejects.toThrow("later_build_page_failed");
      expect(write).not.toHaveBeenCalled();
      const stored = await games.findOne({ gameId: "game-0" });
      expect(stored.myBuild).toBe("Agent build");
      expect(stored._customBuildSlug).toBeUndefined();
      expect(stored._customBuildReclassify).toBeUndefined();
    },
  );

  test("clears only owned stale claims including definitions beyond the first pages", async () => {
    await builds.insertMany(Array.from({ length: 125 }, (_, i) => definition(i)));
    await games.insertMany([
      replay(0, { myBuild: "Build 124", _customBuildSlug: "build-124" }),
      replay(1, { myBuild: "Build 124" }),
      replay(2, { myBuild: "Deleted old name", _customBuildSlug: "deleted-build" }),
    ]);
    const result = await service.reclassifyAll(USER_ID, {
      clearUnmatched: true,
      previousNamesBySlug: { "deleted-build": ["Deleted old name"] },
    });
    expect(result.cleared).toBe(2);
    expect((await games.findOne({ gameId: "game-0" })).myBuild).toBeUndefined();
    expect((await games.findOne({ gameId: "game-1" })).myBuild).toBe("Build 124");
    expect((await games.findOne({ gameId: "game-2" })).myBuild).toBeUndefined();
  });

  test("reports the entire library even when no replay pages exist", async () => {
    await builds.insertMany(Array.from({ length: 125 }, (_, i) => definition(i)));
    const result = await service.reclassifyAll(USER_ID);
    expect(result).toMatchObject({
      builds: 125, scanned: 0, tagged: 0, perBuildTruncated: true,
    });
    expect(result.perBuild).toHaveLength(100);
  });

  test("rolls back earlier stages when an unqueued edit changes the library between replay pages", async () => {
    const definitions = Array.from({ length: 125 }, (_, i) => definition(i));
    definitions[124] = definition(124, { rules: [PYLON] });
    await builds.insertMany(definitions);
    await games.insertMany([replay(0), replay(1)]);
    const iterator = service._rulePages.bind(service);
    let edited = false;
    service._rulePages = async function* (...args) {
      for await (const page of iterator(...args)) {
        yield page;
        if (!edited) {
          edited = true;
          // The first replay has a staged decision, but no public labels yet.
          expect(await games.countDocuments({ _customBuildReclassify: { $exists: true } }))
            .toBe(1);
          await service.upsert(USER_ID, {
            ...definition(124), name: "Edited without queueing", rules: [GATEWAY],
          });
        }
      }
    };
    await expect(service.reclassifyAll(USER_ID))
      .rejects.toThrow("custom_build_library_changed");
    expect(await games.countDocuments({ myBuild: "Agent build" })).toBe(2);
    expect(await games.countDocuments({ _customBuildReclassify: { $exists: true } })).toBe(0);
    // A subsequent attempt reads the new library consistently and succeeds.
    const result = await service.reclassifyAll(USER_ID);
    expect(result.tagged).toBe(2);
    expect(await games.countDocuments({ myBuild: "Edited without queueing" })).toBe(2);
  });
});
