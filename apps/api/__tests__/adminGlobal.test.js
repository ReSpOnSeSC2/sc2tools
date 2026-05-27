// @ts-nocheck
"use strict";

/**
 * AdminGlobalService — platform-wide tracking for the /admin/global tab.
 *
 * Pins the cross-user merge: the same real opponent tracked by two
 * users collapses into ONE global player record with summed games and
 * a ``trackedByUsers`` count of 2, plus the global strategy / build /
 * map distributions over every user's games.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { AdminGlobalService } = require("../src/services/adminGlobal");
const { PulseDirectoryService } = require("../src/services/pulseDirectory");

describe("AdminGlobalService", () => {
  let mongo;
  let db;
  let svc;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "admin_global_test" });
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await db.opponents.deleteMany({});
    await db.games.deleteMany({});
    await db.pulseAccounts.deleteMany({});
    svc = new AdminGlobalService({
      db,
      pulseDirectory: new PulseDirectoryService(db),
    });
  });

  // Two users both track the same opponent (pulseId P1); user A also
  // tracks a second opponent (P2).
  async function seedOpponents() {
    await db.opponents.insertMany([
      {
        userId: "userA",
        pulseId: "P1",
        pulseCharacterId: "111",
        displayNameSample: "Rival",
        race: "Z",
        gameCount: 10,
        wins: 6,
        losses: 4,
        mmr: 4800,
        leagueId: 4,
        firstSeen: new Date("2026-01-01"),
        lastSeen: new Date("2026-05-01"),
      },
      {
        userId: "userB",
        pulseId: "P1",
        pulseCharacterId: "111",
        displayNameSample: "RivalRenamed",
        race: "Z",
        gameCount: 4,
        wins: 1,
        losses: 3,
        mmr: 5000,
        leagueId: 5,
        firstSeen: new Date("2026-02-01"),
        lastSeen: new Date("2026-06-01"),
      },
      {
        userId: "userA",
        pulseId: "P2",
        displayNameSample: "Smurf",
        race: "T",
        gameCount: 2,
        wins: 2,
        losses: 0,
        firstSeen: new Date("2026-03-01"),
        lastSeen: new Date("2026-03-02"),
      },
    ]);
  }

  async function seedGames() {
    await db.games.insertMany([
      { userId: "userA", gameId: "g1", result: "Victory", map: "Ladder A", myBuild: "Pool first", opponent: { strategy: "2-base roach" } },
      { userId: "userA", gameId: "g2", result: "Defeat", map: "Ladder A", myBuild: "Pool first", opponent: { strategy: "2-base roach" } },
      { userId: "userB", gameId: "g3", result: "Victory", map: "Ladder B", myBuild: "Hatch first", opponent: { strategy: "proxy hatch" } },
    ]);
  }

  test("summary merges players across users and counts users", async () => {
    await seedOpponents();
    await seedGames();
    const s = await svc.summary();
    expect(s.trackedPlayers).toBe(2); // P1 + P2
    expect(s.opponentRows).toBe(3);
    expect(s.usersTracking).toBe(2); // userA + userB
    expect(s.totalGames).toBe(3);
    expect(typeof s.generatedAt).toBe("string");
  });

  test("listPlayers collapses one opponent across users", async () => {
    await seedOpponents();
    const res = await svc.listPlayers({ sort: "gameCount", order: "desc" });
    expect(res.total).toBe(2);
    const p1 = res.items.find((i) => i.pulseId === "P1");
    expect(p1).toBeTruthy();
    expect(p1.gameCount).toBe(14); // 10 + 4
    expect(p1.wins).toBe(7); // 6 + 1
    expect(p1.losses).toBe(7); // 4 + 3
    expect(p1.trackedByUsers).toBe(2);
    expect(p1.mmr).toBe(5000); // max across users
    // Representative display name is the most-recently-seen one.
    expect(p1.displayNameSample).toBe("RivalRenamed");
    expect(p1.pulseCharacterId).toBe("111");
    // gameCount desc → P1 (14) before P2 (2).
    expect(res.items[0].pulseId).toBe("P1");
    expect(res.races).toEqual(["T", "Z"]);
  });

  test("listPlayers honours search, race, and minGames filters", async () => {
    await seedOpponents();
    const onlyZerg = await svc.listPlayers({ race: "Z" });
    expect(onlyZerg.items.map((i) => i.pulseId)).toEqual(["P1"]);

    const bigOnly = await svc.listPlayers({ minGames: 5 });
    expect(bigOnly.items.map((i) => i.pulseId)).toEqual(["P1"]);

    const search = await svc.listPlayers({ search: "smurf" });
    expect(search.items.map((i) => i.pulseId)).toEqual(["P2"]);
  });

  test("breakdowns roll up strategies, builds, and maps globally", async () => {
    await seedGames();
    const b = await svc.breakdowns();
    const roach = b.strategies.find((r) => r.key === "2-base roach");
    expect(roach.count).toBe(2);
    expect(roach.wins).toBe(1);
    expect(roach.winRate).toBeCloseTo(0.5, 5);

    const ladderA = b.maps.find((r) => r.key === "Ladder A");
    expect(ladderA.count).toBe(2);

    const poolFirst = b.builds.find((r) => r.key === "Pool first");
    expect(poolFirst.count).toBe(2);
  });
});
