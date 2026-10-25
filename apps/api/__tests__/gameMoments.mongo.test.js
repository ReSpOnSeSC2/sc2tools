"use strict";
const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");
const { GameMomentsService } = require("../src/services/gameMoments");
const { OverlayTokenWrites } = require("../src/services/overlayTokenWrites");
const { sanitizeGameMomentAlerts } = require("../src/services/multichatAppearance");
const { emitOverlayLive } = require("../src/routes/games");
const NOW = Date.parse("2026-10-25T12:00Z"), OWNER = "synthetic-owner";
const game = (/** @type {Record<string,any>} */ patch = {}) => ({ userId: OWNER, gameId: "current", date: new Date(NOW), playerCount: 2,
  isLadderGame: true, result: "Victory", myToonHandle: "1-S2-1-42", myRace: "Protoss", myMmr: 4001, myMmrSource: "replay",
  durationSec: 1500, opponent: { pulseCharacterId: "77", mmr: 4100, mmrSource: "replay" }, ...patch });
/** @type {MongoMemoryServer} */ let mongo;
/** @type {MongoClient} */ let client;
/** @type {import('mongodb').Db} */ let db;
beforeAll(async () => { mongo = await MongoMemoryServer.create(); client = await MongoClient.connect(mongo.getUri()); db = client.db("moment_alerts_test"); });
afterAll(async () => { await client?.close(); await mongo?.stop(); });
beforeEach(async () => { await Promise.all(["games", "users", "clips"].map(name => db.collection(name).deleteMany({}))); await db.collection("users").insertOne({ userId: OWNER }); });
afterEach(() => jest.restoreAllMocks());

function fixture() {
  /** @type {Array<{room:string,event:string,payload:any}>} */ const events = [];
  /** @type {unknown[][]} */ const posts = [];
  const gate = new OverlayTokenWrites(async token => ["one", "two"].includes(token) ? { userId: OWNER } : null);
  let config = sanitizeGameMomentAlerts({ moments: { marathonWin: { enabled: true } } });
  const deps = { now: () => NOW,
    users: { getPreferences: jest.fn(async () => ({ alerts: { gameMoments: config } })) },
    tokens: { withWrite: (/** @type {string} */ token, /** @type {()=>Promise<any>} */ work) => gate.run(token, work) },
    channels: { forGame: jest.fn(async () => ({})) }, seasons: { cachedCurrent: () => ({ battlenetId: 70, start: "2026-10-01" }) },
    engagement: { _recordMomentAdmitted: jest.fn(async (token, moment) => { await db.collection("clips").insertOne({ token, ...moment }); }) },
    bot: { queueGameMoments: jest.fn((...args) => { posts.push(args); return true; }) },
    io: { to: (/** @type {string} */ room) => ({ emit: (/** @type {string} */ event, /** @type {unknown} */ payload) => events.push({ room, event, payload }) }) },
  };
  const service = new GameMomentsService({ games: db.collection("games"), users: db.collection("users") }, /** @type {any} */ (deps));
  return { service, deps, gate, events, posts, configure: (/** @type {unknown} */ raw) => { config = sanitizeGameMomentAlerts(raw); } };
}
const run = (/** @type {GameMomentsService} */ service, /** @type {Record<string,any>} */ input = game(), payload = {}) => service.process(OWNER, input, { gameKey: "live-key", ...payload }, ["one", "two"], { created: true });

describe("durable owner/game moment processing", () => {
  test("concurrent ingestion and a restarted/reprocessed caller emit and log each kind once per token", async () => {
    await db.collection("games").insertOne(game()); const value = fixture();
    await Promise.all([run(value.service), run(value.service)]);
    expect(value.events).toHaveLength(2); expect(await db.collection("clips").countDocuments()).toBe(2); expect(value.posts).toEqual([]);
    expect((await db.collection("games").findOne({ gameId: "current" }))?._gameMoments.kinds).toEqual(["marathonWin"]);
    const restarted = fixture(); await run(restarted.service); expect(restarted.events).toEqual([]);
    await db.collection("games").updateOne({ gameId: "current" }, { $set: { durationSec: 2000 } });
    await run(restarted.service); expect(await db.collection("clips").countDocuments()).toBe(2);
    expect((await db.collection("users").findOne({ userId: OWNER }))?._dataMutations).toEqual([]);
  });
  test("legacy updates, historical imports and future dates do not read settings or claim a receipt", async () => {
    await db.collection("games").insertOne(game()); const { service, deps } = fixture();
    expect(await service.process(OWNER, game(), {}, ["one"], { created: false })).toEqual([]);
    expect(await run(service, game({ date: new Date(NOW - 16 * 60_000) }))).toEqual([]);
    expect(await run(service, game({ date: new Date(NOW + 60_000) }))).toEqual([]);
    expect(deps.users.getPreferences).not.toHaveBeenCalled(); expect((await db.collection("games").findOne({}))?._gameMoments).toBeUndefined();
  });
  test("default-off settings skip the history scan and owner mutation lease", async () => {
    await db.collection("games").insertOne(game()); const value = fixture(); value.configure({});
    const read = jest.spyOn(value.service.db.games, "find");
    expect(await run(value.service)).toEqual([]); expect(read).not.toHaveBeenCalled();
    expect((await db.collection("users").findOne({ userId: OWNER }))?._dataMutations).toBeUndefined();
  });
  test("uses the stored canonical source rather than an optimistic request copy", async () => {
    await db.collection("games").insertOne(game({ result: "Defeat" })); const value = fixture();
    expect(await run(value.service, game({ result: "Victory" }))).toEqual([]); expect(value.events).toEqual([]);
  });
  test.each([{ excluded: true }, { _deleted: true }, { _deletionPending: true }, { isResumedFromReplay: true }, { playerCount: 4 }])("noncontributing stored rows cannot emit: %j", async patch => {
    await db.collection("games").insertMany([game(patch), game({ userId: "foreign" })]); const value = fixture();
    expect(await run(value.service)).toEqual([]); expect(value.events).toEqual([]); expect(await db.collection("clips").countDocuments()).toBe(0);
  });
});

describe("moment admission and real fanout boundaries", () => {
  test("an exclusive owner mutation prevents a moment claim and releases no lock", async () => {
    await db.collection("games").insertOne(game()); await db.collection("users").updateOne({ userId: OWNER }, { $set: { _gdprMutation: { id: "exclusive" } } });
    const value = fixture(); await expect(run(value.service)).rejects.toMatchObject({ code: "gdpr_operation_busy" });
    expect((await db.collection("games").findOne({}))?._gameMoments).toBeUndefined(); expect(value.events).toEqual([]);
    expect((await db.collection("users").findOne({ userId: OWNER }))?._gdprMutation.id).toBe("exclusive");
  });
  test("a blocked first token cannot suppress healthy token delivery", async () => {
    await db.collection("games").insertOne(game()); const value = fixture(); value.gate.block("one");
    await run(value.service); expect(value.events.map(event => event.room)).toEqual(["overlay:two"]);
    expect(await db.collection("clips").countDocuments({ token: "one" })).toBe(0);
  });
  test("rotation waits for an admitted moment without reopening nested token admission", async () => {
    await db.collection("games").insertOne(game()); const value = fixture();
    let release = () => {}, entered = () => {}; const hold = new Promise(resolve => { release = () => resolve(undefined); }); const started = new Promise(resolve => { entered = () => resolve(undefined); });
    const original = value.deps.engagement._recordMomentAdmitted;
    value.deps.engagement._recordMomentAdmitted = jest.fn(async (...args) => { if (args[0] === "one") { entered(); await hold; } return original(...args); });
    const work = run(value.service); await started; value.gate.block("one");
    expect(await value.gate.drain("one", 1)).toBe(false); release(); await work;
    expect(await value.gate.drain("one")).toBe(true); expect(value.events).toHaveLength(2);
  });
  test("a held lookup cannot claim an optimistic source after a newer replay correction", async () => {
    await db.collection("games").insertOne(game({ _customBuildRevision: "old" })); const value = fixture();
    value.configure({ moments: { marathonWin: { enabled: true }, streamerOpponentWin: { enabled: true } } });
    let release = () => {}, entered = () => {}; const hold = new Promise(resolve => { release = () => resolve(undefined); }); const started = new Promise(resolve => { entered = () => resolve(undefined); });
    value.deps.channels.forGame.mockImplementation(async () => { entered(); await hold; return {}; });
    const work = run(value.service); await started;
    await db.collection("games").updateOne({ gameId: "current" }, { $set: { durationSec: 600, _customBuildRevision: "corrected" } });
    release(); expect(await work).toEqual([]); expect(value.events).toEqual([]); expect((await db.collection("games").findOne({}))?._gameMoments).toBeUndefined();
  });
  test("the real overlay fanout invokes moments after live emission and does not block verified settlement on a moment failure", async () => {
    /** @type {Array<{room:string,event:string,payload:any}>} */ const events = [];
    const io = { to: (/** @type {string} */ room) => ({ emit: (/** @type {string} */ event, /** @type {unknown} */ payload) => events.push({ room, event, payload }) }) };
    const moments = { process: jest.fn(async () => { expect(events[0].event).toBe("overlay:live"); throw new Error("optional failure"); }) };
    const engagement = { settlePrediction: jest.fn(async () => {}), recordMoment: jest.fn(async () => {}) };
    await emitOverlayLive(/** @type {any} */ (io), /** @type {any} */ ({ buildFromGame: async () => ({ result: "win" }) }), /** @type {any} */ ({ list: async () => [{ token: "one" }, { token: "old", revokedAt: new Date() }, { token: "rotating", rotationPending: true }] }), OWNER, game(), null, /** @type {any} */ (engagement), /** @type {any} */ (moments));
    expect(moments.process).toHaveBeenCalledWith(OWNER, expect.objectContaining({ gameId: "current" }), expect.anything(), ["one"], { created: true });
    expect(engagement.settlePrediction).toHaveBeenCalledWith(["one"], expect.objectContaining({ result: "win" }));
  });
});
