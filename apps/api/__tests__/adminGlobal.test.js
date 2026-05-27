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
    await db.users.deleteMany({});
    await db.pulseAccounts.deleteMany({});
    svc = new AdminGlobalService({
      db,
      pulseDirectory: new PulseDirectoryService(db),
    });
  });

  async function seedUsers() {
    await db.users.insertMany([
      { userId: "userA", clerkUserId: "clerkA", email: "a@example.com" },
      { userId: "userB", clerkUserId: "clerkB", email: "b@example.com" },
    ]);
  }

  // Games against P1 owned by two different users, plus an unrelated
  // game vs P2. Carries dates + pulse ids so the player drill-down can
  // filter + cursor-paginate them.
  async function seedPlayerGames() {
    await db.games.insertMany([
      {
        userId: "userA",
        gameId: "p1g1",
        oppPulseId: "P1",
        date: new Date("2026-05-01"),
        result: "Victory",
        myRace: "P",
        map: "Ladder A",
        opponent: { displayName: "Rival", race: "Z", strategy: "2-base roach" },
      },
      {
        userId: "userB",
        gameId: "p1g2",
        date: new Date("2026-06-01"),
        result: "Defeat",
        myRace: "T",
        map: "Ladder B",
        opponent: {
          pulseId: "P1",
          displayName: "RivalRenamed",
          race: "Z",
          strategy: "2-base roach",
        },
      },
      {
        userId: "userA",
        gameId: "p2g1",
        oppPulseId: "P2",
        date: new Date("2026-03-02"),
        result: "Victory",
        opponent: { displayName: "Smurf", race: "T" },
      },
    ]);
  }

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

  test("playerProfile merges one player across users with per-user breakdown", async () => {
    await seedOpponents();
    await seedUsers();
    await seedPlayerGames();
    const prof = await svc.playerProfile("P1");
    expect(prof).toBeTruthy();
    expect(prof.gameCount).toBe(14); // 10 + 4
    expect(prof.wins).toBe(7);
    expect(prof.losses).toBe(7);
    expect(prof.winRate).toBeCloseTo(0.5, 5);
    expect(prof.trackedByUsers).toBe(2);
    expect(prof.mmr).toBe(5000); // max across users
    // Representative is the most-recently-seen row (userB renamed).
    expect(prof.displayNameSample).toBe("RivalRenamed");
    expect(prof.pulseCharacterId).toBe("111");

    // Per-user breakdown carries each user's record + resolved email,
    // sorted by game count desc (userA: 10 before userB: 4).
    expect(prof.perUser.map((u) => u.userId)).toEqual(["userA", "userB"]);
    expect(prof.perUser[0].email).toBe("a@example.com");
    expect(prof.perUser[0].gameCount).toBe(10);
    expect(prof.perUser[1].email).toBe("b@example.com");

    // Strategy + map distributions come from the games vs this player.
    const roach = prof.strategies.find((r) => r.key === "2-base roach");
    expect(roach.count).toBe(2);
    expect(prof.maps.map((m) => m.key).sort()).toEqual(["Ladder A", "Ladder B"]);
  });

  test("playerProfile returns null for an untracked pulseId", async () => {
    await seedOpponents();
    expect(await svc.playerProfile("does-not-exist")).toBeNull();
  });

  test("listPlayerGames returns games across all users, newest first", async () => {
    await seedUsers();
    await seedPlayerGames();
    const res = await svc.listPlayerGames("P1");
    expect(res.items.map((g) => g.gameId)).toEqual(["p1g2", "p1g1"]);
    // Each row attributes the owning user + resolved email so the UI
    // can deep-link the build order.
    expect(res.items[0].userId).toBe("userB");
    expect(res.items[0].userEmail).toBe("b@example.com");
    expect(res.items[0].opponent.strategy).toBe("2-base roach");
    // P2's game must not leak into a P1 query.
    expect(res.items.some((g) => g.gameId === "p2g1")).toBe(false);
  });

  test("listPlayerGames paginates with a before cursor", async () => {
    await seedUsers();
    await seedPlayerGames();
    const firstPage = await svc.listPlayerGames("P1", { limit: 1 });
    expect(firstPage.items.map((g) => g.gameId)).toEqual(["p1g2"]);
    expect(firstPage.nextBefore).toBeInstanceOf(Date);
    const secondPage = await svc.listPlayerGames("P1", {
      limit: 1,
      before: firstPage.nextBefore,
    });
    expect(secondPage.items.map((g) => g.gameId)).toEqual(["p1g1"]);
  });
});
