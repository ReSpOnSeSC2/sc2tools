"use strict";
const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");
const { GameMomentsService } = require("../src/services/gameMoments");
const { NotificationsService } = require("../src/services/notifications");
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
beforeAll(async () => {
  mongo = await MongoMemoryServer.create(); client = await MongoClient.connect(mongo.getUri()); db = client.db("moment_alerts_test");
  await db.collection("notifications").createIndex({ userId: 1, deliveryKeys: 1 },
    { unique: true, partialFilterExpression: { deliveryKeys: { $type: "array" } } });
});
afterAll(async () => { await client?.close(); await mongo?.stop(); });
beforeEach(async () => { await Promise.all(["games", "users", "clips", "notifications"].map(name => db.collection(name).deleteMany({}))); await db.collection("users").insertOne({ userId: OWNER }); });
afterEach(() => jest.restoreAllMocks());

/** @param {boolean} [bell] */
function fixture(bell = false) {
  /** @type {Array<{room:string,event:string,payload:any}>} */ const events = [];
  /** @type {unknown[][]} */ const posts = [];
  const gate = new OverlayTokenWrites(async token => ["one", "two"].includes(token) ? { userId: OWNER } : null);
  let config = sanitizeGameMomentAlerts({ moments: { marathonWin: { enabled: true } } });
  const notifications = new NotificationsService(/** @type {import('../src/db/connect').DbContext} */ (/** @type {unknown} */ ({ users: db.collection("users"), notifications: db.collection("notifications") })));
  const deps = { now: () => NOW, notifications: bell ? notifications : undefined,
    users: { getPreferences: jest.fn(async (userId = OWNER, type = "multichat") => type === "multichat"
      ? { alerts: { gameMoments: config } }
      : (await db.collection("users").findOne({ userId }))?.preferences?.notifications) },
    tokens: { withWrite: (/** @type {string} */ token, /** @type {()=>Promise<any>} */ work) => gate.run(token, work) },
    channels: { forGame: jest.fn(async () => ({})) }, seasons: { cachedCurrent: () => ({ battlenetId: 70, start: "2026-10-01" }) },
    engagement: { _recordMomentAdmitted: jest.fn(async (token, moment) => { await db.collection("clips").insertOne({ token, ...moment }); }) },
    bot: { queueGameMoments: jest.fn((...args) => { posts.push(args); return true; }) },
    io: { to: (/** @type {string} */ room) => ({ emit: (/** @type {string} */ event, /** @type {unknown} */ payload) => events.push({ room, event, payload }) }) },
  };
  const service = new GameMomentsService({ games: db.collection("games"), users: db.collection("users") }, /** @type {any} */ (deps));
  return { service, deps, gate, events, posts, notifications, configure: (/** @type {unknown} */ raw) => { config = sanitizeGameMomentAlerts(raw); } };
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

describe("private milestone sink", () => {
  async function optIn(muted = /** @type {string[]} */ ([])) {
    await db.collection("users").updateOne({ userId: OWNER }, { $set: { "preferences.notifications": { milestones: true, muted } } });
  }

  test("a fresh tokenless insert reaches the private bell exactly once across independent workers", async () => {
    const current = game();
    await db.collection("games").insertOne(current);
    await optIn();
    const a = fixture(true), b = fixture(true);
    const fanout = (/** @type {GameMomentsService} */ service) => emitOverlayLive(undefined, undefined, undefined, OWNER, current, null, null, service);
    await Promise.all([fanout(a.service), fanout(b.service)]);
    await fanout(fixture(true).service);
    expect(await db.collection("notifications").find({}).toArray()).toEqual([
      expect.objectContaining({ userId: OWNER, kind: "moment.marathon_win", title: "Marathon win", href: "/app/game/current", count: 1, deliveryKeys: expect.any(Array) }),
    ]);
    expect((await db.collection("games").findOne({ gameId: "current" }))?._gameMoments).toMatchObject({ version: 1, kinds: ["marathonWin"] });
    expect(a.events.concat(b.events)).toEqual([]);
  });

  test("a tokenless default-off player has no history scan and a muted milestone has no bell row", async () => {
    await db.collection("games").insertOne(game());
    const value = fixture(true);
    const read = jest.spyOn(value.service.db.games, "find");
    await value.service.process(OWNER, game(), null, [], { created: true });
    expect(read).not.toHaveBeenCalled();
    expect((await db.collection("games").findOne({}))?._gameMoments).toBeUndefined();
    await optIn(["moment.marathon_win"]);
    await value.service.process(OWNER, game(), null, [], { created: true });
    expect((await db.collection("games").findOne({}))?._gameMoments.kinds).toEqual(["marathonWin"]);
    expect(await db.collection("notifications").countDocuments()).toBe(0);
    await optIn();
    await value.service.process(OWNER, game(), null, [], { created: true });
    expect(await db.collection("notifications").countDocuments()).toBe(0);
  });

  test.each([
    ["Victory", "moment.win_streak"],
    ["Defeat", "moment.loss_streak_broken"],
  ])("recorded %s history supplies the matching personal streak milestone", async (result, kind) => {
    const current = game({ durationSec: 600 });
    const history = Array.from({ length: 4 }, (_, i) => game({
      gameId: `prior-${i}`, date: new Date(NOW - (i + 1) * 60 * 60_000), result,
      opponent: { pulseCharacterId: "81" },
    }));
    await db.collection("games").insertMany([current, ...history]);
    await optIn();
    await fixture(true).service.process(OWNER, current, null, [], { created: true });
    expect(await db.collection("notifications").find({}).toArray()).toEqual([expect.objectContaining({ kind })]);
  });

  test("one scan feeds independent stream filters and private bell rows for opt-in Web Push", async () => {
    const opponent = { pulseCharacterId: "77", mmr: 4422, mmrSource: "replay" };
    const current = game({ opponent });
    await db.collection("games").insertMany([current, game({
      gameId: "prior", date: new Date(NOW - 30 * 60_000), result: "Defeat", myMmr: 3890,
      _gameMoments: { rank: { source: "pulse", league: "Diamond", season: 70, context: "1-S2-1-42:P" } },
    })]);
    await optIn();
    const value = fixture(true);
    value.configure({ moments: { leagueChange: { enabled: true }, giantKiller: { enabled: true }, streamerOpponentWin: { enabled: true }, marathonWin: { enabled: true } } });
    value.deps.channels.forGame.mockResolvedValue(/** @type {Record<string,unknown>} */ ({ twitch: { login: "synthetic-channel" } }));
    const push = jest.fn(async (/** @type {string} */ _owner = "", /** @type {{kind: string}} */ _row = { kind: "" }) => {});
    value.notifications.push = { deliver: push };
    const read = jest.spyOn(value.service.db.games, "find");
    await run(value.service, current, { rank: { source: "pulse", league: "Master" } });
    expect(read).toHaveBeenCalledTimes(1);
    expect(value.events.filter(event => event.room === "overlay:one").map(event => event.payload.kind))
      .toEqual(["leagueChange", "giantKiller", "marathonWin", "streamerOpponentWin"]);
    const bell = await db.collection("notifications").find({}).toArray();
    expect(bell.map(row => row.kind).sort()).toEqual([
      "moment.crossed_mmr_mark", "moment.giant_killer", "moment.marathon_win", "moment.new_season_peak", "moment.revenge_win",
    ]);
    expect(bell.find(row => row.kind === "moment.giant_killer")?.body).toBe("Opponent started about 400 MMR higher.");
    expect(value.events.find(event => event.payload.kind === "giantKiller")?.payload.detail).toBe("Opponent started about 400 MMR higher.");
    expect(push.mock.calls.map(([owner, row]) => [owner, row?.kind]).sort()).toEqual(bell.map(row => [OWNER, row.kind]).sort());
  });

  test("a personal receipt stays independent when every stream token is rotating", async () => {
    await db.collection("games").insertOne(game());
    await optIn();
    const value = fixture(true);
    value.gate.block("one");
    value.gate.block("two");
    await run(value.service);
    expect(value.events).toEqual([]);
    expect(await db.collection("clips").countDocuments()).toBe(0);
    expect(await db.collection("notifications").countDocuments({ userId: OWNER, kind: "moment.marathon_win" })).toBe(1);
  });

  test.each(["multichat", "notifications"])("a failed %s settings read leaves the other sink live", async type => {
    await db.collection("games").insertOne(game());
    await optIn();
    const value = fixture(true);
    const read = value.deps.users.getPreferences.getMockImplementation();
    value.deps.users.getPreferences.mockImplementation(async (userId, preference) => {
      if (preference === type) throw new Error("settings read interrupted");
      return read?.(userId, preference);
    });
    await run(value.service);
    expect(value.events).toHaveLength(type === "multichat" ? 0 : 2);
    expect(await db.collection("notifications").countDocuments({ userId: OWNER })).toBe(1);
  });

  test("a failed bell write survives restart and concurrent reuploads finish it without repeating the overlay", async () => {
    await db.collection("games").insertOne(game());
    await optIn();
    const initial = fixture(true);
    const failedInsert = jest.spyOn(initial.notifications.db.notifications, "insertOne")
      .mockRejectedValue(new Error("write interrupted"));
    await run(initial.service);
    expect(failedInsert).toHaveBeenCalledTimes(2);
    expect(initial.events).toHaveLength(2);
    expect(await db.collection("notifications").countDocuments()).toBe(0);
    expect((await db.collection("games").findOne({ gameId: "current" }))?._gameMoments.pendingBell)
      .toEqual([expect.objectContaining({ kind: "marathonWin" })]);

    const restarted = [fixture(true), fixture(true)];
    const scans = restarted.map(value => jest.spyOn(value.service.db.games, "find"));
    // Both workers must reach the insert after the delivery-key precheck.
    let reachedInsert = 0;
    /** @type {()=>void} */ let release = () => {};
    const bothWriting = new Promise(resolve => { release = () => resolve(undefined); });
    for (const value of restarted) {
      const collection = value.notifications.db.notifications;
      const insert = collection.insertOne.bind(collection);
      jest.spyOn(collection, "insertOne").mockImplementation(async (...args) => {
        if (++reachedInsert === 2) release();
        await bothWriting;
        return insert(...args);
      });
    }
    await Promise.all(restarted.map(value => value.service.process(OWNER, game(), { gameKey: "already-played" }, ["one"], { created: false })));
    expect(reachedInsert).toBe(2);
    expect(await db.collection("notifications").countDocuments({ userId: OWNER })).toBe(1);
    expect(await db.collection("clips").countDocuments()).toBe(2);
    expect(restarted.flatMap(value => value.events)).toEqual([]);
    const pendingOnly = expect.objectContaining({ userId: OWNER, gameId: "current", "_gameMoments.pendingBell": { $exists: true } });
    for (const scan of scans) expect(scan.mock.calls.map(([filter]) => filter)).toEqual([pendingOnly, pendingOnly]);
    expect((await db.collection("games").findOne({ gameId: "current" }))?._gameMoments.pendingBell).toBeUndefined();
  });

  test("a visibility change before the retry lease prevents a pending bell write", async () => {
    await db.collection("games").insertOne(game({ _gameMoments: { version: 1, claimedAt: new Date(NOW),
      kinds: ["marathonWin"], pendingBell: [{ kind: "marathonWin", headline: "Marathon win", detail: "Victory after 25 minutes." }],
    } }));
    await optIn();
    const value = fixture(true);
    const collection = value.service.db.games;
    const find = collection.findOne.bind(collection);
    jest.spyOn(collection, "findOne").mockImplementationOnce(async () => {
      const row = await find({ userId: OWNER, gameId: "current" });
      await collection.updateOne({ userId: OWNER, gameId: "current" }, { $set: { excluded: true } });
      return row;
    });
    await value.service.process(OWNER, game(), null, [], { created: false });
    expect(await db.collection("notifications").countDocuments()).toBe(0);
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
