// @ts-nocheck
"use strict";
const request = require("supertest");
const pino = require("pino");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");
const { createBackupStore } = require("./helpers/userBackupsStore");

jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(async token => {
    if (token === "owner-a" || token === "owner-b") return { sub: `clerk-${token.slice(-1)}` };
    throw new Error("invalid");
  }),
  createClerkClient: jest.fn(() => ({ users: { getUser: jest.fn() } })),
}));

let mongo, db, app, services;
const config = { port: 0, nodeEnv: "test", logLevel: "silent", mongoUri: "", mongoDb: "cache_streak_macro",
  clerkSecretKey: "sk_test", serverPepper: Buffer.alloc(32, 5), corsAllowedOrigins: [], rateLimitPerMinute: 5000,
  pythonExe: null, pythonAnalyzerDir: "/tmp/__nonexistent__", adminUserIds: [], userCacheEnabled: true };
const game = (gameId, overrides = {}) => ({ gameId, date: new Date("2026-01-01T12:00:00Z"), result: "Victory",
  myRace: "Protoss", map: "Site Delta LE", durationSec: 600, macroScore: 70, myBuild: "Expand",
  top3Leaks: [{ name: "Supply Blocked", mineral_cost: 120, penalty: 4 }],
  opponent: { race: "Zerg", strategy: "Pool", displayName: "Opponent" }, ...overrides });
const get = (path, owner = "a", tag = 'W/"none"') => request(app).get(path)
  .set("Authorization", `Bearer owner-${owner}`).set("If-None-Match", tag);

beforeAll(async () => {
  mongo = await MongoMemoryServer.create(); db = await connect({ uri: mongo.getUri(), dbName: "cache_streak_macro" });
  ({ app, services } = buildApp({ db, userBackupsStore: createBackupStore(), logger: pino({ level: "silent" }),
    clerkClient: { deleteUser: async () => {} }, config }));
});
afterAll(async () => { await services.customBuilds.stopReclassifications(); await db.close(); await mongo.stop(); });
beforeEach(async () => {
  for (const name of ["users", "games", "gameDetails"]) await db[name].deleteMany({});
  for (const owner of ["a", "b"]) services.userRevision.forget(owner);
  await db.users.insertMany([{ userId: "a", clerkUserId: "clerk-a", dataRev: 0 }, { userId: "b", clerkUserId: "clerk-b", dataRev: 0 }]);
});

// Listed writers of inputs both kinds read; the macro surface write changes no streak input.
const MUTATIONS = [
  ["ingest", () => services.games.upsert("a", game("two", { date: new Date("2026-02-01T12:00:00Z"), result: "Defeat", macroScore: 40 })), true],
  ["reupload", () => services.games.upsert("a", game("two", { date: new Date("2026-03-01T12:00:00Z"), macroScore: 90,
    top3Leaks: [{ name: "Idle Production", mineral_cost: 300, penalty: 9 }] })), true],
  ["quarantine", () => services.games.quarantineResumedReplay("a", game("two")), true],
  ["hide", () => services.gameControls.setExcluded("a", "one", { excluded: true, reason: "friend_played" }), true],
  ["unhide", () => services.gameControls.setExcluded("a", "one", { excluded: false }), true],
  ["macro surface", () => services.perGame.writeMacroBreakdown("a", "one", { macroScore: 55, breakdown: {},
    top3Leaks: [{ name: "Floating Minerals", mineral_cost: 80, penalty: 2 }] }), false],
  ["pending delete and tombstone", () => services.gameControls.deleteGame("a", "one"), true],
];

test.each([["/v1/streak", "streak"], ["/v1/macro/report", "macro report"]])("%s retains owner bodies and each listed writer retires them", async (path, kind) => {
  await services.games.upsert("a", game("one"));
  await services.games.upsert("b", game("other", { result: "Defeat", macroScore: 1 }));
  let previous = await get(path);
  expect(previous.status).toBe(200); expect(previous.headers["cache-control"]).toBe("private, no-cache");
  expect((await get(path, "a", previous.headers.etag)).status).toBe(304);
  const other = await get(path, "b", previous.headers.etag);
  expect(other.status).toBe(200); expect(other.body).not.toEqual(previous.body);
  for (const [name, mutate, changesStreak] of MUTATIONS) {
    await mutate();
    const fresh = await get(path, "a", previous.headers.etag);
    expect([name, fresh.status]).toEqual([name, 200]); expect(fresh.headers.etag).not.toBe(previous.headers.etag);
    if (kind === "macro report" || changesStreak) expect([name, fresh.body]).not.toEqual([name, previous.body]);
    expect((await get(path, "a", fresh.headers.etag)).status).toBe(304);
    previous = fresh;
  }
});

// A failed payload purge stops the delete after its pending mark, before the tombstone.
test.each(["/v1/streak", "/v1/macro/report"])("%s retires on the pending-delete mark alone", async path => {
  await services.games.upsert("a", game("one"));
  await services.games.upsert("a", game("two", { date: new Date("2026-02-01T12:00:00Z"), result: "Defeat", macroScore: 40 }));
  const retained = await get(path);
  expect(retained.status).toBe(200); expect((await get(path, "a", retained.headers.etag)).status).toBe(304);
  const purge = jest.spyOn(services.gameControls, "purgePayloads").mockRejectedValueOnce(new Error("purge unavailable"));
  try { await expect(services.gameControls.deleteGame("a", "two")).rejects.toThrow("purge unavailable"); } finally { purge.mockRestore(); }
  expect((await db.games.findOne({ userId: "a", gameId: "two" }))._deleted).toBeUndefined();
  const fresh = await get(path, "a", retained.headers.etag);
  expect(fresh.status).toBe(200); expect(fresh.headers.etag).not.toBe(retained.headers.etag); expect(fresh.body).not.toEqual(retained.body);
  expect((await get(path, "a", fresh.headers.etag)).status).toBe(304);
});
