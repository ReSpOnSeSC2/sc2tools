// @ts-nocheck
"use strict";
// Real-Mongo proof of the analysis-corpus change stamp (util/corpusUpdatedAt.js): corpus-changing games writes set
// `updatedAt`, writes that cannot change the corpus leave it alone, a restore re-stamps what it inserts, and the
// partial {userId, updatedAt} index serves a changed-since read. Each case first pins the row's stamp to OLD.
const pino = require("pino");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");
const { createBackupStore } = require("./helpers/userBackupsStore");
const { applyOpponentGameMutation } = require("../src/services/gameStatsOpponentGame");
const { applyPulseStamp } = require("../src/services/gameStatsPulseNeutral");
const { applyMacroSurface } = require("../src/services/gameStatsCountNeutral");

let mongo, db, services;
const OLD = new Date("2020-01-01T00:00:00Z");
const config = { nodeEnv: "test", clerkSecretKey: "sk_test", serverPepper: Buffer.alloc(32, 7), rateLimitPerMinute: 5000,
  corsAllowedOrigins: [], adminUserIds: [], pythonAnalyzerDir: "/none", pythonExe: null };
const game = (gameId, overrides = {}) => ({ gameId, date: new Date(), result: "Victory", myRace: "Protoss", map: "Site Delta LE",
  durationSec: 600, opponent: { race: "Zerg", pulseId: "p1", displayName: "Opponent" }, ...overrides });
const row = gameId => db.games.findOne({ userId: "a", gameId });
const pin = gameId => db.games.updateOne({ userId: "a", gameId }, { $set: { updatedAt: OLD } });
// A stamp is fresh when it is a Date taken no earlier than `since`.
const fresh = (value, since) => value instanceof Date && value.getTime() >= since.getTime();

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  db = await connect({ uri: mongo.getUri(), dbName: "games_updated_at", awaitBackgroundIndexes: true });
  ({ services } = buildApp({ db, userBackupsStore: createBackupStore(), logger: pino({ level: "silent" }),
    clerkClient: { deleteUser: async () => {} }, config }));
});
afterAll(async () => { await services.customBuilds.stopReclassifications(); await db.close(); await mongo.stop(); });
beforeEach(async () => {
  for (const name of ["users", "games", "gameDetails", "opponents", "userBackups"]) await db[name].deleteMany({});
  await db.db.collection("backup_restore_staging").deleteMany({});
  await db.users.insertOne({ userId: "a", clerkUserId: "clerk-a" });
});

test("an ingest stamps the row; an operator reupload always restamps, a pipeline reupload only on a corpus change", async () => {
  let since = new Date(); const first = game("g1"); await services.games.upsert("a", first);
  expect(fresh((await row("g1")).updatedAt, since)).toBe(true);
  await pin("g1"); since = new Date(); await services.games.upsert("a", first);
  expect(fresh((await row("g1")).updatedAt, since)).toBe(true);
  const unavailable = { ...first, myMmrSource: "unavailable", result: "Defeat" };
  await pin("g1"); since = new Date(); await services.games.upsert("a", unavailable);
  expect(fresh((await row("g1")).updatedAt, since)).toBe(true);
  await pin("g1"); await services.games.upsert("a", unavailable);
  expect((await row("g1")).updatedAt).toEqual(OLD);
});

test("hide, unhide, pending delete, the tombstone and resumed quarantine restamp the row", async () => {
  await services.games.upsert("a", game("g1")); await services.games.upsert("a", game("g2"));
  for (const [name, write] of [["hide", () => services.gameControls.setExcluded("a", "g1", { excluded: true, reason: "friend_played" })],
    ["unhide", () => services.gameControls.setExcluded("a", "g1", { excluded: false })],
    ["quarantine", () => services.games.quarantineResumedReplay("a", game("g2"))]]) {
    const target = name === "quarantine" ? "g2" : "g1";
    await pin(target); const since = new Date(); await write();
    expect([name, fresh((await row(target)).updatedAt, since)]).toEqual([name, true]);
  }
  expect((await row("g2")).isResumedFromReplay).toBe(true);
  await pin("g1"); const since = new Date(); await services.gameControls.deleteGame("a", "g1");
  const tombstone = await row("g1");
  expect([tombstone._deleted, fresh(tombstone.updatedAt, since)]).toEqual([true, true]);
});

test("a restore re-stamps the rows it inserts instead of keeping the snapshot's stamp", async () => {
  await services.games.upsert("a", game("g1")); await pin("g1");
  const saved = await services.gdpr.snapshot("a");
  const since = new Date(); await services.gdpr.restoreSnapshot("a", saved.id);
  expect(fresh((await row("g1")).updatedAt, since)).toBe(true);
});

test("opponent identity and pulse writes stamp only when they change a corpus field", async () => {
  await services.games.upsert("a", game("g1")); await pin("g1");
  const owner = { userId: "a" }, id = (await row("g1"))._id;
  await applyOpponentGameMutation(db, owner, { kind: "opponentGameRegion", gameId: "g1", region: "EU" });
  await applyOpponentGameMutation(db, owner, { kind: "opponentGameIdentity", pulseId: "p1", region: "EU" });
  await applyPulseStamp(db, owner, { field: "league", id, value: 3 });
  expect((await row("g1")).updatedAt).toEqual(OLD);
  let since = new Date();
  await applyOpponentGameMutation(db, owner, { kind: "opponentGameIdentity", pulseId: "p1", region: "EU", pulseCharacterId: "77" });
  expect(fresh((await row("g1")).updatedAt, since)).toBe(true);
  await pin("g1"); since = new Date(); await applyPulseStamp(db, owner, { field: "mmr", id, value: 4200 });
  expect(fresh((await row("g1")).updatedAt, since)).toBe(true);
});

test("an unchanged corpus keeps the stamp and reports no modification, and a $-leading value stays literal", async () => {
  await services.games.upsert("a", game("g1")); const owner = { userId: "a" };
  const identity = { kind: "opponentGameIdentity", pulseId: "p1", region: "EU", pulseCharacterId: "77" };
  await applyOpponentGameMutation(db, owner, identity); await pin("g1");
  expect((await applyOpponentGameMutation(db, owner, identity)).modifiedCount).toBe(0);
  await services.gameControls.setExcluded("a", "g1", { excluded: false });
  expect((await row("g1")).updatedAt).toEqual(OLD);
  const { withUpdatedAt } = require("../src/util/corpusUpdatedAt"), since = new Date();
  await db.games.updateOne({ userId: "a", gameId: "g1" }, withUpdatedAt({ $set: { "opponent.displayName": "$myRace" } }));
  const renamed = await row("g1");
  expect([renamed.opponent.displayName, fresh(renamed.updatedAt, since), "_corpusBefore" in renamed]).toEqual(["$myRace", true, false]);
});

test("a write that changes no corpus field leaves a never-stamped row unstamped, and a macro change stamps once", async () => {
  await services.games.upsert("a", game("g1")); await db.games.updateOne({ userId: "a", gameId: "g1" }, { $unset: { updatedAt: "" } });
  const owner = { userId: "a" }, region = { kind: "opponentGameIdentity", pulseId: "p1", region: "EU" };
  expect((await applyOpponentGameMutation(db, owner, region)).modifiedCount).toBe(1);
  expect((await applyOpponentGameMutation(db, owner, region)).modifiedCount).toBe(0);
  expect("updatedAt" in (await row("g1"))).toBe(false);
  const macro = { gameId: "g1", macroScore: 71, top3Leaks: [{ name: "idle", amount: 2 }] }, since = new Date();
  await applyMacroSurface(db, owner, macro);
  expect(fresh((await row("g1")).updatedAt, since)).toBe(true);
  await pin("g1");
  expect((await applyMacroSurface(db, owner, macro)).modifiedCount).toBe(0);
  expect((await row("g1")).updatedAt).toEqual(OLD);
});

test("the partial change-stamp index exists and serves a changed-since read", async () => {
  const index = (await db.games.indexes()).find(spec => spec.name === "games_user_updated_at");
  expect(index).toMatchObject({ key: { userId: 1, updatedAt: 1, _id: 1 }, partialFilterExpression: { updatedAt: { $exists: true } } });
  await services.games.upsert("a", game("g1")); await services.games.upsert("a", game("g2")); await pin("g2");
  const query = { userId: "a", updatedAt: { $gt: new Date(Date.now() - 60000) } };
  // A hint on a partial index the query cannot use is refused, so this also proves the read is eligible.
  expect((await db.games.find(query).hint("games_user_updated_at").toArray()).map(doc => doc.gameId)).toEqual(["g1"]);
});
