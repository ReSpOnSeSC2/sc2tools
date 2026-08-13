// @ts-nocheck
"use strict";
/* eslint-disable max-lines-per-function */

const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");
const express = require("express");
const request = require("supertest");

const {
  PerGameComputeService,
} = require("../src/services/perGameCompute");
const { MongoDetailsStore } = require("../src/services/gameDetailsStore");
const { CustomBuildsService } = require("../src/services/customBuilds");
const { GamesService } = require("../src/services/games");
const { GdprService } = require("../src/services/gdpr");
const { buildCustomBuildsRouter } = require("../src/routes/customBuilds");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolve_, reject_) => {
    resolve = resolve_;
    reject = reject_;
  });
  return { promise, resolve, reject };
}

async function waitForCondition(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return Boolean(await predicate());
}

function abortError(message = "aborted") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

describe("custom-build rule scan memory safety", () => {
  let mongo;
  let client;
  let db;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = new MongoClient(mongo.getUri());
    await client.connect();
    db = client.db("custom_build_memory_safety");
    await db.collection("games").createIndex({ userId: 1, date: -1, _id: -1 });
  });

  afterEach(async () => {
    await db.collection("games").deleteMany({});
    await db.collection("custom_builds").deleteMany({});
    await db.collection("custom_build_jobs").deleteMany({});
  });

  afterAll(async () => {
    if (client) await client.close();
    if (mongo) await mongo.stop();
  });

  test("hydrates details in bounded pages and applies the metadata gate first", async () => {
    const userId = "u-bounded";
    const date = new Date("2026-08-13T12:00:00.000Z");
    const rows = Array.from({ length: 137 }, (_, i) => ({
      userId,
      gameId: `bounded-${String(i).padStart(3, "0")}`,
      date,
      myRace: "Protoss",
      opponent: { race: i % 2 === 0 ? "Terran" : "Zerg" },
      isResumedFromReplay: false,
    }));
    await db.collection("games").insertMany(rows);

    const findMany = jest.fn(async (_uid, ids, opts) => {
      expect(ids.length).toBeLessThanOrEqual(25);
      expect(opts).toEqual(
        expect.objectContaining({
          fields: ["buildLog"],
          concurrency: expect.any(Number),
        }),
      );
      return new Map(
        ids.map((id) => [id, { buildLog: ["[0:17] Pylon"] }]),
      );
    });
    const service = new PerGameComputeService(
      { games: db.collection("games") },
      { gameDetails: { findMany } },
    );

    const seen = [];
    for await (const page of service.iterateRulePreviewPages(userId, {
      pageSize: 25,
      perspective: "you",
      metadataFilter: (game) => game.opponent?.race === "Terran",
    })) {
      seen.push(...page.games);
    }

    expect(seen).toHaveLength(69);
    expect(seen.every((game) => game.oppRace === "Terran")).toBe(true);
    expect(findMany).toHaveBeenCalledTimes(6);
    expect(
      findMany.mock.calls.reduce((total, call) => total + call[1].length, 0),
    ).toBe(69);
  });

  test.each([
    {
      perspective: "you",
      fields: ["buildLog"],
      populatedSide: "events",
      emptySide: "oppEvents",
    },
    {
      perspective: "opponent",
      fields: ["oppBuildLog"],
      populatedSide: "oppEvents",
      emptySide: "events",
    },
  ])(
    "hydrates only the $perspective perspective's detail fields",
    async ({ perspective, fields, populatedSide, emptySide }) => {
      const userId = `u-${perspective}`;
      await db.collection("games").insertOne({
        userId,
        gameId: `${perspective}-1`,
        date: new Date("2026-08-13T13:00:00.000Z"),
        myRace: "Protoss",
        opponent: { race: "Terran" },
      });

      const findMany = jest.fn(async (_uid, ids, opts) => {
        expect(opts.fields).toEqual(fields);
        const field = fields[0];
        return new Map(ids.map((id) => [id, { [field]: ["[0:17] Pylon"] }]));
      });
      const service = new PerGameComputeService(
        { games: db.collection("games") },
        { gameDetails: { findMany } },
      );

      const output = [];
      for await (const page of service.iterateRulePreviewPages(userId, {
        pageSize: 10,
        perspective,
      })) {
        output.push(...page.games);
      }

      expect(findMany).toHaveBeenCalledTimes(1);
      expect(output).toHaveLength(1);
      expect(output[0][populatedSide]).toHaveLength(1);
      expect(output[0][emptySide]).toEqual([]);
      expect(output[0].detailAvailable).toBe(true);
    },
  );

  test("the Mongo detail store projects away unrequested heavy fields", async () => {
    const collection = db.collection("game_details_projection");
    const store = new MongoDetailsStore({ gameDetails: collection });
    await store.write("u-projection", "projected-1", new Date(), {
      buildLog: ["[0:17] Pylon"],
      oppBuildLog: ["[0:17] SupplyDepot"],
      macroBreakdown: { stats_events: Array.from({ length: 100 }, () => ({ m: 1 })) },
    });

    const blobs = await store.readMany("u-projection", ["projected-1"], {
      fields: ["oppBuildLog"],
    });

    expect(blobs.get("projected-1")).toEqual({
      oppBuildLog: ["[0:17] SupplyDepot"],
    });
  });

  test("uses _id as a stable tie-breaker when every replay has the same date", async () => {
    const userId = "u-same-date";
    const date = new Date("2026-08-13T14:00:00.000Z");
    const ids = Array.from({ length: 137 }, (_, i) => `same-date-${i}`);
    await db.collection("games").insertMany(
      ids.map((gameId) => ({
        userId,
        gameId,
        date,
        myRace: "Protoss",
        opponent: { race: "Terran" },
        buildLog: ["[0:17] Pylon"],
      })),
    );
    const service = new PerGameComputeService(
      { games: db.collection("games") },
    );

    const seen = [];
    const pageSizes = [];
    for await (const page of service.iterateRulePreviewPages(userId, {
      pageSize: 17,
      perspective: "you",
    })) {
      seen.push(...page.games.map((game) => game.gameId));
      pageSizes.push(page.games.length);
    }

    expect(seen).toHaveLength(ids.length);
    expect(new Set(seen).size).toBe(ids.length);
    expect(new Set(seen)).toEqual(new Set(ids));
    expect(pageSizes).toEqual([17, 17, 17, 17, 17, 17, 17, 17, 1]);
  });

  test("walks legacy string and null dates after current BSON Date rows", async () => {
    const userId = "u-mixed-date-types";
    const currentRows = Array.from({ length: 11 }, (_, index) => ({
      userId,
      gameId: `date-current-${index}`,
      date: new Date(`2026-08-${String(index + 1).padStart(2, "0")}T14:00:00.000Z`),
      buildLog: ["[0:17] Pylon"],
    }));
    await db.collection("games").insertMany([
      ...currentRows,
      {
        userId,
        gameId: "date-legacy-string",
        date: "2025-01-02T00:00:00.000Z",
        buildLog: ["[0:17] Pylon"],
      },
      {
        userId,
        gameId: "date-legacy-null",
        date: null,
        buildLog: ["[0:17] Pylon"],
      },
    ]);
    const service = new PerGameComputeService({ games: db.collection("games") });
    const seen = [];

    for await (const page of service.iterateRulePreviewPages(userId, {
      pageSize: 10,
      perspective: "you",
    })) {
      seen.push(...page.games.map((game) => game.gameId));
    }

    expect(new Set(seen)).toEqual(new Set([
      ...currentRows.map((row) => row.gameId),
      "date-legacy-string",
      "date-legacy-null",
    ]));
  });

  test("reclassifies the complete library beyond the former 1,000-game cap", async () => {
    const userId = "u-full-library";
    const slug = "full-library-build";
    const buildName = "Full library build";
    const total = 1_101;
    const games = Array.from({ length: total }, (_, i) => ({
      userId,
      gameId: `full-${String(i).padStart(4, "0")}`,
      // Replay timestamps are only second-granular, so large resync batches can
      // legitimately contain many ties. Keep every row tied to prove the _id
      // cursor reaches the oldest game even beyond the former 1,000-row cap.
      date: new Date("2026-08-13T12:00:00.000Z"),
      myRace: "Protoss",
      opponent: { race: "Terran" },
      buildLog: ["[0:17] Pylon", "[0:49] Gateway"],
      myBuild: "Old classifier label",
      isResumedFromReplay: false,
    }));
    await db.collection("games").insertMany(games);

    const perGame = new PerGameComputeService({ games: db.collection("games") });
    const service = new CustomBuildsService(
      {
        games: db.collection("games"),
        customBuilds: db.collection("custom_builds"),
      },
      { perGame },
    );
    await service.upsert(userId, {
      slug,
      name: buildName,
      race: "Protoss",
      vsRace: "Terran",
      rules: [{ type: "before", name: "BuildPylon", time_lt: 60 }],
    });

    const result = await service.reclassify(userId, slug, { replace: false });

    expect(result).toEqual(expect.objectContaining({
      scanned: total,
      matched: total,
      tagged: total,
    }));
    expect(await db.collection("games").countDocuments({
      userId,
      myBuild: buildName,
    })).toBe(total);
    expect((await db.collection("games").findOne({
      userId,
      gameId: "full-0000",
    })).myBuild).toBe(buildName);
  });

  test("reclassify-all also reaches every game beyond 1,000 tied rows", async () => {
    const userId = "u-full-library-all";
    const buildName = "Full library all build";
    const total = 1_101;
    await db.collection("games").insertMany(
      Array.from({ length: total }, (_, i) => ({
        userId,
        gameId: `full-all-${String(i).padStart(4, "0")}`,
        date: new Date("2026-08-13T12:30:00.000Z"),
        myRace: "Protoss",
        opponent: { race: "Terran" },
        buildLog: ["[0:17] Pylon"],
        myBuild: "Old classifier label",
        isResumedFromReplay: false,
      })),
    );
    const perGame = new PerGameComputeService({ games: db.collection("games") });
    const service = new CustomBuildsService(
      {
        games: db.collection("games"),
        customBuilds: db.collection("custom_builds"),
      },
      { perGame },
    );
    await service.upsert(userId, {
      slug: "full-library-all",
      name: buildName,
      race: "Protoss",
      vsRace: "Terran",
      rules: [{ type: "before", name: "BuildPylon", time_lt: 60 }],
    });

    const result = await service.reclassifyAll(userId);

    expect(result.scanned).toBe(total);
    expect(result.tagged).toBe(total);
    expect(await db.collection("games").countDocuments({
      userId,
      myBuild: buildName,
    })).toBe(total);
  });

  test("reclassify-all keeps the most-specific claim when builds overlap", async () => {
    const userId = "u-closest-claim";
    await db.collection("games").insertOne({
      userId,
      gameId: "overlapping-builds",
      date: new Date("2026-08-13T12:45:00.000Z"),
      myRace: "Protoss",
      opponent: { race: "Terran" },
      buildLog: ["[0:17] Pylon", "[0:49] Gateway"],
      myBuild: "Old classifier label",
    });
    const perGame = new PerGameComputeService({ games: db.collection("games") });
    const service = new CustomBuildsService(
      {
        games: db.collection("games"),
        customBuilds: db.collection("custom_builds"),
      },
      { perGame },
    );
    await service.upsert(userId, {
      slug: "generic-build",
      name: "Generic build",
      race: "Protoss",
      vsRace: "Terran",
      rules: [{ type: "before", name: "BuildPylon", time_lt: 60 }],
    });
    await service.upsert(userId, {
      slug: "specific-build",
      name: "Specific build",
      race: "Protoss",
      vsRace: "Terran",
      rules: [
        { type: "before", name: "BuildPylon", time_lt: 60 },
        { type: "before", name: "BuildGateway", time_lt: 120 },
      ],
    });

    await service.reclassifyAll(userId);

    const game = await db.collection("games").findOne({
      userId,
      gameId: "overlapping-builds",
    });
    expect(game.myBuild).toBe("Specific build");
  });

  test("a rename re-tags matches and clears the old name from definite nonmatches", async () => {
    const userId = "u-rename";
    await db.collection("games").insertMany([
      {
        userId,
        gameId: "rename-match",
        date: new Date("2026-08-13T16:00:00.000Z"),
        myRace: "Protoss",
        opponent: { race: "Terran" },
        buildLog: ["[0:17] Pylon"],
        myBuild: "Old build name",
        _customBuildSlug: "renamed-build",
      },
      {
        userId,
        gameId: "rename-stale",
        date: new Date("2026-08-13T15:59:00.000Z"),
        myRace: "Protoss",
        opponent: { race: "Terran" },
        buildLog: ["[0:49] Gateway"],
        myBuild: "Old build name",
        _customBuildSlug: "renamed-build",
      },
    ]);
    const perGame = new PerGameComputeService({ games: db.collection("games") });
    const service = new CustomBuildsService(
      {
        games: db.collection("games"),
        customBuilds: db.collection("custom_builds"),
      },
      { perGame },
    );
    await service.upsert(userId, {
      slug: "renamed-build",
      name: "New build name",
      race: "Protoss",
      vsRace: "Terran",
      rules: [{ type: "before", name: "BuildPylon", time_lt: 60 }],
    });

    await service.reclassify(userId, "renamed-build", {
      replace: true,
      previousName: "Old build name",
    });

    const renamed = await db.collection("games").findOne({ gameId: "rename-match" });
    const stale = await db.collection("games").findOne({ gameId: "rename-stale" });
    expect(renamed.myBuild).toBe("New build name");
    expect(stale.myBuild).toBeUndefined();
  });

  test("a matchup change clears the old tag from games outside the new matchup", async () => {
    const userId = "u-matchup-change";
    await db.collection("games").insertOne({
      userId,
      gameId: "old-pvt-game",
      date: new Date("2026-08-13T17:00:00.000Z"),
      myRace: "Protoss",
      opponent: { race: "Terran" },
      buildLog: ["[0:17] Pylon"],
      myBuild: "Matchup build",
      _customBuildSlug: "matchup-build",
    });
    const perGame = new PerGameComputeService({ games: db.collection("games") });
    const service = new CustomBuildsService(
      {
        games: db.collection("games"),
        customBuilds: db.collection("custom_builds"),
      },
      { perGame },
    );
    await service.upsert(userId, {
      slug: "matchup-build",
      name: "Matchup build",
      race: "Protoss",
      vsRace: "Zerg",
      rules: [{ type: "before", name: "BuildPylon", time_lt: 60 }],
    });

    await service.reclassify(userId, "matchup-build", { replace: true });

    const oldMatchup = await db.collection("games").findOne({
      userId,
      gameId: "old-pvt-game",
    });
    expect(oldMatchup.myBuild).toBeUndefined();
  });

  test("a missing detail blob is never treated as a definite nonmatch", async () => {
    const userId = "u-missing-detail";
    const buildName = "Preserve unknown build";
    await db.collection("games").insertOne({
      userId,
      gameId: "missing-detail",
      date: new Date("2026-08-13T18:00:00.000Z"),
      myRace: "Protoss",
      opponent: { race: "Terran" },
      myBuild: buildName,
    });
    const perGame = new PerGameComputeService({ games: db.collection("games") });
    const service = new CustomBuildsService(
      {
        games: db.collection("games"),
        customBuilds: db.collection("custom_builds"),
      },
      { perGame },
    );
    await service.upsert(userId, {
      slug: "preserve-unknown",
      name: buildName,
      race: "Protoss",
      vsRace: "Terran",
      rules: [{ type: "before", name: "BuildPylon", time_lt: 60 }],
    });

    await service.reclassify(userId, "preserve-unknown", { replace: true });

    const unknown = await db.collection("games").findOne({
      userId,
      gameId: "missing-detail",
    });
    expect(unknown.myBuild).toBe(buildName);
  });

  test("never clears stale tags when a later detail page fails", async () => {
    const userId = "u-failed-scan";
    const slug = "safe-build";
    const buildName = "Safe build";
    await db.collection("games").insertOne({
      userId,
      gameId: "stale-before-failure",
      date: new Date("2026-08-13T15:00:00.000Z"),
      myRace: "Protoss",
      opponent: { race: "Terran" },
      myBuild: buildName,
    });

    const perGame = {
      async *iterateRulePreviewPages() {
        yield {
          games: [{
            gameId: "stale-before-failure",
            myBuild: buildName,
            myRace: "Protoss",
            oppRace: "Terran",
            opponent: { race: "Terran" },
            events: [{ name: "BuildGateway", time: 120 }],
            oppEvents: [],
            detailAvailable: true,
          }],
          candidates: 1,
          hasMore: true,
        };
        throw new Error("detail page failed");
      },
    };
    const service = new CustomBuildsService(
      {
        games: db.collection("games"),
        customBuilds: db.collection("custom_builds"),
      },
      { perGame },
    );
    await service.upsert(userId, {
      slug,
      name: buildName,
      race: "Protoss",
      vsRace: "Terran",
      rules: [{ type: "before", name: "BuildPylon", time_lt: 60 }],
    });

    await expect(service.reclassify(userId, slug, { replace: true }))
      .rejects.toThrow("detail page failed");

    const row = await db.collection("games").findOne({
      userId,
      gameId: "stale-before-failure",
    });
    expect(row.myBuild).toBe(buildName);
  });

  test("aborting after a staged first page never clears stale tags", async () => {
    const userId = "u-aborted-scan";
    const slug = "abort-safe-build";
    const buildName = "Abort-safe build";
    const controller = new AbortController();
    await db.collection("games").insertOne({
      userId,
      gameId: "stale-before-abort",
      date: new Date("2026-08-13T18:30:00.000Z"),
      myRace: "Protoss",
      opponent: { race: "Terran" },
      myBuild: buildName,
    });
    const perGame = {
      async *iterateRulePreviewPages() {
        yield {
          games: [{
            gameId: "stale-before-abort",
            myBuild: buildName,
            myRace: "Protoss",
            oppRace: "Terran",
            opponent: { race: "Terran" },
            events: [{ name: "BuildGateway", time: 120 }],
            oppEvents: [],
            detailAvailable: true,
          }],
          candidates: 1,
          hasMore: true,
        };
        controller.abort();
        yield { games: [], candidates: 0, hasMore: false };
      },
    };
    const service = new CustomBuildsService(
      {
        games: db.collection("games"),
        customBuilds: db.collection("custom_builds"),
      },
      { perGame },
    );
    await service.upsert(userId, {
      slug,
      name: buildName,
      race: "Protoss",
      vsRace: "Terran",
      rules: [{ type: "before", name: "BuildPylon", time_lt: 60 }],
    });

    await expect(service.reclassify(userId, slug, {
      replace: true,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });

    const row = await db.collection("games").findOne({
      userId,
      gameId: "stale-before-abort",
    });
    expect(row.myBuild).toBe(buildName);
    expect(row._customBuildReclassify).toBeUndefined();
  });

  test("rapid A to B to C saves retain every prior name in the final queued job", async () => {
    const userId = "u-rapid-rename";
    const slug = "rapid-rename";
    const jobs = db.collection("custom_build_jobs");
    const service = new CustomBuildsService(
      {
        games: db.collection("games"),
        customBuilds: db.collection("custom_builds"),
        customBuildJobs: jobs,
      },
      { perGame: {} },
    );
    service._startReclassifyWorker = jest.fn();

    await service.upsert(userId, { slug, name: "Name A", race: "Protoss" });
    await service.enqueueReclassify(userId, slug, { previousNames: [] });
    await service.upsert(userId, { slug, name: "Name B", race: "Protoss" });
    await service.enqueueReclassify(userId, slug, {
      previousNames: ["Name A"],
    });
    await service.upsert(userId, { slug, name: "Name C", race: "Protoss" });
    const finalQueue = await service.enqueueReclassify(userId, slug, {
      previousNames: ["Name B"],
    });

    const build = await db.collection("custom_builds").findOne({ userId, slug });
    const job = await jobs.findOne({ userId });
    expect(build.name).toBe("Name C");
    expect(build.reclassifyJob).toBeUndefined();
    expect(job).toEqual(expect.objectContaining({
      generation: finalQueue.generation,
      status: "queued",
    }));
    expect(new Set(job.previousNamesBySlug[slug]))
      .toEqual(new Set(["Name A", "Name B"]));
  });

  test("PUT saves immediately and reports durable reclassification as queued", async () => {
    const queued = {
      status: "queued",
      generation: "generation-1",
      requestedAt: new Date("2026-08-13T19:00:00.000Z"),
    };
    const customBuilds = {
      get: jest.fn().mockResolvedValue({
        slug: "queued-save",
        name: "Previous build name",
      }),
      upsert: jest.fn().mockResolvedValue(undefined),
      enqueueReclassify: jest.fn().mockResolvedValue(queued),
    };
    const app = express();
    app.use(express.json());
    app.use(
      "/v1",
      buildCustomBuildsRouter({
        customBuilds,
        perGame: {},
        auth: (req_, _res, next) => {
          req_.auth = { userId: "u-queued-save" };
          next();
        },
      }),
    );

    const response = await request(app)
      .put("/v1/custom-builds/queued-save")
      .send({
        name: "Updated build name",
        race: "Protoss",
        vsRace: "Terran",
        rules: [{ type: "before", name: "BuildPylon", time_lt: 60 }],
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      ok: true,
      reclassify: expect.objectContaining({
        status: "queued",
        generation: "generation-1",
      }),
    }));
    expect(customBuilds.upsert).toHaveBeenCalledTimes(1);
    expect(customBuilds.enqueueReclassify).toHaveBeenCalledWith(
      "u-queued-save",
      "queued-save",
      {
        replace: true,
        previousNames: ["Previous build name"],
      },
    );
  });

  test("PUT reclassify=false saves without queueing while legacy omission still queues", async () => {
    const customBuilds = {
      get: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue(undefined),
      enqueueReclassify: jest.fn().mockResolvedValue({ status: "queued" }),
    };
    const app = express();
    app.use(express.json());
    app.use("/v1", buildCustomBuildsRouter({
      customBuilds,
      perGame: {},
      auth: (req_, _res, next) => {
        req_.auth = { userId: "u-save-only" };
        next();
      },
    }));
    const build = {
      name: "Save only",
      race: "Protoss",
      rules: [{ type: "before", name: "BuildPylon", time_lt: 60 }],
    };

    const saveOnly = await request(app)
      .put("/v1/custom-builds/save-only")
      .send({ ...build, reclassify: false });
    expect(saveOnly.status).toBe(200);
    expect(saveOnly.body).toEqual(expect.objectContaining({
      ok: true,
      saved: true,
      reclassifyRequested: false,
      reclassify: null,
    }));
    expect(customBuilds.enqueueReclassify).not.toHaveBeenCalled();

    await request(app).put("/v1/custom-builds/legacy-save").send(build);
    expect(customBuilds.enqueueReclassify).toHaveBeenCalledTimes(1);
  });

  test("explicit Save & Reclassify reports partial success when queueing fails", async () => {
    const customBuilds = {
      get: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue(undefined),
      enqueueReclassify: jest.fn().mockRejectedValue(new Error("mongo down")),
    };
    const app = express();
    app.use(express.json());
    app.use("/v1", buildCustomBuildsRouter({
      customBuilds,
      perGame: {},
      auth: (req_, _res, next) => {
        req_.auth = { userId: "u-save-partial" };
        next();
      },
    }));

    const response = await request(app)
      .put("/v1/custom-builds/save-partial")
      .send({
        name: "Saved despite queue failure",
        race: "Protoss",
        rules: [{ type: "before", name: "BuildPylon", time_lt: 60 }],
        reclassify: true,
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      ok: false,
      saved: true,
      reclassifyRequested: true,
      reclassify: null,
      reclassifyError: "reclassify_queue_failed",
    }));
    expect(customBuilds.upsert).toHaveBeenCalledTimes(1);
  });

  test("status route exposes safe lifecycle fields and live page progress", async () => {
    const jobs = db.collection("custom_build_jobs");
    await jobs.insertOne({
      userId: "u-status-other-user",
      status: "failed",
      generation: "private-other-generation",
      error: "must_not_leak",
      progress: { scanned: 999 },
    });
    const service = new CustomBuildsService({
      games: db.collection("games"),
      customBuilds: db.collection("custom_builds"),
      customBuildJobs: jobs,
    }, { perGame: {} });
    const progressWritten = deferred();
    const releaseScan = deferred();
    service.reclassifyAll = jest.fn(async (_userId, opts) => {
      await opts.onProgress({
        builds: 2,
        scanned: 50,
        tagged: 4,
        cleared: 1,
        deferred: 3,
      });
      progressWritten.resolve();
      await releaseScan.promise;
      return { builds: 2, scanned: 75, tagged: 6, cleared: 1, perBuild: [] };
    });
    await service.enqueueReclassifyAll("u-status-progress");
    await progressWritten.promise;

    const app = express();
    app.use(express.json());
    app.use("/v1", buildCustomBuildsRouter({
      customBuilds: service,
      perGame: {},
      auth: (req_, _res, next) => {
        req_.auth = { userId: "u-status-progress" };
        next();
      },
    }));
    const response = await request(app)
      .get("/v1/custom-builds/reclassify-status");
    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      status: "running",
      progress: {
        builds: 2,
        scanned: 50,
        tagged: 4,
        cleared: 1,
        deferred: 3,
      },
    }));
    expect(response.body.leaseToken).toBeUndefined();
    expect(response.body.previousNamesBySlug).toBeUndefined();

    releaseScan.resolve();
    expect(await waitForCondition(async () =>
      (await service.getReclassifyStatus("u-status-progress")).status === "complete"))
      .toBe(true);
  });

  test("ordinary storage transients enter bounded retry without exhausting immediately", async () => {
    const jobs = db.collection("custom_build_jobs");
    const service = new CustomBuildsService({
      games: db.collection("games"),
      customBuilds: db.collection("custom_builds"),
      customBuildJobs: jobs,
    }, { perGame: {} });
    const transient = new Error("upstream unavailable");
    transient.$metadata = { httpStatusCode: 503 };
    service.reclassifyAll = jest.fn().mockRejectedValue(transient);

    await service.enqueueReclassifyAll("u-storage-retry");
    expect(await waitForCondition(async () =>
      (await service.getReclassifyStatus("u-storage-retry")).status === "retry"))
      .toBe(true);
    const status = await service.getReclassifyStatus("u-storage-retry");
    expect(status.attempts).toBe(1);
    expect(status.retryAt).toBeInstanceOf(Date);
    expect(status.progress).toEqual({
      builds: 0,
      scanned: 0,
      tagged: 0,
      cleared: 0,
      deferred: 0,
    });
    await service.stopReclassifications();
  });

  test("failed status sanitizes its error and never exposes durable job inputs", async () => {
    const jobs = db.collection("custom_build_jobs");
    const service = new CustomBuildsService({
      games: db.collection("games"),
      customBuilds: db.collection("custom_builds"),
      customBuildJobs: jobs,
    }, { perGame: {} });
    await jobs.insertOne({
      userId: "u-status-failed",
      status: "failed",
      generation: "failed-generation",
      attempts: 3,
      failedAt: new Date("2026-08-13T21:00:00.000Z"),
      error: "GET https://private.example/object C:\\secret\\replay.json",
      leaseToken: "private-token",
      previousNamesBySlug: { secret: ["Old"] },
    });

    const status = await service.getReclassifyStatus("u-status-failed");
    expect(status).toEqual(expect.objectContaining({
      status: "failed",
      generation: "failed-generation",
      attempts: 3,
      error: "GET [upstream] [path]",
    }));
    expect(status.leaseToken).toBeUndefined();
    expect(status.previousNamesBySlug).toBeUndefined();
  });

  test("recovery resumes both queued and interrupted running jobs", async () => {
    const jobs = db.collection("custom_build_jobs");
    const service = new CustomBuildsService(
      {
        games: db.collection("games"),
        customBuilds: db.collection("custom_builds"),
        customBuildJobs: jobs,
      },
      { perGame: {} },
    );
    for (const [userId, slug, status] of [
      ["u-recover-queued", "queued-build", "queued"],
      ["u-recover-running", "running-build", "running"],
    ]) {
      await service.upsert(userId, {
        slug,
        name: slug,
        race: "Protoss",
        rules: [{ type: "before", name: "BuildPylon", time_lt: 60 }],
      });
      await jobs.insertOne({
          userId,
          generation: `${slug}-generation`,
          status,
          requestedAt: new Date("2026-08-13T20:00:00.000Z"),
          clearUnmatched: true,
          previousNamesBySlug: {},
        });
    }
    service.reclassifyAll = jest.fn(async () => ({
      scanned: 1,
      tagged: 1,
      cleared: 0,
      perBuild: [],
    }));

    await service.recoverQueuedReclassifications();
    const completed = await waitForCondition(async () =>
      (await jobs.countDocuments({ status: "complete" })) === 2);

    expect(completed).toBe(true);
    expect(service.reclassifyAll).toHaveBeenCalledTimes(2);
    expect(new Set(service.reclassifyAll.mock.calls.map((call) => call[0])))
      .toEqual(new Set(["u-recover-queued", "u-recover-running"]));
  });

  test("background reclassification admits only one full scan globally", async () => {
    const jobs = db.collection("custom_build_jobs");
    const service = new CustomBuildsService(
      {
        games: db.collection("games"),
        customBuilds: db.collection("custom_builds"),
        customBuildJobs: jobs,
      },
      { perGame: {} },
    );
    await service.upsert("u-global-a", {
      slug: "build-a",
      name: "Build A",
      race: "Protoss",
    });
    await service.upsert("u-global-b", {
      slug: "build-b",
      name: "Build B",
      race: "Protoss",
    });
    const firstStarted = deferred();
    const releaseFirst = deferred();
    let active = 0;
    let maxActive = 0;
    service.reclassifyAll = jest.fn(async (userId) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (userId === "u-global-a") {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      active -= 1;
      return { scanned: 1, tagged: 1, cleared: 0, perBuild: [] };
    });

    await service.enqueueReclassify("u-global-a", "build-a");
    await firstStarted.promise;
    await service.enqueueReclassify("u-global-b", "build-b");
    await new Promise((resolve) => setTimeout(resolve, 40));
    const observedBeforeRelease = maxActive;
    releaseFirst.resolve();

    const completed = await waitForCondition(async () =>
      (await jobs.countDocuments({ status: "complete" })) === 2);
    expect(completed).toBe(true);
    expect(observedBeforeRelease).toBe(1);
    expect(maxActive).toBe(1);
  });

  test("an enqueue arriving as the worker exits is not stranded", async () => {
    const collection = db.collection("custom_builds");
    const jobs = db.collection("custom_build_jobs");
    const service = new CustomBuildsService(
      {
        games: db.collection("games"),
        customBuilds: collection,
        customBuildJobs: jobs,
      },
      { perGame: {} },
    );
    await service.upsert("u-exit-race", {
      slug: "exit-race",
      name: "Exit race",
      race: "Protoss",
    });
    service.reclassifyAll = jest.fn(async () => ({
      scanned: 1,
      tagged: 1,
      cleared: 0,
      perBuild: [],
    }));

    const emptyProbeReached = deferred();
    const releaseEmptyProbe = deferred();
    const originalFindOne = jobs.findOne.bind(jobs);
    let heldEmptyProbe = false;
    jobs.findOne = jest.fn(async (...args) => {
      const result = await originalFindOne(...args);
      const filter = args[0] || {};
      if (
        !heldEmptyProbe &&
        result === null &&
        filter.userId === "u-exit-race" &&
        Array.isArray(filter.$or)
      ) {
        heldEmptyProbe = true;
        emptyProbeReached.resolve();
        await releaseEmptyProbe.promise;
      }
      return result;
    });

    try {
      await service.enqueueReclassify("u-exit-race", "exit-race");
      expect(await waitForCondition(() => heldEmptyProbe, 5_000)).toBe(true);
      await service.enqueueReclassify("u-exit-race", "exit-race");
      releaseEmptyProbe.resolve();

      const ranAgain = await waitForCondition(() =>
        service.reclassifyAll.mock.calls.length === 2);
      const latest = await jobs.findOne({ userId: "u-exit-race" });
      expect(ranAgain).toBe(true);
      expect(latest.status).toBe("complete");
    } finally {
      releaseEmptyProbe.resolve();
      jobs.findOne = originalFindOne;
    }
  });

  test("stopReclassifications aborts the active scan and durably leaves it queued", async () => {
    const userId = "u-stop-active";
    const slug = "stop-active";
    const scanStarted = deferred();
    const jobs = db.collection("custom_build_jobs");
    const service = new CustomBuildsService(
      {
        games: db.collection("games"),
        customBuilds: db.collection("custom_builds"),
        customBuildJobs: jobs,
      },
      { perGame: {} },
    );
    await service.upsert(userId, {
      slug,
      name: "Stop active",
      race: "Protoss",
    });
    service.reclassifyAll = jest.fn(async (_uid, opts) => {
      scanStarted.resolve(opts.signal);
      await new Promise((resolve, reject) => {
        const abort = () => {
          const error = new Error("stopped");
          error.name = "AbortError";
          reject(error);
        };
        if (opts.signal.aborted) abort();
        else opts.signal.addEventListener("abort", abort, { once: true });
      });
    });

    const queued = await service.enqueueReclassify(userId, slug);
    const signal = await scanStarted.promise;

    await expect(service.stopReclassifications()).resolves.toBeUndefined();

    const job = await jobs.findOne({ userId });
    expect(signal.aborted).toBe(true);
    expect(job).toEqual(expect.objectContaining({
      generation: queued.generation,
      status: "queued",
      interruptedAt: expect.any(Date),
    }));
    expect(service._activeReclassify).toBeNull();
    expect(service._reclassifyWorker).toBeNull();
  });

  test("a newer same-slug enqueue aborts the active generation and alone completes", async () => {
    const userId = "u-superseded-generation";
    const slug = "superseded-generation";
    const firstStarted = deferred();
    const notified = jest.fn();
    const observed = [];
    const jobs = db.collection("custom_build_jobs");
    const service = new CustomBuildsService(
      {
        games: db.collection("games"),
        customBuilds: db.collection("custom_builds"),
        customBuildJobs: jobs,
      },
      { perGame: {}, onReclassified: notified },
    );
    await service.upsert(userId, {
      slug,
      name: "Superseded generation",
      race: "Protoss",
    });
    service.reclassifyAll = jest.fn(async (_uid, opts) => {
      const generation = service._activeReclassify.generation;
      observed.push({ generation, signal: opts.signal });
      if (observed.length === 1) {
        firstStarted.resolve();
        await new Promise((resolve, reject) => {
          const abort = () => {
            const error = new Error("superseded");
            error.name = "AbortError";
            reject(error);
          };
          if (opts.signal.aborted) abort();
          else opts.signal.addEventListener("abort", abort, { once: true });
        });
      }
      return {
        generation,
        scanned: 1,
        tagged: 1,
        cleared: 0,
        perBuild: [],
      };
    });

    const first = await service.enqueueReclassify(userId, slug);
    await firstStarted.promise;
    const latest = await service.enqueueReclassify(userId, slug);
    const completed = await waitForCondition(async () => {
      const job = await jobs.findOne({ userId });
      return job?.generation === latest.generation
        && job.status === "complete";
    });

    expect(completed).toBe(true);
    expect(observed.map((entry) => entry.generation))
      .toEqual([first.generation, latest.generation]);
    expect(observed[0].signal.aborted).toBe(true);
    expect(notified).toHaveBeenCalledTimes(1);
    expect(notified).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({ generation: latest.generation }),
    );
  });

  test.each([
    { first: "newer", second: "older" },
    { first: "older", second: "newer" },
  ])(
    "overlapping run markers survive $first cleanup and $second commit",
    async ({ first, second }) => {
      const userId = `u-overlap-${first}`;
      const gameId = `overlap-${first}`;
      const games = db.collection("games");
      const olderPageReady = deferred();
      const releaseOlder = deferred();
      const newerPageReady = deferred();
      const releaseNewer = deferred();
      await games.insertOne({
        userId,
        gameId,
        date: new Date("2026-08-13T20:30:00.000Z"),
        myRace: "Protoss",
        opponent: { race: "Terran" },
        myBuild: "Original classifier label",
        _customBuildRevision: "overlap-revision",
        _schemaVersion: 6,
      });

      function makeService(name, pageReady, releaseCommit) {
        const perGame = {
          iterateRulePreviewPages: async function* () {
            yield {
              games: [{
                gameId,
                myBuild: "Original classifier label",
                myRace: "Protoss",
                oppRace: "Terran",
                events: [{ name: "BuildPylon", time: 17 }],
                detailAvailableYou: true,
                customBuildRevision: "overlap-revision",
              }],
              candidates: 1,
              hasMore: false,
            };
          },
        };
        const service = new CustomBuildsService(
          { games, customBuilds: db.collection("custom_builds") },
          { perGame },
        );
        service.get = jest.fn(async () => ({
          slug: name.toLowerCase(),
          name,
          race: "Protoss",
          vsRace: "Terran",
          rules: [{ type: "before", name: "BuildPylon", time_lt: 60 }],
        }));
        const originalBulkWrite = games.bulkWrite.bind(games);
        service._gamesCollection = () => ({
          bulkWrite: async (...args) => {
            const result = await originalBulkWrite(...args);
            pageReady.resolve();
            return result;
          },
          updateMany: async (...args) => {
            if (args[0] && args[0]["_customBuildReclassify.runId"]) {
              await releaseCommit.promise;
            }
            return games.updateMany(...args);
          },
          findOne: (...args) => games.findOne(...args),
        });
        return service;
      }

      const older = makeService("Older build", olderPageReady, releaseOlder);
      const newer = makeService("Newer build", newerPageReady, releaseNewer);
      const olderRun = older.reclassify(userId, "older", { jobSequence: 10 });
      const newerRun = newer.reclassify(userId, "newer", { jobSequence: 20 });
      await Promise.all([olderPageReady.promise, newerPageReady.promise]);

      let staged = await games.findOne({ userId, gameId });
      expect(staged._customBuildReclassify).toHaveLength(2);
      expect(new Set(staged._customBuildReclassify.map((marker) => marker.sequence)))
        .toEqual(new Set([10, 20]));

      if (first === "newer") releaseNewer.resolve();
      else releaseOlder.resolve();
      await (first === "newer" ? newerRun : olderRun);
      staged = await games.findOne({ userId, gameId });
      expect(staged.myBuild).toBe(first === "newer" ? "Newer build" : "Older build");
      if (first === "newer") {
        expect(staged._customBuildReclassify).toBeUndefined();
      } else {
        expect(staged._customBuildReclassify).toHaveLength(1);
        expect(staged._customBuildReclassify[0].sequence).toBe(20);
      }

      if (second === "newer") releaseNewer.resolve();
      else releaseOlder.resolve();
      await (second === "newer" ? newerRun : olderRun);
      const committed = await games.findOne({ userId, gameId });
      expect(committed.myBuild).toBe("Newer build");
      expect(committed._customBuildClassificationSequence).toBe(20);
      expect(committed._customBuildReclassify).toBeUndefined();
      expect(committed._schemaVersion).toBe(6);
    },
  );

  test("an aborting run removes only its marker while another run can commit", async () => {
    const userId = "u-overlap-cleanup";
    const gameId = "overlap-cleanup";
    const games = db.collection("games");
    const releaseAbort = deferred();
    const stagedAbort = deferred();
    const stagedWinner = deferred();
    const releaseWinner = deferred();
    await games.insertOne({
      userId,
      gameId,
      date: new Date("2026-08-13T20:40:00.000Z"),
      myRace: "Protoss",
      opponent: { race: "Terran" },
      myBuild: "Original classifier label",
      _customBuildRevision: "cleanup-revision",
      _schemaVersion: 6,
    });

    function makeService(name, stagedSignal, commitGate, shouldAbort) {
      const service = new CustomBuildsService(
        { games, customBuilds: db.collection("custom_builds") },
        { perGame: {
          iterateRulePreviewPages: async function* () {
            yield {
              games: [{
                gameId,
                myBuild: "Original classifier label",
                myRace: "Protoss",
                oppRace: "Terran",
                events: [{ name: "BuildPylon", time: 17 }],
                detailAvailableYou: true,
                customBuildRevision: "cleanup-revision",
              }],
              candidates: 1,
              hasMore: false,
            };
          },
        } },
      );
      service.get = jest.fn(async () => ({
        slug: name.toLowerCase(),
        name,
        race: "Protoss",
        vsRace: "Terran",
        rules: [{ type: "before", name: "BuildPylon", time_lt: 60 }],
      }));
      const originalBulkWrite = games.bulkWrite.bind(games);
      let updateCalls = 0;
      service._gamesCollection = () => ({
        bulkWrite: async (...args) => {
          const result = await originalBulkWrite(...args);
          stagedSignal.resolve();
          return result;
        },
        updateMany: async (...args) => {
          if (!args[0] || !args[0]["_customBuildReclassify.runId"]) {
            return games.updateMany(...args);
          }
          updateCalls += 1;
          if (updateCalls === 1 && commitGate) await commitGate.promise;
          if (shouldAbort && updateCalls === 1) throw abortError("superseded");
          return games.updateMany(...args);
        },
        findOne: (...args) => games.findOne(...args),
      });
      return service;
    }

    const aborting = makeService("Aborting build", stagedAbort, releaseAbort, true);
    const winner = makeService("Winner build", stagedWinner, releaseWinner, false);
    const abortingRun = aborting.reclassify(userId, "aborting", { jobSequence: 10 });
    const winnerRun = winner.reclassify(userId, "winner", { jobSequence: 20 });
    await Promise.all([stagedAbort.promise, stagedWinner.promise]);
    expect((await games.findOne({ userId, gameId }))._customBuildReclassify)
      .toHaveLength(2);

    releaseAbort.resolve();
    await expect(abortingRun).rejects.toThrow("superseded");
    let row = await games.findOne({ userId, gameId });
    expect(row.myBuild).toBe("Original classifier label");
    expect(row._customBuildReclassify).toHaveLength(1);
    expect(row._customBuildReclassify[0].sequence).toBe(20);

    releaseWinner.resolve();
    await winnerRun;
    row = await games.findOne({ userId, gameId });
    expect(row.myBuild).toBe("Winner build");
    expect(row._customBuildClassificationSequence).toBe(20);
    expect(row._customBuildReclassify).toBeUndefined();
  });

  test("a fresh replay upsert fences out a verdict staged from the old revision", async () => {
    const userId = "u-revision-replay-upsert";
    const gameId = "revision-replay-upsert";
    const games = db.collection("games");
    const stageStarted = deferred();
    const releaseStage = deferred();
    const originalRevision = "revision-before-fresh-upload";
    const date = new Date("2026-08-13T20:45:00.000Z");
    await games.insertOne({
      userId,
      gameId,
      date,
      myRace: "Protoss",
      opponent: { race: "Terran" },
      myBuild: "Old replay label",
      _customBuildRevision: originalRevision,
      _customBuildSlug: "old-custom-build",
      _schemaVersion: 6,
    });

    const service = new CustomBuildsService(
      { games, customBuilds: db.collection("custom_builds") },
      { perGame: {
        iterateRulePreviewPages: async function* () {
          yield {
            games: [{
              gameId,
              myBuild: "Old replay label",
              myRace: "Protoss",
              oppRace: "Terran",
              events: [{ name: "BuildPylon", time: 17 }],
              detailAvailableYou: true,
              customBuildRevision: originalRevision,
              customBuildSlug: "old-custom-build",
            }],
            candidates: 1,
            hasMore: false,
          };
        },
      } },
    );
    service.get = jest.fn(async () => ({
      slug: "fresh-target",
      name: "Stale classifier verdict",
      race: "Protoss",
      vsRace: "Terran",
      rules: [{ type: "before", name: "BuildPylon", time_lt: 60 }],
    }));
    const originalBulkWrite = games.bulkWrite.bind(games);
    service._gamesCollection = () => ({
      bulkWrite: async (...args) => {
        stageStarted.resolve();
        await releaseStage.promise;
        return originalBulkWrite(...args);
      },
      updateMany: (...args) => games.updateMany(...args),
      findOne: (...args) => games.findOne(...args),
    });

    const classification = service.reclassify(userId, "fresh-target", {
      jobSequence: 31,
    });
    await stageStarted.promise;
    const replayWriter = new GamesService({ games });
    await replayWriter.upsert(userId, {
      gameId,
      date,
      myRace: "Protoss",
      opponent: { race: "Terran" },
      myBuild: "Fresh replay label",
      // Agent input must never be able to retain or forge custom ownership.
      _customBuildSlug: "forged-by-agent",
    });
    releaseStage.resolve();

    const result = await classification;
    const row = await games.findOne({ userId, gameId });
    expect(result).toEqual(expect.objectContaining({ matched: 1, tagged: 0 }));
    expect(row.myBuild).toBe("Fresh replay label");
    expect(row._customBuildRevision).not.toBe(originalRevision);
    expect(row._customBuildSlug).toBeUndefined();
    expect(row._customBuildReclassify).toBeUndefined();
    expect(row._schemaVersion).toBe(6);
  });

  test("an opponent-log recompute fences out a verdict from the old detail", async () => {
    const userId = "u-revision-opponent-recompute";
    const gameId = "revision-opponent-recompute";
    const games = db.collection("games");
    const stageStarted = deferred();
    const releaseStage = deferred();
    const detailsStarted = deferred();
    const releaseDetails = deferred();
    const detailsUpsert = jest.fn(async () => {
      detailsStarted.resolve();
      await releaseDetails.promise;
    });
    const originalRevision = "revision-before-opponent-recompute";
    const date = new Date("2026-08-13T20:50:00.000Z");
    await games.insertOne({
      userId,
      gameId,
      date,
      myRace: "Protoss",
      opponent: { race: "Terran" },
      myBuild: "Original opponent label",
      _customBuildRevision: originalRevision,
      _customBuildSlug: "old-opponent-build",
      _schemaVersion: 6,
    });

    const service = new CustomBuildsService(
      { games, customBuilds: db.collection("custom_builds") },
      { perGame: {
        iterateRulePreviewPages: async function* () {
          yield {
            games: [{
              gameId,
              myBuild: "Original opponent label",
              myRace: "Protoss",
              oppRace: "Terran",
              oppEvents: [{ name: "BuildSupplyDepot", time: 17 }],
              detailAvailableOpponent: true,
              customBuildRevision: originalRevision,
              customBuildSlug: "old-opponent-build",
            }],
            candidates: 1,
            hasMore: false,
          };
        },
      } },
    );
    service.get = jest.fn(async () => ({
      slug: "opponent-target",
      name: "Stale opponent verdict",
      race: "Terran",
      vsRace: "Protoss",
      perspective: "opponent",
      rules: [{
        type: "before",
        name: "BuildSupplyDepot",
        time_lt: 60,
      }],
    }));
    const originalBulkWrite = games.bulkWrite.bind(games);
    service._gamesCollection = () => ({
      bulkWrite: async (...args) => {
        stageStarted.resolve();
        await releaseStage.promise;
        return originalBulkWrite(...args);
      },
      updateMany: (...args) => games.updateMany(...args),
      findOne: (...args) => games.findOne(...args),
    });

    const classification = service.reclassify(userId, "opponent-target", {
      jobSequence: 32,
    });
    await stageStarted.promise;
    const replayCompute = new PerGameComputeService(
      { games },
      { gameDetails: { upsert: detailsUpsert } },
    );
    const detailWrite = replayCompute.writeOpponentBuildOrder(userId, gameId, {
      oppBuildLog: ["[0:18] SupplyDepot"],
    });
    await detailsStarted.promise;
    const whileDetailWriteIsPending = await games.findOne({ userId, gameId });
    expect(whileDetailWriteIsPending._customBuildRevision)
      .not.toBe(originalRevision);
    expect(whileDetailWriteIsPending._customBuildSlug)
      .toBe("old-opponent-build");

    // Let the old classifier try to stage while R2/detail I/O is still in
    // flight. The pre-I/O revision rotation must already fence it out.
    releaseStage.resolve();
    const result = await classification;
    const revisionDuringWrite = (await games.findOne({ userId, gameId }))
      ._customBuildRevision;
    releaseDetails.resolve();
    await detailWrite;
    const row = await games.findOne({ userId, gameId });
    expect(result).toEqual(expect.objectContaining({ matched: 1, tagged: 0 }));
    expect(detailsUpsert).toHaveBeenCalledWith(
      userId,
      gameId,
      date,
      { oppBuildLog: ["[0:18] SupplyDepot"] },
      expect.objectContaining({ signal: expect.any(Object) }),
    );
    expect(row.myBuild).toBe("Original opponent label");
    expect(row._customBuildRevision).not.toBe(originalRevision);
    expect(row._customBuildRevision).not.toBe(revisionDuringWrite);
    expect(row._customBuildSlug).toBe("old-opponent-build");
    expect(row._customBuildReclassify).toBeUndefined();
    expect(row._schemaVersion).toBe(6);
  });

  test("an opponent-log recompute blocks a classifier started during detail I/O", async () => {
    const userId = "u-recompute-in-progress-sentinel";
    const gameId = "recompute-in-progress-sentinel";
    const games = db.collection("games");
    const detailsStarted = deferred();
    const releaseDetails = deferred();
    const date = new Date("2026-08-13T20:52:00.000Z");
    const originalRevision = "revision-before-in-progress-recompute";
    await games.insertOne({
      userId,
      gameId,
      date,
      myRace: "Protoss",
      opponent: { race: "Terran" },
      myBuild: "Trusted custom label",
      _customBuildSlug: "trusted-custom-build",
      _customBuildRevision: originalRevision,
      _schemaVersion: 6,
    });

    let storedOpponentLog = ["[0:17] SupplyDepot"];
    const queued = jest.fn(async () => {});
    const gameDetails = {
      upsert: jest.fn(async (_userId, _gameId, _date, fields) => {
        detailsStarted.resolve();
        await releaseDetails.promise;
        storedOpponentLog = fields.oppBuildLog;
      }),
      // Until the held upsert completes, a classifier still sees the old R2
      // object and would match this now-obsolete opponent opener.
      findMany: jest.fn(async () => new Map([[
        gameId,
        { oppBuildLog: storedOpponentLog },
      ]])),
    };
    const perGame = new PerGameComputeService({ games }, {
      gameDetails,
      onOpponentBuildOrderWritten: queued,
    });
    const replayWrite = perGame.writeOpponentBuildOrder(userId, gameId, {
      oppBuildLog: ["[0:18] Barracks"],
    });
    await detailsStarted.promise;

    const preFence = await games.findOne({ userId, gameId });
    expect(preFence._customBuildRevision).not.toBe(originalRevision);
    expect(preFence._customBuildClassificationSequence)
      .toBe(Number.MAX_SAFE_INTEGER);

    const classifier = new CustomBuildsService(
      { games, customBuilds: db.collection("custom_builds") },
      { perGame },
    );
    classifier.get = jest.fn(async () => ({
      slug: "updated-after-write",
      name: "Updated opponent verdict",
      race: "Terran",
      vsRace: "Protoss",
      perspective: "opponent",
      rules: [{
        type: "before",
        name: "BuildBarracks",
        time_lt: 60,
      }],
    }));

    await expect(classifier.reclassify(userId, "updated-after-write", {
      jobSequence: 77,
    })).rejects.toMatchObject({
      code: "opponent_build_order_write_in_progress",
      retryable: true,
    });
    const duringWrite = await games.findOne({ userId, gameId });
    expect(duringWrite.myBuild).toBe("Trusted custom label");
    expect(duringWrite._customBuildSlug).toBe("trusted-custom-build");
    expect(duringWrite._customBuildClassificationSequence)
      .toBe(Number.MAX_SAFE_INTEGER);
    expect(duringWrite._customBuildReclassify).toBeUndefined();

    releaseDetails.resolve();
    await replayWrite;
    expect(queued).toHaveBeenCalledWith(userId, gameId);
    await classifier.reclassify(userId, "updated-after-write", {
      jobSequence: 78,
    });
    const completed = await games.findOne({ userId, gameId });
    expect(completed.myBuild).toBe("Updated opponent verdict");
    expect(completed._customBuildSlug).toBe("updated-after-write");
    expect(completed._customBuildRevision).not.toBe(preFence._customBuildRevision);
    expect(completed._customBuildClassificationSequence).toBe(78);
    expect(completed._customBuildReclassify).toBeUndefined();
    expect(completed._schemaVersion).toBe(6);
  });

  test("unproven equal-name and prior-name tags survive nonmatch and rename scans", async () => {
    const userId = "u-unproven-name-collision";
    const games = db.collection("games");
    await games.insertMany([
      {
        userId,
        gameId: "unproven-current-name",
        date: new Date("2026-08-13T20:55:00.000Z"),
        myRace: "Protoss",
        opponent: { race: "Terran" },
        buildLog: ["[0:49] Gateway"],
        myBuild: "Shared display name",
      },
      {
        userId,
        gameId: "unproven-prior-name",
        date: new Date("2026-08-13T20:54:00.000Z"),
        myRace: "Protoss",
        opponent: { race: "Terran" },
        buildLog: ["[0:49] Gateway"],
        myBuild: "Prior shared name",
      },
    ]);
    const service = new CustomBuildsService(
      { games, customBuilds: db.collection("custom_builds") },
      { perGame: new PerGameComputeService({ games }) },
    );
    await service.upsert(userId, {
      slug: "name-collision",
      name: "Shared display name",
      race: "Protoss",
      vsRace: "Terran",
      rules: [{ type: "before", name: "BuildPylon", time_lt: 60 }],
    });

    const result = await service.reclassify(userId, "name-collision", {
      replace: true,
      previousName: "Prior shared name",
      jobSequence: 40,
    });

    expect(result).toEqual(expect.objectContaining({ cleared: 0, tagged: 0 }));
    const rows = await games.find({ userId }).sort({ gameId: 1 }).toArray();
    expect(rows.map((row) => [row.gameId, row.myBuild])).toEqual([
      ["unproven-current-name", "Shared display name"],
      ["unproven-prior-name", "Prior shared name"],
    ]);
    expect(rows.every((row) => row._customBuildSlug === undefined)).toBe(true);
  });

  test("a matching equal-name row is claimed with private slug provenance", async () => {
    const userId = "u-claim-name-collision";
    const games = db.collection("games");
    await games.insertOne({
      userId,
      gameId: "claim-name-collision",
      date: new Date("2026-08-13T21:00:00.000Z"),
      myRace: "Protoss",
      opponent: { race: "Terran" },
      buildLog: ["[0:17] Pylon"],
      myBuild: "Shared display name",
    });
    const service = new CustomBuildsService(
      { games, customBuilds: db.collection("custom_builds") },
      { perGame: new PerGameComputeService({ games }) },
    );
    await service.upsert(userId, {
      slug: "claim-collision",
      name: "Shared display name",
      race: "Protoss",
      vsRace: "Terran",
      rules: [{ type: "before", name: "BuildPylon", time_lt: 60 }],
    });

    const result = await service.reclassify(userId, "claim-collision", {
      jobSequence: 41,
    });
    const stored = await games.findOne({ userId, gameId: "claim-name-collision" });
    expect(result).toEqual(expect.objectContaining({ matched: 1, tagged: 1 }));
    expect(stored.myBuild).toBe("Shared display name");
    expect(stored._customBuildSlug).toBe("claim-collision");
    expect(stored._schemaVersion).toBe(6);

    const publicGames = new GamesService({ games });
    const [listed, fetched, many] = await Promise.all([
      publicGames.list(userId),
      publicGames.get(userId, "claim-name-collision"),
      publicGames.findMany(userId, ["claim-name-collision"]),
    ]);
    expect(listed.items[0]._customBuildSlug).toBeUndefined();
    expect(fetched._customBuildSlug).toBeUndefined();
    expect(many[0]._customBuildSlug).toBeUndefined();
  });

  test("a definite nonmatch clears only a row proven owned by that slug", async () => {
    const userId = "u-clear-owned-slug";
    const games = db.collection("games");
    await games.insertOne({
      userId,
      gameId: "clear-owned-slug",
      date: new Date("2026-08-13T21:05:00.000Z"),
      myRace: "Protoss",
      opponent: { race: "Terran" },
      buildLog: ["[0:49] Gateway"],
      myBuild: "Collision-prone label",
      _customBuildSlug: "owned-slug",
    });
    const service = new CustomBuildsService(
      { games, customBuilds: db.collection("custom_builds") },
      { perGame: new PerGameComputeService({ games }) },
    );
    await service.upsert(userId, {
      slug: "owned-slug",
      name: "Collision-prone label",
      race: "Protoss",
      vsRace: "Terran",
      rules: [{ type: "before", name: "BuildPylon", time_lt: 60 }],
    });

    const result = await service.reclassify(userId, "owned-slug", {
      replace: true,
      jobSequence: 42,
    });
    const stored = await games.findOne({ userId, gameId: "clear-owned-slug" });
    expect(result).toEqual(expect.objectContaining({ cleared: 1 }));
    expect(stored.myBuild).toBeUndefined();
    expect(stored._customBuildSlug).toBeUndefined();
    expect(stored._schemaVersion).toBe(6);
  });

  test("deleting a build never clears an unproven legacy name collision", async () => {
    const userId = "u-delete-name-collision";
    const games = db.collection("games");
    const jobs = db.collection("custom_build_jobs");
    await games.insertOne({
      userId,
      gameId: "delete-name-collision",
      date: new Date("2026-08-13T21:10:00.000Z"),
      myRace: "Protoss",
      opponent: { race: "Terran" },
      buildLog: ["[0:49] Gateway"],
      myBuild: "Legacy shared deletion name",
    });
    const service = new CustomBuildsService(
      {
        games,
        customBuilds: db.collection("custom_builds"),
        customBuildJobs: jobs,
      },
      { perGame: new PerGameComputeService({ games }) },
    );
    await service.upsert(userId, {
      slug: "delete-collision",
      name: "Legacy shared deletion name",
      race: "Protoss",
      vsRace: "Terran",
      rules: [{ type: "before", name: "BuildPylon", time_lt: 60 }],
    });

    try {
      await service.softDelete(userId, "delete-collision");
      expect(await waitForCondition(async () => (
        await jobs.findOne({ userId })
      )?.status === "complete")).toBe(true);
      const stored = await games.findOne({
        userId,
        gameId: "delete-name-collision",
      });
      expect(stored.myBuild).toBe("Legacy shared deletion name");
      expect(stored._customBuildSlug).toBeUndefined();
    } finally {
      await service.stopReclassifications();
    }
  });

  test("all-build scan keeps a valid user-side winner when opponent detail is missing", async () => {
    const userId = "u-one-sided-detail";
    const userBuildName = "User-side Pylon";
    await db.collection("games").insertOne({
      userId,
      gameId: "one-sided-detail",
      date: new Date("2026-08-13T21:00:00.000Z"),
      myRace: "Protoss",
      opponent: { race: "Terran" },
      buildLog: ["[0:17] Pylon", "[0:49] Gateway"],
      // No oppBuildLog/detail blob: the opponent-side rule is unknown.
      myBuild: "Old classifier label",
    });
    const perGame = new PerGameComputeService({ games: db.collection("games") });
    const service = new CustomBuildsService(
      {
        games: db.collection("games"),
        customBuilds: db.collection("custom_builds"),
      },
      { perGame },
    );
    await service.upsert(userId, {
      slug: "user-side-pylon",
      name: userBuildName,
      race: "Protoss",
      vsRace: "Terran",
      perspective: "you",
      rules: [
        { type: "before", name: "BuildPylon", time_lt: 60 },
        { type: "before", name: "BuildGateway", time_lt: 90 },
      ],
    });
    await service.upsert(userId, {
      slug: "unknown-opponent-depot",
      name: "Unknown opponent depot",
      race: "Terran",
      vsRace: "Protoss",
      perspective: "opponent",
      rules: [{ type: "before", name: "BuildSupplyDepot", time_lt: 60 }],
    });

    const result = await service.reclassifyAll(userId);

    const game = await db.collection("games").findOne({
      userId,
      gameId: "one-sided-detail",
    });
    expect(game.myBuild).toBe(userBuildName);
    expect(result.perBuild.find((row) => row.name === userBuildName))
      .toEqual(expect.objectContaining({ matched: 1, tagged: 1 }));
    expect(result.perBuild.find((row) => row.name === "Unknown opponent depot"))
      .toEqual(expect.objectContaining({ matched: 0, tagged: 0 }));
  });

  test("an equal-priority unknown contender preserves the existing game tag", async () => {
    const userId = "u-equal-unknown-detail";
    await db.collection("games").insertOne({
      userId,
      gameId: "equal-unknown-detail",
      date: new Date("2026-08-13T21:30:00.000Z"),
      myRace: "Protoss",
      opponent: { race: "Terran" },
      buildLog: ["[0:17] Pylon"],
      // The opponent log is unavailable, so its equally specific build could
      // outrank the known user-side match once that detail becomes available.
      myBuild: "Existing classifier label",
    });
    const perGame = new PerGameComputeService({ games: db.collection("games") });
    const service = new CustomBuildsService(
      {
        games: db.collection("games"),
        customBuilds: db.collection("custom_builds"),
      },
      { perGame },
    );
    await service.upsert(userId, {
      slug: "known-user-pylon",
      name: "Known user pylon",
      race: "Protoss",
      vsRace: "Terran",
      perspective: "you",
      rules: [{ type: "before", name: "BuildPylon", time_lt: 60 }],
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await service.upsert(userId, {
      slug: "unknown-opponent-depot-equal",
      name: "Unknown opponent depot equal",
      race: "Terran",
      vsRace: "Protoss",
      perspective: "opponent",
      rules: [{ type: "before", name: "BuildSupplyDepot", time_lt: 60 }],
    });

    const result = await service.reclassifyAll(userId, {
      clearUnmatched: true,
    });

    const game = await db.collection("games").findOne({
      userId,
      gameId: "equal-unknown-detail",
    });
    expect(game.myBuild).toBe("Existing classifier label");
    expect(result.perBuild.find((row) => row.name === "Known user pylon"))
      .toEqual(expect.objectContaining({ matched: 1, tagged: 0 }));
    expect(result.perBuild.find(
      (row) => row.name === "Unknown opponent depot equal",
    )).toEqual(expect.objectContaining({ matched: 0, tagged: 0 }));
  });

  test("a corrupt detail is deferred while valid siblings commit and the job completes", async () => {
    const userId = "u-deferred-missing-detail";
    const games = db.collection("games");
    const jobs = db.collection("custom_build_jobs");
    await games.insertMany([
      {
        userId,
        gameId: "deferred-valid",
        date: new Date("2026-08-13T21:42:00.000Z"),
        myRace: "Protoss",
        opponent: { race: "Terran" },
        myBuild: "Old valid label",
      },
      {
        userId,
        gameId: "deferred-missing",
        date: new Date("2026-08-13T21:41:00.000Z"),
        myRace: "Protoss",
        opponent: { race: "Terran" },
        // Its external object is corrupt and omitted by the opted-in bulk
        // reader. That is unavailable, not a nonmatch, so its tag survives.
        myBuild: "Preserved missing label",
        _customBuildSlug: "deferred-pylon",
      },
    ]);
    const findMany = jest.fn(async (_uid, ids, opts) => {
      expect(ids).toEqual(expect.arrayContaining([
        "deferred-valid",
        "deferred-missing",
      ]));
      expect(opts).toEqual(expect.objectContaining({
        strict: true,
        tolerateCorruptObjects: true,
      }));
      return new Map([["deferred-valid", {
        buildLog: ["[0:17] Pylon"],
      }]]);
    });
    const perGame = new PerGameComputeService(
      { games },
      { gameDetails: { findMany } },
    );
    const service = new CustomBuildsService({
      games,
      customBuilds: db.collection("custom_builds"),
      customBuildJobs: jobs,
    }, { perGame });
    await service.upsert(userId, {
      slug: "deferred-pylon",
      name: "Deferred Pylon",
      race: "Protoss",
      vsRace: "Terran",
      perspective: "you",
      rules: [{ type: "before", name: "BuildPylon", time_lt: 60 }],
    });

    await service.enqueueReclassifyAll(userId, { clearUnmatched: true });
    expect(await waitForCondition(async () =>
      (await service.getReclassifyStatus(userId)).status === "complete"))
      .toBe(true);
    const [valid, missing, status] = await Promise.all([
      games.findOne({ userId, gameId: "deferred-valid" }),
      games.findOne({ userId, gameId: "deferred-missing" }),
      service.getReclassifyStatus(userId),
    ]);
    expect(valid.myBuild).toBe("Deferred Pylon");
    expect(valid._customBuildSlug).toBe("deferred-pylon");
    expect(missing.myBuild).toBe("Preserved missing label");
    expect(missing._customBuildSlug).toBe("deferred-pylon");
    expect(status).toEqual(expect.objectContaining({
      status: "complete",
      progress: expect.objectContaining({
        scanned: 2,
        tagged: 1,
        cleared: 0,
        deferred: 1,
      }),
    }));
  });

  test("cancelUserReclassifications clears queued work and awaits the active page", async () => {
    const userId = "u-cancel-active";
    const activeSlug = "cancel-active";
    const queuedSlug = "cancel-queued";
    const scanStarted = deferred();
    const abortObserved = deferred();
    const releasePage = deferred();
    const jobs = db.collection("custom_build_jobs");
    const service = new CustomBuildsService(
      {
        games: db.collection("games"),
        customBuilds: db.collection("custom_builds"),
        customBuildJobs: jobs,
      },
      { perGame: {} },
    );
    await service.upsert(userId, {
      slug: activeSlug,
      name: "Cancel active",
      race: "Protoss",
    });
    await service.upsert(userId, {
      slug: queuedSlug,
      name: "Cancel queued",
      race: "Protoss",
    });
    await db.collection("games").insertOne({
      userId,
      gameId: "no-late-tag",
      date: new Date("2026-08-13T22:00:00.000Z"),
      myBuild: "Original tag",
    });
    service.reclassifyAll = jest.fn(async (_uid, opts) => {
      scanStarted.resolve();
      await new Promise((resolve) => {
        const abort = () => {
          abortObserved.resolve();
          resolve();
        };
        if (opts.signal.aborted) abort();
        else opts.signal.addEventListener("abort", abort, { once: true });
      });
      await releasePage.promise;
      if (!opts.signal.aborted) {
        await db.collection("games").updateOne(
          { userId, gameId: "no-late-tag" },
          { $set: { myBuild: "Late tag" } },
        );
        return { tagged: 1, perBuild: [] };
      }
      const error = new Error("cancelled");
      error.name = "AbortError";
      throw error;
    });

    await service.enqueueReclassify(userId, activeSlug);
    await scanStarted.promise;
    await service.enqueueReclassify(userId, queuedSlug);
    let cancellationResolved = false;
    const cancellation = service.cancelUserReclassifications(userId)
      .then(() => {
        cancellationResolved = true;
      });
    await abortObserved.promise;

    expect(cancellationResolved).toBe(false);
    expect(await waitForCondition(async () =>
      (await jobs.countDocuments({ userId })) === 0)).toBe(true);

    releasePage.resolve();
    await cancellation;
    expect(await waitForCondition(() => service._reclassifyWorker === null))
      .toBe(true);
    const game = await db.collection("games").findOne({
      userId,
      gameId: "no-late-tag",
    });
    expect(game.myBuild).toBe("Original tag");
  });

  test("GDPR game wipe waits for reclassification cancellation before deleting", async () => {
    const userId = "u-gdpr-order";
    const users = db.collection("users");
    await users.insertOne({ userId });
    const cancellationStarted = deferred();
    const releaseCancellation = deferred();
    const gamesCollection = db.collection("games");
    await gamesCollection.insertOne({
      userId,
      gameId: "gdpr-order-game",
      date: new Date("2026-08-13T23:00:00.000Z"),
    });
    const deleteGames = jest.fn((filter) => gamesCollection.deleteMany(filter));
    const customBuilds = {
      cancelUserReclassifications: jest.fn(async (cancelledUserId) => {
        expect(cancelledUserId).toBe(userId);
        cancellationStarted.resolve();
        await releaseCancellation.promise;
      }),
    };
    const gdpr = new GdprService(
      {
        users,
        games: {
          findOne: gamesCollection.findOne.bind(gamesCollection),
          find: gamesCollection.find.bind(gamesCollection),
          updateMany: gamesCollection.updateMany.bind(gamesCollection),
          deleteMany: deleteGames,
        },
        gameDetails: db.collection("gdpr_game_details"),
        macroJobs: db.collection("gdpr_macro_jobs"),
        opponents: db.collection("gdpr_opponents"),
      },
      { customBuilds },
    );

    const wipe = gdpr.wipeGames(userId);
    await cancellationStarted.promise;
    expect(deleteGames).not.toHaveBeenCalled();

    releaseCancellation.resolve();
    await expect(wipe).resolves.toEqual(expect.objectContaining({ games: 1 }));
    expect(customBuilds.cancelUserReclassifications).toHaveBeenCalledTimes(1);
    expect(deleteGames).toHaveBeenCalledTimes(1);
  });
});
