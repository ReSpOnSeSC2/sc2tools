// @ts-nocheck
"use strict";

const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { CommunityService } = require("../src/services/community");

describe("public opponent identity lookup", () => {
  let mongo;
  let db;
  let community;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "community_opponent_index" });
    community = new CommunityService(db);
    await db.opponents.insertMany(Array.from({ length: 4000 }, (_, n) => ({
      userId: `user-${n}`,
      pulseId: `1-S2-1-${n}`,
      ...(n % 2 ? { pulseCharacterId: `character-${n}` } : {}),
    })));
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  test.each([
    ["1-S2-1-3999", "character-3999"],
    ["1-S2-1-3998", null],
    ["never-seen", null],
  ])("%s avoids scanning unrelated users, including unresolved identities", async (pulseId, expected) => {
    const findSpy = jest.spyOn(db.opponents, "findOne");
    let query;
    try {
      const scope = await community._opponentScope(pulseId);
      expect(scope.pulseCharacterId).toBe(expected);
      expect(findSpy).toHaveBeenCalledTimes(1);
      query = findSpy.mock.calls[0];
    } finally {
      findSpy.mockRestore();
    }
    const plan = await db.opponents.find(...query).limit(1).explain("executionStats");
    const winningPlan = JSON.stringify(plan.queryPlanner.winningPlan);
    expect(winningPlan).toContain('"indexName":"pulseId_1_pulseCharacterId_1"');
    expect(winningPlan).not.toContain("COLLSCAN");
    expect(plan.executionStats.totalKeysExamined).toBeLessThanOrEqual(2);
    expect(plan.executionStats.totalDocsExamined).toBe(0);
  });
});
