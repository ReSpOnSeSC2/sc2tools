// @ts-nocheck
"use strict";
const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { OverlayTokensService } = require("../src/services/overlayTokens");
const { MultichatStudioService } = require("../src/services/multichatStudio");
const { StreamSeriesService } = require("../src/services/streamSeries");
const START = Date.parse("2026-10-25T10:00:00Z"), NOW = START + 3_600_000;
const OWNER = "series-owner";
let mongo, db, tokens, token, other, studio, svc, events, completed, clock;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const startBody = (patch = {}) => ({ action: "start", revision: 0, format: 3, opponentName: "Clem", opponentToon: "2-S2-1-99", maps: ["Alcyone", "Goldenaura", "Site Delta"], ...patch });
const game = (patch = {}) => ({ gameId: "private-replay", startedAt: new Date(START + 1000).toISOString(), date: new Date(START + 601_000).toISOString(),
  result: "Victory", map: "Alcyone", myRace: "Protoss", opponent: { displayName: "Clem", toonHandle: "2-S2-1-99", race: "Terran" }, ...patch });
beforeAll(async () => {
  mongo = await MongoMemoryServer.create(); db = await connect({ uri: mongo.getUri(), dbName: "stream_series" });
  await db.multichatStudio.createIndex({ studioKey: 1 }, { unique: true, sparse: true });
  await db.overlayTokens.createIndex({ token: 1 }, { unique: true });
});
afterAll(async () => { await db?.close(); await mongo?.stop(); });
beforeEach(async () => {
  jest.restoreAllMocks();
  for (const col of [db.overlayTokens, db.multichatStudio, db.games]) await col.deleteMany({});
  tokens = new OverlayTokensService(db); token = (await tokens.create(OWNER, "Series")).token;
  other = (await tokens.create("other-owner", "Other")).token; events = []; completed = jest.fn(); clock = START;
  const io = { to: room => ({ emit: (event, payload) => events.push({ room, event, payload }) }) };
  studio = new MultichatStudioService(db, { io, overlayTokens: tokens });
  svc = new StreamSeriesService({ studio, games: db.games, tokens, io, now: () => clock, onCompleted: completed });
});

test("default-off reads and ordinary ingest create no state; owner scope is enforced", async () => {
  expect(await svc.get(token, OWNER)).toBeNull();
  await svc.ingest(OWNER, [game()]);
  expect(await db.multichatStudio.countDocuments({})).toBe(0);
  await expect(svc.get(other, OWNER)).rejects.toMatchObject({ status: 401 });
  await expect(svc.act(other, OWNER, startBody())).rejects.toMatchObject({ status: 401 });
  expect(events).toEqual([]);
});
test("explicit start persists only the bounded subdocument and preserves other Studio state", async () => {
  await studio.ensureCanonical(token);
  await db.multichatStudio.updateOne({ studioKey: token }, { $set: { goals: [{ label: "Keep me" }], broll: { clips: [{ id: "keep" }] } } });
  const result = await svc.act(token, OWNER, startBody());
  expect(result).toMatchObject({ revision: 1, format: 3, status: "active", score: { you: 0, opponent: 0 }, headToHead: { wins: 0, losses: 0 } });
  expect(await db.multichatStudio.findOne({ studioKey: token })).toMatchObject({ goals: [{ label: "Keep me" }], broll: { clips: [{ id: "keep" }] }, streamSeries: { revision: 1 } });
  expect(events[0]).toMatchObject({ room: `overlay:${token}`, event: "overlay:series", payload: result });
  expect(JSON.stringify(result)).not.toMatch(/S2|receipt|token|userId/);
});
test("two simultaneous starts cannot erase one another through a stale revision", async () => {
  await studio.ensureCanonical(token);
  const original = studio.ensureCanonical.bind(studio), barrier = deferred(); let arrived = 0;
  jest.spyOn(studio, "ensureCanonical").mockImplementation(async value => { const row = await original(value); if (++arrived === 2) barrier.resolve(); await barrier.promise; return row; });
  const results = await Promise.allSettled([svc.act(token, OWNER, startBody()), svc.act(token, OWNER, startBody({ opponentName: "Serral" }))]);
  expect(results.filter(row => row.status === "fulfilled")).toHaveLength(1);
  expect(results.find(row => row.status === "rejected").reason).toMatchObject({ code: "series_changed" });
  expect((await svc.get(token, OWNER)).revision).toBe(1);
});
test("all eligible accepted rows are sorted, deduped and scored; repeats and other owners stay isolated", async () => {
  await svc.act(token, OWNER, startBody({ format: 5 }));
  await svc.act(other, "other-owner", startBody()); clock = NOW;
  const second = game({ gameId: "second", result: "Defeat", startedAt: new Date(START + 700_000).toISOString(), date: new Date(START + 900_000).toISOString(), isLadderGame: false });
  await svc.ingest(OWNER, [second, game()]);
  const result = await svc.get(token, OWNER);
  expect(result).toMatchObject({ revision: 3, gamesPlayed: 2, score: { you: 1, opponent: 1 }, games: [{ result: "win" }, { result: "loss" }] });
  await svc.ingest(OWNER, [game(), second]);
  expect((await svc.get(token, OWNER)).revision).toBe(3);
  expect((await svc.get(other, "other-owner")).score).toEqual({ you: 0, opponent: 0 });
  expect(completed).not.toHaveBeenCalled();
});
test("concurrent ingest and manual correction use fresh state without duplicate scoring", async () => {
  await svc.act(token, OWNER, startBody({ format: 5 })); clock = NOW;
  await Promise.all([svc.ingest(OWNER, [game()]), svc.ingest(OWNER, [game()])]);
  const once = await svc.get(token, OWNER);
  expect(once).toMatchObject({ revision: 2, gamesPlayed: 1, score: { you: 1, opponent: 0 } });
  await expect(svc.act(token, OWNER, { action: "adjust", revision: 1, side: "you", delta: 1 })).rejects.toMatchObject({ status: 409, code: "series_changed" });
  const corrected = await svc.act(token, OWNER, { action: "adjust", revision: 2, side: "opponent", delta: 1 });
  expect(corrected.score).toEqual({ you: 1, opponent: 1 });
});
test("completion is durable and emits one advisory moment; an uncertain repeated ingest cannot post twice", async () => {
  await svc.act(token, OWNER, startBody({ format: 1 })); clock = NOW;
  await Promise.all([svc.ingest(OWNER, [game()]), svc.ingest(OWNER, [game()])]);
  expect((await svc.get(token, OWNER)).status).toBe("complete");
  expect(completed).toHaveBeenCalledTimes(1);
  expect(completed.mock.calls[0][0]).toBe(token);
  expect(JSON.stringify(completed.mock.calls[0][1])).not.toMatch(/receipt|private-replay|S2|userId/);
  await svc.ingest(OWNER, [game({ gameId: "later" })]);
  expect(completed).toHaveBeenCalledTimes(1);
});
test("test-fire/unknown writes are rejected without mutating the current series", async () => {
  const active = await svc.act(token, OWNER, startBody());
  await expect(svc.act(token, OWNER, { action: "test", revision: 1 })).rejects.toMatchObject({ code: "invalid_series_action" });
  await svc.ingest(OWNER, [game({ isTest: true })]);
  expect(await svc.get(token, OWNER)).toEqual(active);
});
test("rotation carries series state and receipts, while the old credential is retired", async () => {
  await svc.act(token, OWNER, startBody({ format: 5 })); clock = NOW;
  await svc.ingest(OWNER, [game()]);
  const before = await svc.get(token, OWNER);
  const rotated = await tokens.rotate(OWNER, token);
  expect(rotated.pending).toBe(false);
  expect(await svc.get(rotated.token, OWNER)).toEqual(before);
  await expect(svc.act(token, OWNER, { action: "end", revision: 2 })).rejects.toMatchObject({ code: "invalid_overlay_token" });
  await svc.ingest(OWNER, [game()]);
  expect((await svc.get(rotated.token, OWNER)).score.you).toBe(1);
});
test.each(["overlay_rotation_pending", "overlay_token_resolve_busy", "invalid_overlay_token"])("a raced %s token cannot suppress another healthy series", async code => {
  const healthy = (await tokens.create(OWNER, "Healthy")).token;
  await svc.act(token, OWNER, startBody()); await svc.act(healthy, OWNER, startBody()); clock = NOW;
  const original = tokens.withWrite.bind(tokens);
  jest.spyOn(tokens, "withWrite").mockImplementation((value, work) => value === token ? Promise.reject(Object.assign(new Error(code), { code })) : original(value, work));
  await svc.ingest(OWNER, [game()]);
  expect((await svc.get(healthy, OWNER)).score.you).toBe(1);
});
test("H2H counts exact owned visible identity only, caches reads and invalidates on lifecycle changes", async () => {
  const row = game();
  await db.games.insertMany([{ ...row, userId: OWNER }, { ...row, gameId: "loss", result: "Defeat", userId: OWNER, opponent: { toonHandle: "2-s2-1-99" } },
    { ...row, gameId: "draw", result: "Tie", userId: OWNER }, { ...row, userId: "other-owner" },
    ...[{ excluded: true }, { _deleted: true }, { _deletionPending: true }, { isResumedFromReplay: true }, { opponent: { displayName: "Clem", toonHandle: "2-S2-1-100" } }].map((patch, i) => ({ ...row, gameId: `excluded-${i}`, userId: OWNER, ...patch }))]);
  const count = jest.spyOn(db.games, "aggregate");
  const first = await svc.act(token, OWNER, startBody());
  expect(first.headToHead).toEqual({ wins: 1, losses: 1, draws: 1, asOf: START });
  await svc.get(token, OWNER); expect(count).toHaveBeenCalledTimes(1);
  await db.games.deleteOne({ userId: OWNER, gameId: "draw" }); svc.invalidateForUser(OWNER);
  expect((await svc.get(token, OWNER)).headToHead.draws).toBe(0); expect(count).toHaveBeenCalledTimes(2);
});
test("a typed name has unknown H2H until a recorded exact toon pins identity", async () => {
  const count = jest.spyOn(db.games, "aggregate");
  expect((await svc.act(token, OWNER, startBody({ opponentToon: null }))).headToHead).toBeNull();
  expect(count).not.toHaveBeenCalled();
  clock = NOW; await svc.ingest(OWNER, [game()]);
  expect((await svc.get(token, OWNER)).headToHead).toMatchObject({ wins: 0, losses: 0 });
});
test("an H2H lookup held across invalidation cannot refill the old cache", async () => {
  const original = db.games.aggregate.bind(db.games), read = deferred(), release = deferred();
  jest.spyOn(db.games, "aggregate").mockImplementation((...args) => {
    const cursor = original(...args); const toArray = cursor.toArray.bind(cursor);
    cursor.toArray = async () => { const rows = await toArray(); read.resolve(); await release.promise; return rows; }; return cursor;
  });
  const pending = svc.headToHead(OWNER, "2-S2-1-99"); await read.promise;
  svc.invalidateForUser(OWNER); release.resolve();
  expect(await pending).toBeNull(); expect(svc.h2h.size).toBe(0);
});
