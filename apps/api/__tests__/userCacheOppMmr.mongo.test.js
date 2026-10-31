// @ts-nocheck
"use strict";
// Real-Mongo admission of the opponent-MMR histogram and its drilldown: owner bodies are retained, a write to the
// owner's opponents rows (the MMR fallback both charts read) retires them, and another owner's write does not.
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
const config = { port: 0, nodeEnv: "test", logLevel: "silent", mongoUri: "", mongoDb: "cache_opp_mmr",
  clerkSecretKey: "sk_test", serverPepper: Buffer.alloc(32, 5), corsAllowedOrigins: [], rateLimitPerMinute: 5000,
  pythonExe: null, pythonAnalyzerDir: "/tmp/__nonexistent__", adminUserIds: [], userCacheEnabled: true };
const DAY = 86400000;
// Recent ranked games with no MMR snapshot, so both charts take the opponents row's MMR as the fallback.
const game = (gameId, daysAgo, overrides = {}) => ({ gameId, date: new Date(Date.now() - daysAgo * DAY), result: "Victory",
  myRace: "Protoss", myLadderRace: "P", playerCount: 2, isLadderGame: true, map: "Site Delta LE", durationSec: 600,
  opponent: { race: "Zerg", pulseId: "p1", displayName: "Opponent" }, ...overrides });
const PATHS = ["/v1/opp-mmr-buckets?bucket_width=100", "/v1/opp-mmr-buckets/games?lo=4300&hi=4400"];
const get = (path, owner = "a", tag = 'W/"none"') => request(app).get(path)
  .set("Authorization", `Bearer owner-${owner}`).set("If-None-Match", tag);
const row = (userId, mmr) => ({ userId, pulseId: "p1", race: "Zerg", mmr, gameCount: 3, wins: 2, losses: 1,
  firstSeen: new Date(Date.now() - 5 * DAY), lastSeen: new Date(Date.now() - DAY) });

beforeAll(async () => {
  mongo = await MongoMemoryServer.create(); db = await connect({ uri: mongo.getUri(), dbName: "cache_opp_mmr" });
  ({ app, services } = buildApp({ db, userBackupsStore: createBackupStore(), logger: pino({ level: "silent" }),
    clerkClient: { deleteUser: async () => {} }, config }));
});
afterAll(async () => { await services.customBuilds.stopReclassifications(); await db.close(); await mongo.stop(); });
beforeEach(async () => {
  for (const name of ["users", "games", "gameDetails", "opponents"]) await db[name].deleteMany({});
  for (const owner of ["a", "b"]) services.userRevision.forget(owner);
  await db.users.insertMany([{ userId: "a", clerkUserId: "clerk-a", dataRev: 0 }, { userId: "b", clerkUserId: "clerk-b", dataRev: 0 }]);
  for (const [id, daysAgo, result] of [["g1", 4, "Victory"], ["g2", 3, "Defeat"], ["g3", 2, "Victory"]]) {
    await services.games.upsert("a", game(id, daysAgo, { result }));
    await services.games.upsert("b", game(`b-${id}`, daysAgo, { result }));
  }
  await db.opponents.insertMany([row("a", 4320), row("b", 4320)]);
});

// [name, write, changes the histogram, changes the 4300-4400 drilldown]. The new rating moves every game out of the band.
const WRITES = [
  ["record a newer game at a new rating", () => services.opponents.recordGame("a", { pulseId: "p1", displayName: "Opponent",
    race: "Zerg", mmr: 4510, playedAt: new Date(), result: "Victory" }), true, true],
  ["recount the opponent from games", () => services.gdpr.recountOpponent("a", "p1"), false, false],
  ["rebuild the owner's opponents from games", () => services.gdpr.rebuildOpponentsForUser("a"), false, false],
];

test.each(PATHS)("%s retains owner bodies, every fenced opponents write retires them, and another owner's does not", async path => {
  let previous = await get(path);
  expect(previous.status).toBe(200); expect(previous.headers["cache-control"]).toBe("private, no-cache");
  expect(previous.text).toContain("4300");
  expect((await get(path, "a", previous.headers.etag)).status).toBe(304);
  const other = await get(path, "b");
  expect(other.status).toBe(200); expect(other.headers.etag).not.toBe(previous.headers.etag);
  await services.gdpr.recountOpponent("b", "p1");
  expect((await get(path, "a", previous.headers.etag)).status).toBe(304);
  for (const [name, write, changesHistogram, changesDrilldown] of WRITES) {
    const before = (await db.users.findOne({ userId: "a" })).dataRev;
    await write();
    expect([name, (await db.users.findOne({ userId: "a" })).dataRev > before]).toEqual([name, true]);
    const fresh = await get(path, "a", previous.headers.etag);
    expect([name, fresh.status]).toEqual([name, 200]); expect(fresh.headers.etag).not.toBe(previous.headers.etag);
    if (path.includes("/games") ? changesDrilldown : changesHistogram) expect([name, fresh.body]).not.toEqual([name, previous.body]);
    expect((await get(path, "a", fresh.headers.etag)).status).toBe(304);
    previous = fresh;
  }
});

// Restore and erasure write opponents through their collection-list loops' dynamic handles. Each write must run inside
// the owner's fence, and the owner's dataRev must move before the next list key (opponentNotes) is touched. Erasure runs
// last because it records the owner's identity as deleted.
test.each([
  ["snapshot restore", async () => { const saved = await services.gdpr.snapshot("a"); return () => services.gdpr.restoreSnapshot("a", saved.id); }],
  ["account erasure", async () => () => services.gdpr.deleteAll("a")],
])("%s writes the owner's opponents rows inside the owner's fence and bumps the owner's dataRev", async (name, prepare) => {
  const operation = await prepare(), writes = [], dataRev = async () => (await db.users.findOne({ userId: "a" })).dataRev;
  let next = null;
  for (const method of ["deleteMany", "insertMany"]) {
    const original = db.opponents[method].bind(db.opponents);
    jest.spyOn(db.opponents, method).mockImplementation(async (...args) => {
      writes.push({ method, active: services.userRevision.owners.get("a")?.active ?? 0, dataRev: await dataRev() });
      return original(...args);
    });
  }
  const notes = db.opponentNotes.deleteMany.bind(db.opponentNotes);
  jest.spyOn(db.opponentNotes, "deleteMany").mockImplementation(async (...args) => { next ??= await dataRev(); return notes(...args); });
  try { await operation(); } finally { jest.restoreAllMocks(); }
  expect([name, writes.map(write => write.method)]).toEqual([name, name === "snapshot restore" ? ["deleteMany", "insertMany"] : ["deleteMany"]]);
  expect([name, writes.filter(write => write.active < 1)]).toEqual([name, []]);
  expect([name, next > writes[0].dataRev]).toEqual([name, true]);
});
