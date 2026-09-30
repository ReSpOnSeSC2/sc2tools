// @ts-nocheck
"use strict";

/**
 * db/migrations/2026-09-30-rename-8-pool-builds.js — stored pool-opener
 * labels get their patch's name ("8 Pool" on the 8-worker patch 5.0.16,
 * "12 Pool" elsewhere) on games and guide samples; the 8 Pool guides'
 * notes move to the 12 Pool guides. A dry run writes nothing, a note never
 * overwrites the 12 Pool guide's own, and a second run is a no-op.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { renamePoolBuilds } = require("../src/db/migrations/2026-09-30-rename-8-pool-builds");

const V16 = "5.0.16.97425";
const V17 = "5.0.17.98000";
const V15 = "5.0.15.96883";

describe("pool build names migration", () => {
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
      // 12-worker games stored under the 8-worker name.
      { userId: "u1", gameId: "g15", gameVersion: V15, myBuild: "Zerg - 8 Pool", opponent: { strategy: "Protoss - Cannon Rush" } },
      { userId: "u1", gameId: "g17", gameVersion: V17, myBuild: "PvZ - Stargate Opener", opponent: { strategy: "ZvP - 8 Pool Rush" } },
      // 8-worker games stored under the 12-worker name, and one already right.
      {
        userId: "u2", gameId: "g16a", gameVersion: V16, myBuild: "ZvZ - 12 Pool Speedling",
        opponent: { strategy: "ZvZ - 12 Pool into Baneling" }, opp_strategy: "Zerg - 12 Pool",
      },
      { userId: "u2", gameId: "g16b", gameVersion: V16, myBuild: "Zerg - 8 Pool", opponent: { strategy: "Zerg - 8 Pool" } },
      // Already right for 12 workers.
      { userId: "u2", gameId: "g17b", gameVersion: V17, myBuild: "Zerg - 12 Pool", opponent: { strategy: "Zerg - 12 Pool" } },
    ]);
    await ctx.guideSamples.insertMany([
      { userHash: "h1", gameHash: "s-after", buildKey: "Zerg - 8 Pool", matchup: "ZvP", era: "after", eraRule: 2 },
      { userHash: "h1", gameHash: "s-before", buildKey: "Zerg - 12 Pool", matchup: "ZvP", era: "before", eraRule: 2 },
      { userHash: "h1", gameHash: "s-other", buildKey: "PvZ - Stargate Opener", matchup: "PvZ", era: "after", eraRule: 2 },
    ]);
    await ctx.guideNotes.insertMany([
      { matchup: "ZvP", buildKey: "ZvP - 8 Pool Rush", body: "Pool rush plan", videos: { pinned: [], hidden: [] } },
      { matchup: "ZvZ", buildKey: "ZvZ - 8 Pool Speedling", body: "old note", videos: { pinned: [], hidden: [] } },
      { matchup: "ZvZ", buildKey: "ZvZ - 12 Pool Speedling", body: "new note", videos: { pinned: [], hidden: [] } },
    ]);
  }

  test("dry run counts without writing; a real run renames by patch once; a rerun is a no-op", async () => {
    await seed();
    const conflicts = [{ matchup: "ZvZ", buildKey: "ZvZ - 8 Pool Speedling" }];
    const planned = await renamePoolBuilds(ctx.db, { dryRun: true });
    expect(planned).toEqual({ games: 5, samples: 2, notes: 1, noteConflicts: conflicts });
    expect(await ctx.games.countDocuments({ myBuild: "ZvZ - 12 Pool Speedling" })).toBe(1);

    expect(await renamePoolBuilds(ctx.db)).toEqual(planned);
    const games = Object.fromEntries((await ctx.games.find({}).toArray()).map((g) => [g.gameId, g]));
    expect(games.g15).toMatchObject({ myBuild: "Zerg - 12 Pool", opponent: { strategy: "Protoss - Cannon Rush" } });
    expect(games.g17).toMatchObject({ myBuild: "PvZ - Stargate Opener", opponent: { strategy: "ZvP - 12 Pool Rush" } });
    expect(games.g16a).toMatchObject({
      myBuild: "ZvZ - 8 Pool Speedling", opponent: { strategy: "ZvZ - 8 Pool into Baneling" }, opp_strategy: "Zerg - 8 Pool",
    });
    expect(games.g16b).toMatchObject({ myBuild: "Zerg - 8 Pool", opponent: { strategy: "Zerg - 8 Pool" } });
    expect(games.g17b).toMatchObject({ myBuild: "Zerg - 12 Pool", opponent: { strategy: "Zerg - 12 Pool" } });
    const samples = Object.fromEntries((await ctx.guideSamples.find({}).toArray()).map((s) => [s.gameHash, s.buildKey]));
    expect(samples).toEqual({ "s-after": "Zerg - 12 Pool", "s-before": "Zerg - 8 Pool", "s-other": "PvZ - Stargate Opener" });
    expect(await ctx.guideNotes.findOne({ matchup: "ZvP", buildKey: "ZvP - 12 Pool Rush" })).toMatchObject({ body: "Pool rush plan" });
    // The 12 Pool guide's own note wins; the old one stays for the admin.
    expect(await ctx.guideNotes.findOne({ matchup: "ZvZ", buildKey: "ZvZ - 12 Pool Speedling" })).toMatchObject({ body: "new note" });
    expect(await ctx.guideNotes.findOne({ matchup: "ZvZ", buildKey: "ZvZ - 8 Pool Speedling" })).toMatchObject({ body: "old note" });

    expect(await renamePoolBuilds(ctx.db)).toEqual({ games: 0, samples: 0, notes: 0, noteConflicts: conflicts });
  });
});
