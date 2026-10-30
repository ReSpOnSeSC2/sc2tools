// @ts-nocheck
"use strict";
const request = require("supertest");
const pino = require("pino");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");
const { gameStampAdmission } = require("../src/services/opponentGameStamps");
const { createBackupStore } = require("./helpers/userBackupsStore");

jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(async token => {
    if (token === "owner-a" || token === "owner-b") return { sub: `clerk-${token.slice(-1)}` };
    throw new Error("invalid");
  }),
  createClerkClient: jest.fn(() => ({ users: { getUser: jest.fn() } })),
}));

let mongo, db, app, services;
const config = { port: 0, nodeEnv: "test", logLevel: "silent", mongoUri: "", mongoDb: "cache_net_mmr",
  clerkSecretKey: "sk_test", serverPepper: Buffer.alloc(32, 5), corsAllowedOrigins: [], rateLimitPerMinute: 5000,
  pythonExe: null, pythonAnalyzerDir: "/tmp/__nonexistent__", adminUserIds: [], userCacheEnabled: true };
// Ranked 1v1 replays with trusted MMR, so adjacent games pair inside the owner's full-history window.
const game = (gameId, day, overrides = {}) => ({ gameId, date: new Date(`2026-01-${day}T12:00:00Z`), result: "Victory",
  myRace: "Protoss", myLadderRace: "P", myToonHandle: "1-S2-1-123", myMmr: 4000, myMmrSource: "replay",
  playerCount: 2, isLadderGame: true, map: "Site Delta LE", durationSec: 600,
  opponent: { race: "Zerg", pulseId: "p1", displayName: "Opponent" }, ...overrides });
// The display filter ends before g5, so g5 can only act as the next reading of g4.
const PATHS = ["/v1/mmr-by-matchup?until=2026-01-05", "/v1/mmr-by-matchup/opponents?until=2026-01-05"];
const get = (path, owner = "a", tag = 'W/"none"') => request(app).get(path)
  .set("Authorization", `Bearer owner-${owner}`).set("If-None-Match", tag);

beforeAll(async () => {
  mongo = await MongoMemoryServer.create(); db = await connect({ uri: mongo.getUri(), dbName: "cache_net_mmr" });
  ({ app, services } = buildApp({ db, userBackupsStore: createBackupStore(), logger: pino({ level: "silent" }),
    clerkClient: { deleteUser: async () => {} }, config }));
});
afterAll(async () => { await services.customBuilds.stopReclassifications(); await db.close(); await mongo.stop(); });
beforeEach(async () => {
  for (const name of ["users", "games", "gameDetails", "opponents"]) await db[name].deleteMany({});
  for (const owner of ["a", "b"]) services.userRevision.forget(owner);
  await db.users.insertMany([{ userId: "a", clerkUserId: "clerk-a", dataRev: 0 }, { userId: "b", clerkUserId: "clerk-b", dataRev: 0 }]);
});

const heal = async () => {
  const admission = await gameStampAdmission(services.opponents.gameStatsWrites, "a", undefined, true);
  expect(await services.opponents._backfillGameIdentity("a", "p1", { pulseCharacterId: "77" }, admission)).toBeGreaterThan(0);
};
// Each write changes only rows or fields a net-MMR body reads; [name, write, changes matchup body, changes opponents body].
const WRITES = [
  ["hide the next game", () => services.gameControls.setExcluded("a", "g2", { excluded: true, reason: "friend_played" }), true, true],
  ["reupload the hidden game's MMR", () => services.games.upsert("a", game("g2", "02", { result: "Defeat", myMmr: 4010 })), true, true],
  ["unhide", () => services.gameControls.setExcluded("a", "g2", { excluded: false }), true, true],
  ["quarantine the next game", () => services.games.quarantineResumedReplay("a", game("g3", "03", { myMmr: 4005 })), true, true],
  ["ingest a later game outside the display filter", () => services.games.upsert("a", game("g5", "10", { myMmr: 4050 })), true, true],
  ["opponent identity heal", heal, false, true],
  ["pending delete and tombstone", () => services.gameControls.deleteGame("a", "g4"), true, true],
];

test.each(PATHS)("%s retains owner bodies and every window-only write retires them", async path => {
  for (const [id, day, result, mmr] of [["g1", "01", "Victory", 4000], ["g2", "02", "Defeat", 4020], ["g3", "03", "Victory", 4005],
    ["g4", "04", "Victory", 4030]]) await services.games.upsert("a", game(id, day, { result, myMmr: mmr }));
  await services.games.upsert("b", game("other", "01", { myMmr: 1000 }));
  let previous = await get(path);
  expect(previous.status).toBe(200); expect(previous.headers["cache-control"]).toBe("private, no-cache");
  expect((await get(path, "a", previous.headers.etag)).status).toBe(304);
  const other = await get(path, "b", previous.headers.etag);
  expect(other.status).toBe(200); expect(other.body).not.toEqual(previous.body);
  const matchup = path.startsWith("/v1/mmr-by-matchup?");
  for (const [name, write, changesMatchup, changesOpponents] of WRITES) {
    await write();
    const fresh = await get(path, "a", previous.headers.etag);
    expect([name, fresh.status]).toEqual([name, 200]); expect(fresh.headers.etag).not.toBe(previous.headers.etag);
    if (matchup ? changesMatchup : changesOpponents) expect([name, fresh.body]).not.toEqual([name, previous.body]);
    expect((await get(path, "a", fresh.headers.etag)).status).toBe(304);
    previous = fresh;
  }
});
