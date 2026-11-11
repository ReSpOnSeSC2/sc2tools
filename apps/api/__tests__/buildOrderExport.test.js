// @ts-nocheck
"use strict";

const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient, ObjectId } = require("mongodb");
const { gzipSync } = require("zlib");
const { BuildOrderExportService } = require("../src/services/buildOrderExport");
const { GameDetailsService } = require("../src/services/gameDetails");
const { MongoDetailsStore, R2DetailsStore } = require("../src/services/gameDetailsStore");
const { REPLAY_SEARCH_COMMENT } = require("../src/middleware/searchQueryPrivacy");

const pepper = Buffer.alloc(32, 0x22);
const tick = () => new Promise(resolve => setImmediate(resolve));
async function bytes(stream) { let out = ""; for await (const row of stream) out += row; return out; }
const decoded = text => text.trim().split("\n").map(row => JSON.parse(row));
const row = (index = 1) => ({ _id: new ObjectId(index.toString(16).padStart(24, "0")), gameId: `game-${index}`, date: new Date("2026-01-01T00:00:00Z") });
const empty = () => ({ buildLog: [], oppBuildLog: [] });
function finiteGames(rows) {
  const cursors = [];
  return { cursors, find: jest.fn((_match, options) => {
    let maximum = Infinity;
    const cursor = { sort: jest.fn(() => cursor), limit: jest.fn(value => { maximum = value; return cursor; }), batchSize: jest.fn(() => cursor),
      close: jest.fn(async () => {}), toArray: () => { throw Error("unbounded metadata"); },
      async *[Symbol.asyncIterator]() { for (const item of rows.slice(0, maximum)) { options.signal.throwIfAborted(); yield item; } } };
    cursors.push(cursor); return cursor;
  }) };
}
function serviceFor(rows, findMany = async (_owner, ids) => new Map(ids.map(id => [id, empty()]))) {
  const games = finiteGames(rows), users = { findOneAndUpdate: jest.fn(async () => ({ _id: "owned" })) };
  const gameDetails = { findMany: jest.fn(findMany) };
  return { games, users, gameDetails, service: new BuildOrderExportService({ games, users }, { gameDetails, pepper }) };
}

test("strict singleton details preserve both sides, duplicates, exact raw names and unknown supply", async () => {
  const detail = { buildLog: ["[0:01] Worker", "[0:01] Worker", "[12:59] rawProxyName"], oppBuildLog: ["[0:00] Other"], macroBreakdown: { private: true }, apmCurve: "never exported" };
  const { service, games, gameDetails } = serviceFor([row()], async (_owner, ids) => new Map([[ids[0], detail]]));
  const prepared = await service.prepare(service.request("A", { search: "private search" }, "ndjson"), new AbortController().signal);
  const out = decoded(await bytes(prepared.stream));
  expect(out.slice(1, -1)).toEqual([
    { gameId: "game-1", side: "me", time: 1, supply: null, name: "Worker" },
    { gameId: "game-1", side: "me", time: 1, supply: null, name: "Worker" },
    { gameId: "game-1", side: "me", time: 779, supply: null, name: "rawProxyName" },
    { gameId: "game-1", side: "opponent", time: 0, supply: null, name: "Other" },
  ]);
  expect(out.at(-1)).toEqual({ type: "complete", games: 1, events: 4, continuation: null });
  expect(gameDetails.findMany).toHaveBeenCalledWith("A", ["game-1"], expect.objectContaining({ fields: ["buildLog", "oppBuildLog", "buildLogSupply"], strict: true, concurrency: 1, signal: expect.any(AbortSignal) }));
  expect(games.find.mock.calls[0][1]).toMatchObject({ projection: { _id: 1, date: 1, gameId: 1 }, comment: REPLAY_SEARCH_COMMENT });
  expect(games.cursors[0].limit).toHaveBeenCalledWith(2001); expect(games.cursors[0].batchSize).toHaveBeenCalledWith(1);
  expect(games.cursors[0].close).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(out)).not.toMatch(/never exported|macroBreakdown|private search/);
});

test("NDJSON uses only valid owner supply aligned by step, including repeated clock times", async () => {
  const detail = {
    buildLog: Array(8).fill("[0:01] Worker"),
    oppBuildLog: ["[0:01] Opponent worker"],
    buildLogSupply: [0, 13.5, null, -1, 2001, "17", Infinity, 2000],
  };
  const misaligned = { buildLog: ["[0:01] Worker"], oppBuildLog: [], buildLogSupply: [12, 13] };
  const { service } = serviceFor([row(), row(2)], async (_owner, ids) => new Map([[ids[0], ids[0] === "game-1" ? detail : misaligned]]));
  const prepared = await service.prepare(service.request("A", {}, "ndjson"), new AbortController().signal);
  const output = decoded(await bytes(prepared.stream)).slice(1, -1);
  expect(output.map(record => [record.gameId, record.side, record.supply])).toEqual([
    ...[0, 13.5, null, null, null, null, null, 2000].map(supply => ["game-1", "me", supply]),
    ["game-1", "opponent", null],
    ["game-2", "me", null],
  ]);
});

test("CSV has exactly five columns, formula-safe strings, recorded or blank supply and no disguised summary row", async () => {
  const metadata = { ...row(), gameId: "=GAME()" };
  const { service } = serviceFor([metadata], async () => new Map([[metadata.gameId, { buildLog: ['[0:10] =SUM(1,2)', '[0:11]   @bad', '[0:12] Quoted"Name'], oppBuildLog: [], buildLogSupply: [16.5, null, 0] }]]));
  const prepared = await service.prepare(service.request("A", {}, "csv"), new AbortController().signal);
  expect(await bytes(prepared.stream)).toBe('\uFEFFgameId,side,time,supply,name\r\n\'=GAME(),me,10,16.5,"\'=SUM(1,2)"\r\n\'=GAME(),me,11,,\'  @bad\r\n\'=GAME(),me,12,0,"Quoted""Name"\r\n');
});

test.each([
  undefined, { buildLog: [] }, { buildLog: {}, oppBuildLog: [] }, { buildLog: Array(5001).fill("[0:01] Worker"), oppBuildLog: [] },
  ...["[0:60] Worker", "[1:1] Worker", "[0:01] ", "[0:01]", "[0:01] Bad\nName", "[0:01] " + "x".repeat(256), "[999999999999999999999:00] Worker", "[0:01] \ud800"].map(line => ({ buildLog: [line], oppBuildLog: [] })),
])("missing/malformed/oversized logs fail without a completion trailer: %#", async detail => {
  const { service } = serviceFor([row()], async () => new Map(detail === undefined ? [] : [["game-1", detail]]));
  const prepared = await service.prepare(service.request("A", {}, "ndjson"), new AbortController().signal);
  const chunks = [];
  await expect((async () => { for await (const chunk of prepared.stream) chunks.push(chunk); })()).rejects.toMatchObject({ code: "export_unavailable" });
  expect(chunks.join("")).not.toContain('"type":"complete"');
  expect(chunks.join("")).not.toContain('"gameId":"game-1"');
});

test("actually present empty arrays complete with zero events", async () => {
  const { service } = serviceFor([row()]);
  const prepared = await service.prepare(service.request("A", {}, "ndjson"), new AbortController().signal);
  expect(decoded(await bytes(prepared.stream)).at(-1)).toEqual({ type: "complete", games: 1, events: 0, continuation: null });
});

test.each([
  { gameId: "x".repeat(201) }, { gameId: "bad\nprivate" }, { date: "x".repeat(65) }, { date: "bad\nprivate" }, { date: "\ud800" }, { date: {} }, { date: Number.NaN }, { _id: "not-an-object-id" },
])("invalid legacy metadata is closed before details and always closes its cursor: %#", async invalid => {
  const { service, games, gameDetails } = serviceFor([{ ...row(), ...invalid }]);
  await expect(service.prepare(service.request("A", {}, "ndjson"), new AbortController().signal)).rejects.toMatchObject({ code: "export_unavailable" });
  expect(games.cursors[0].close).toHaveBeenCalledTimes(1); expect(gameDetails.findMany).not.toHaveBeenCalled();
});

test("first detail failure aborts four admitted singleton siblings and waits for all actual settlement", async () => {
  const controls = [], signals = []; let allStarted;
  const started = new Promise(resolve => { allStarted = resolve; });
  const { service, gameDetails } = serviceFor(Array.from({ length: 5 }, (_, index) => row(index + 1)), async (_owner, ids, opts) => {
    signals.push(opts.signal);
    return new Promise((resolve, reject) => { controls.push({ resolve: () => resolve(new Map([[ids[0], empty()]])), reject }); if (controls.length === 4) allStarted(); });
  });
  const prepared = await service.prepare(service.request("A", {}, "ndjson"), new AbortController().signal);
  let settled = false; const output = [];
  const work = (async () => { try { for await (const chunk of prepared.stream) output.push(chunk); } catch (error) { return error; } finally { settled = true; } })();
  try {
    await Promise.race([started, work.then(() => { throw Error("stream settled before four actual reads"); })]);
    expect(gameDetails.findMany).toHaveBeenCalledTimes(4);
    controls[1].reject(Error("private provider URL/token")); await tick();
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(settled).toBe(false); expect(gameDetails.findMany).toHaveBeenCalledTimes(4);
    controls[0].resolve(); controls[2].resolve(); await tick(); expect(settled).toBe(false);
    controls[3].resolve();
    expect(await work).toMatchObject({ code: "export_unavailable" });
    expect(output.join("")).not.toMatch(/complete|private provider/);
  } finally { for (const control of controls) control.resolve(); await work; }
});

test("backpressure on a yielded event cannot admit the next detail batch", async () => {
  const { service, gameDetails } = serviceFor(Array.from({ length: 5 }, (_, index) => row(index + 1)), async (_owner, ids) => new Map([[ids[0], { buildLog: ["[0:01] Worker"], oppBuildLog: [] }]]));
  const controller = new AbortController();
  const prepared = await service.prepare(service.request("A", {}, "ndjson"), controller.signal);
  const iterator = prepared.stream[Symbol.asyncIterator]();
  try {
    await iterator.next(); expect(gameDetails.findMany).not.toHaveBeenCalled();
    expect((await iterator.next()).value).toContain('"gameId":"game-1"');
    await tick(); expect(gameDetails.findMany).toHaveBeenCalledTimes(4);
  } finally { controller.abort(); await iterator.return(); }
});

test("four caller reads retain the actual shared R2 two-active and thirty-two-waiter limits", async () => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const releases = [];
  const client = { send: jest.fn((_command, _options) => new Promise(resolve => {
    releases.push(() => resolve({ ETag: '"synthetic"', Body: gzipSync(JSON.stringify(empty())) }));
    if (releases.length === 2) entered();
  })) };
  const store = new R2DetailsStore({ client, bucket: "synthetic-bucket", gameDetailsCollection: {} });
  const details = new GameDetailsService(store);
  const { service } = serviceFor(Array.from({ length: 4 }, (_, index) => row(index + 1)));
  service.gameDetails = details;
  const controller = new AbortController();
  const prepared = await service.prepare(service.request("A", {}, "ndjson"), controller.signal);
  const work = bytes(prepared.stream).then(value => ({ value }), error => ({ error }));
  try {
    await Promise.race([started, work.then(() => { throw Error("actual R2 reads did not start"); })]);
    expect(store.bulkReadCapacitySnapshot()).toEqual({ active: 2, queued: 2, maxActive: 2, maxWaiters: 32 });
    expect(client.send).toHaveBeenCalledTimes(2);
    controller.abort(); releases.forEach(release => release());
    expect(await work).toHaveProperty("error");
    expect(client.send).toHaveBeenCalledTimes(2);
    expect(store.bulkReadCapacitySnapshot()).toEqual({ active: 0, queued: 0, maxActive: 2, maxWaiters: 32 });
  } finally { controller.abort(); releases.forEach(release => release()); await work; }
});

test("an abort during metadata cleanup cannot publish a page or admit any details", async () => {
  const { service, games, gameDetails } = serviceFor([row()]);
  let release, entered; const started = new Promise(resolve => { entered = resolve; });
  const original = games.find;
  games.find = jest.fn((...args) => { const cursor = original(...args); cursor.close = jest.fn(() => { entered(); return new Promise(resolve => { release = resolve; }); }); return cursor; });
  const controller = new AbortController();
  let settled = false;
  const work = service.prepare(service.request("A", {}, "ndjson"), controller.signal).then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
  try {
    await Promise.race([started, work.then(() => { throw Error("metadata did not enter held cleanup"); })]);
    controller.abort(); await tick(); expect(settled).toBe(false); expect(gameDetails.findMany).not.toHaveBeenCalled();
    release(); expect(await work).toHaveProperty("error");
  } finally { controller.abort(); release?.(); await work; }
});

describe("owned keyset metadata and real detail-store integration", () => {
  let mongo, client, db;
  beforeAll(async () => { mongo = await MongoMemoryServer.create(); client = await MongoClient.connect(mongo.getUri()); db = client.db("build-export"); await db.collection("games").createIndex({ userId: 1, date: -1, _id: -1 }); });
  afterAll(async () => { await client?.close(); await mongo?.stop(); });

  test("hard 2000-game page plus sentinel and typed continuation cover owned visible games exactly once", async () => {
    const games = db.collection("games"), users = db.collection("users"); await users.insertOne({ userId: "paged" });
    const own = Array.from({ length: 1999 }, (_, index) => ({ ...row(index + 1), userId: "paged" }));
    own.push(...["2026-01-01", "2025-01-01", 1234, null].map((date, index) => ({ ...row(2000 + index), date, userId: "paged" })));
    await games.insertMany([...own, ...[
      { userId: "foreign" }, { userId: "paged", excluded: true }, { userId: "paged", _deleted: true },
      { userId: "paged", _deletionPending: true }, { userId: "paged", isResumedFromReplay: true },
    ].map((fields, index) => ({ ...row(3000 + index), ...fields }))]);
    const requested = [];
    const details = { findMany: jest.fn(async (owner, ids, opts) => { requested.push([owner, ...ids]); expect(opts).toMatchObject({ strict: true, concurrency: 1, fields: ["buildLog", "oppBuildLog", "buildLogSupply"] }); return new Map([[ids[0], { buildLog: ["[0:01] Worker"], oppBuildLog: [] }]]); }) };
    const service = new BuildOrderExportService({ games, users }, { gameDetails: details, pepper });
    const first = await service.prepare(service.request("paged", {}, "ndjson"), new AbortController().signal);
    expect(first.games).toBe(2000); expect(first.hasMore).toBe(true); expect(details.findMany).not.toHaveBeenCalled();
    const firstRows = decoded(await bytes(first.stream));
    expect(firstRows.at(-1)).toMatchObject({ games: 2000, events: 2000, continuation: first.continuation });
    expect(requested).toHaveLength(2000); expect(requested.every(([owner]) => owner === "paged")).toBe(true);
    const second = await service.prepare(service.request("paged", { continuation_token: first.continuation }, "ndjson"), new AbortController().signal);
    const secondRows = decoded(await bytes(second.stream));
    expect(second.games).toBe(3); expect(second.continuation).toBeNull();
    const ids = [...firstRows, ...secondRows].filter(item => item.gameId).map(item => item.gameId);
    expect(ids).toHaveLength(2003); expect(new Set(ids)).toEqual(new Set(own.map(item => item.gameId)));
    expect(requested).toHaveLength(2003);
    expect((await users.findOne({ userId: "paged" })).buildOrderExportQuota.t).toHaveLength(2);
  });

  test("real MongoDetailsStore honors ownership, field projection, and missing/deleted detail truth", async () => {
    const games = db.collection("games"), users = db.collection("users"), gameDetails = db.collection("gameDetails");
    await users.insertOne({ userId: "detail-owner" }); await games.insertOne({ ...row(5000), userId: "detail-owner" });
    await gameDetails.insertMany([
      { userId: "detail-owner", gameId: "game-5000", buildLog: ["[1:02] Marine"], oppBuildLog: [], buildLogSupply: [22.5], macroBreakdown: { secret: "private detail" } },
      { userId: "foreign", gameId: "game-5000", buildLog: ["[0:01] Foreign secret"], oppBuildLog: [], buildLogSupply: [999] },
    ]);
    const details = new GameDetailsService(new MongoDetailsStore({ gameDetails }));
    const service = new BuildOrderExportService({ games, users }, { gameDetails: details, pepper });
    const first = await service.prepare(service.request("detail-owner", {}, "ndjson"), new AbortController().signal);
    const output = await bytes(first.stream);
    expect(decoded(output)[1]).toEqual({ gameId: "game-5000", side: "me", time: 62, supply: 22.5, name: "Marine" });
    expect(output).not.toMatch(/private detail|Foreign secret|macroBreakdown/);
    const deletedDetails = new GameDetailsService(new MongoDetailsStore({ gameDetails }), { deletedGameIds: async () => new Set(["game-5000"]) });
    const deletedService = new BuildOrderExportService({ games, users }, { gameDetails: deletedDetails, pepper });
    const second = await deletedService.prepare(deletedService.request("detail-owner", {}, "ndjson"), new AbortController().signal);
    await expect(bytes(second.stream)).rejects.toMatchObject({ code: "export_unavailable" });
  });
});
