// @ts-nocheck
"use strict";

/**
 * db/migrations/2026-09-30-rename-8-pool-builds.js — stored "8 Pool"
 * labels become "12 Pool" on games, guide samples and guide notes; a dry
 * run writes nothing, a note never overwrites the 12 Pool guide's own, and
 * a second run is a no-op.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { renamePoolBuilds } = require("../src/db/migrations/2026-09-30-rename-8-pool-builds");

describe("rename 8 Pool builds migration", () => {
  let mongo;
  let ctx;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    ctx = await connect({ uri: mongo.getUri(), dbName: "rename_pool_builds" });
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
    if (mongo) await mongo.stop();
  });

  async function seed() {
    await ctx.games.insertMany([
      { userId: "u1", gameId: "g1", myBuild: "Zerg - 8 Pool", opponent: { race: "Protoss", strategy: "Protoss - Cannon Rush" } },
      { userId: "u1", gameId: "g2", myBuild: "PvZ - Stargate Opener", opponent: { race: "Zerg", strategy: "ZvP - 8 Pool Rush" } },
      { userId: "u2", gameId: "g3", myBuild: "ZvZ - 8 Pool Speedling", opponent: { strategy: "ZvZ - 8 Pool into Baneling" }, opp_strategy: "Zerg - 8 Pool" },
      { userId: "u2", gameId: "g4", myBuild: "Zerg - 12 Pool", opponent: { strategy: "Zerg - 12 Pool" } },
    ]);
    await ctx.guideSamples.insertMany([
      { userHash: "h1", gameHash: "s1", buildKey: "Zerg - 8 Pool", matchup: "ZvP", era: "before", eraRule: 2 },
      { userHash: "h1", gameHash: "s2", buildKey: "PvZ - Stargate Opener", matchup: "PvZ", era: "after", eraRule: 2 },
    ]);
    await ctx.guideNotes.insertMany([
      { matchup: "ZvP", buildKey: "ZvP - 8 Pool Rush", body: "Pool rush plan", videos: { pinned: [], hidden: [] } },
      { matchup: "ZvZ", buildKey: "ZvZ - 8 Pool Speedling", body: "old note", videos: { pinned: [], hidden: [] } },
      { matchup: "ZvZ", buildKey: "ZvZ - 12 Pool Speedling", body: "new note", videos: { pinned: [], hidden: [] } },
    ]);
  }

  test("dry run counts without writing; a real run renames once; a rerun is a no-op", async () => {
    await seed();
    const planned = await renamePoolBuilds(ctx.db, { dryRun: true });
    expect(planned).toEqual({
      games: 5, samples: 1, notes: 1,
      noteConflicts: [{ matchup: "ZvZ", buildKey: "ZvZ - 8 Pool Speedling" }],
    });
    expect(await ctx.games.countDocuments({ myBuild: "Zerg - 8 Pool" })).toBe(1);

    expect(await renamePoolBuilds(ctx.db)).toEqual(planned);
    const games = Object.fromEntries((await ctx.games.find({}).toArray()).map((g) => [g.gameId, g]));
    expect(games.g1).toMatchObject({ myBuild: "Zerg - 12 Pool", opponent: { strategy: "Protoss - Cannon Rush" } });
    expect(games.g2).toMatchObject({ myBuild: "PvZ - Stargate Opener", opponent: { strategy: "ZvP - 12 Pool Rush" } });
    expect(games.g3).toMatchObject({
      myBuild: "ZvZ - 12 Pool Speedling", opponent: { strategy: "ZvZ - 12 Pool into Baneling" }, opp_strategy: "Zerg - 12 Pool",
    });
    expect(games.g4).toMatchObject({ myBuild: "Zerg - 12 Pool", opponent: { strategy: "Zerg - 12 Pool" } });
    expect(await ctx.guideSamples.findOne({ gameHash: "s1" })).toMatchObject({ buildKey: "Zerg - 12 Pool" });
    expect(await ctx.guideNotes.findOne({ matchup: "ZvP", buildKey: "ZvP - 12 Pool Rush" })).toMatchObject({ body: "Pool rush plan" });
    // The 12 Pool guide's own note wins; the old one stays for the admin.
    expect(await ctx.guideNotes.findOne({ matchup: "ZvZ", buildKey: "ZvZ - 12 Pool Speedling" })).toMatchObject({ body: "new note" });
    expect(await ctx.guideNotes.findOne({ matchup: "ZvZ", buildKey: "ZvZ - 8 Pool Speedling" })).toMatchObject({ body: "old note" });

    expect(await renamePoolBuilds(ctx.db)).toEqual({
      games: 0, samples: 0, notes: 0,
      noteConflicts: [{ matchup: "ZvZ", buildKey: "ZvZ - 8 Pool Speedling" }],
    });
  });
});
