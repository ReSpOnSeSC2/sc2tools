// @ts-nocheck
"use strict";

// Atlas Flex caps an in-memory sort at 32 MB and does not support
// allowDiskUse. Production's ~64k games need ~225 MB for the reference
// dedupe sort. This suite scales the caps down so a small fixture overflows
// them the same way, then checks the Global Trends snapshot still builds,
// keeps exactly the reference rows, and never asks for disk use.

const { MongoMemoryServer } = require("mongodb-memory-server");
const { ObjectId, BSON } = require("mongodb");
const { connect } = require("../src/db/connect");
const { globalHistoryStages } = require("../src/services/adminGlobalTrendsScope");
const { AdminGlobalTrendsService } = require("../src/services/adminGlobalTrends");
const {
  GlobalTrendsHistory, HISTORY_COLLECTION, DEDUPE_PASSES, duplicateRowsPipeline,
} = require("../src/services/adminGlobalTrendsHistory");

const CAP_BYTES = 256 * 1024;
const P = "1-S2-1-900";
const MEMORY_LIMIT_NO_DISK_USE = "QueryExceededMemoryLimitNoDiskUseAllowed";

let nextId = 0;
/** Ascending ObjectIds, so the _id tie-break is predictable. */
const oid = () => new ObjectId((++nextId).toString(16).padStart(24, "0"));

/** An eligible ranked game; an override of `undefined` removes the field. */
function game(overrides = {}) {
  const n = nextId + 1;
  const doc = {
    _id: oid(), userId: "u-bulk", gameId: `bulk-${n}`, myToonHandle: `2-S2-1-${n % 4}`,
    myRace: "Protoss", myLadderRace: "Protoss", date: new Date(Date.UTC(2026, 8, 1 + (n % 10), 12, n % 60)),
    myMmr: 4000 + (n % 300), myMmrSource: "replay", isLadderGame: true, playerCount: 2, matchFormat: "1v1",
    result: n % 2 ? "Victory" : "Defeat", durationSec: 600 + n, map: "Test Arena", myBuild: "Protoss opener",
    macroScore: 70, apm: 150, spq: 10, top3Leaks: [{ name: "Supply" }, { name: "Idle" }],
    replayFile: { sha256: n.toString(16).padStart(64, "0") },
    opponent: { race: "Zerg", mmr: 4100, strategy: "Roach", displayName: "Opponent", pulseId: "9", toonHandle: "1-S2-1-999", region: "NA" },
    ...overrides,
  };
  for (const [field, value] of Object.entries(doc)) if (value === undefined) delete doc[field];
  return doc;
}

const at = (minute) => new Date(Date.UTC(2026, 8, 20, 10, minute));
const sha = (c) => c.repeat(64);

/** Named edge cases; `keep` is what the reference dedupe retains. */
function edgeCases() {
  const rows = [
    // Replay-id duplicates of one player across accounts: trust ranks first.
    ["trust-untrusted", false, { userId: "u1", myToonHandle: P, gameId: "dup-trust", myMmrSource: "unavailable", updatedAt: at(9) }],
    ["trust-trusted", true, { userId: "u2", myToonHandle: P, gameId: "dup-trust", updatedAt: at(1) }],
    // Then the newest updatedAt; null and missing rank below any date.
    ["updated-date", true, { userId: "u1", myToonHandle: P, gameId: "dup-updated", updatedAt: at(5) }],
    ["updated-missing", false, { userId: "u2", myToonHandle: P, gameId: "dup-updated" }],
    ["updated-null", false, { userId: "u3", myToonHandle: P, gameId: "dup-updated", updatedAt: null }],
    // null and missing tie, as in $sort: the smaller source _id wins.
    ["tie-null", true, { userId: "u1", myToonHandle: P, gameId: "dup-tie", updatedAt: null }],
    ["tie-missing", false, { userId: "u2", myToonHandle: P, gameId: "dup-tie" }],
    // A renamed replay (same file, new gameId): the file pass keeps the newest.
    ["renamed-old", false, { userId: "u1", myToonHandle: P, gameId: "ren-a", replayFile: { sha256: sha("a") }, updatedAt: at(1) }],
    ["renamed-new", true, { userId: "u2", myToonHandle: P, gameId: "ren-b", replayFile: { sha256: sha("a") }, updatedAt: at(2) }],
    // The file pass ranges over replay-id survivors only: "dep-y" would beat
    // "dep-z" on file b, but it already lost replay "dep" to "dep-x".
    ["dep-x", true, { userId: "u1", myToonHandle: P, gameId: "dep", replayFile: { sha256: sha("c") }, updatedAt: at(3) }],
    ["dep-y", false, { userId: "u2", myToonHandle: P, gameId: "dep", replayFile: { sha256: sha("b") }, updatedAt: at(2) }],
    ["dep-z", true, { userId: "u3", myToonHandle: P, gameId: "dep-z", replayFile: { sha256: sha("b") }, updatedAt: at(1) }],
    // Blank hashes fall back to the replay id; whitespace-only counts as blank.
    ["blank-hash-a", true, { userId: "u1", myToonHandle: P, gameId: "blank", replayFile: { sha256: "  " }, updatedAt: at(4) }],
    ["blank-hash-b", false, { userId: "u2", myToonHandle: P, gameId: "blank", replayFile: {}, updatedAt: at(3) }],
    // No gameId: the source _id is the replay id, so both stay.
    ["no-game-id-a", true, { userId: "u1", myToonHandle: P, gameId: undefined, replayFile: {} }],
    ["no-game-id-b", true, { userId: "u2", myToonHandle: P, gameId: undefined, replayFile: {} }],
    // A padded toon handle is the same player.
    ["padded-toon", false, { userId: "u4", myToonHandle: ` ${P} `, gameId: "dup-trust", myMmrSource: "unavailable" }],
    // Without a toon handle (missing or blank), history stays scoped to the
    // uploader: one account's renamed copy collapses, another account's stays.
    ["legacy-u3-a", true, { userId: "u3", myToonHandle: undefined, gameId: "legacy-a", replayFile: { sha256: sha("d") }, updatedAt: at(2) }],
    ["legacy-u3-b", false, { userId: "u3", myToonHandle: "", gameId: "legacy-b", replayFile: { sha256: sha("d") }, updatedAt: at(1) }],
    ["legacy-u4", true, { userId: "u4", myToonHandle: undefined, gameId: "legacy-c", replayFile: { sha256: sha("d") } }],
    // Opposing perspectives of one replay are two observations.
    ["opponent-view", true, { userId: "u9", myToonHandle: "1-S2-1-999", gameId: "dup-trust" }],
    ["numeric-toon", true, { userId: "u5", myToonHandle: 12345, gameId: "numeric" }],
    // Never eligible.
    ["deleted", false, { _deleted: true }], ["pending", false, { _deletionPending: true }],
    ["excluded", false, { excluded: true }], ["resumed", false, { isResumedFromReplay: true }],
    ["string-date", false, { date: "2026-09-01" }],
  ];
  return rows.map(([label, keep, overrides]) => ({ label, keep, doc: game(overrides) }));
}

/** A stored snapshot row, compared field for field with a reference row. */
function asReference(row) {
  const copy = { ...row, _id: row._globalSourceId };
  for (const field of ["_globalSnapshotId", "_globalExpiresAt", "_globalSourceId", "_globalReplayKey", "_globalFileKey"]) delete copy[field];
  return BSON.EJSON.stringify(copy, { relaxed: false });
}

/** Flex-like limits on this test server: capped sort and $group, no spilling. */
function flexCaps(db, bytes) {
  return db.db.admin().command({
    setParameter: 1, allowDiskUseByDefault: false,
    internalQueryMaxBlockingSortMemoryUsageBytes: bytes, internalDocumentSourceGroupMaxMemoryBytes: bytes,
  });
}

describe("Global Trends on Atlas Flex limits", () => {
  let mongo;
  let db;
  let cases;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "global_trends_flex" });
    // Production's materialization target has the simple default collation.
    await db.db.createCollection(HISTORY_COLLECTION);
    cases = edgeCases();
    await db.games.insertMany([...cases.map((c) => c.doc), ...Array.from({ length: 1500 }, () => game())]);
    await flexCaps(db, CAP_BYTES);
  });
  afterAll(async () => { await db?.close(); await mongo?.stop(); });
  afterEach(() => jest.restoreAllMocks());

  test("the fixture overflows the scaled caps the way production overflows 32 MB", async () => {
    await expect(db.games.aggregate(globalHistoryStages()).toArray())
      .rejects.toMatchObject({ codeName: MEMORY_LIMIT_NO_DISK_USE });
  });

  test("the snapshot builds within the caps, keeps exactly the reference rows, and never asks for disk use", async () => {
    const gamesRead = jest.spyOn(db.games, "aggregate");
    const history = new GlobalTrendsHistory(db, (work) => work());
    const historyRead = jest.spyOn(history.collection, "aggregate");
    const snapshotId = await history.withSnapshot(async (snapshot) => snapshot.id);
    for (const [, options] of [...gamesRead.mock.calls, ...historyRead.mock.calls]) expect(options).not.toHaveProperty("allowDiskUse");

    // The reference, explicitly allowed to spill, is the definition of correct.
    const reference = await db.games.aggregate(globalHistoryStages(), { allowDiskUse: true }).toArray();
    const built = await history.collection.find({ _globalSnapshotId: snapshotId }).toArray();
    expect(built.map(asReference).sort()).toEqual(reference.map((row) => BSON.EJSON.stringify(row, { relaxed: false })).sort());

    const kept = new Set(built.map((row) => String(row._globalSourceId)));
    for (const { label, keep, doc } of cases) expect([label, kept.has(String(doc._id))]).toEqual([label, keep]);
    expect(built.length).toBe(1500 + cases.filter((c) => c.keep).length);
  });

  test("each duplicate pass reads its index in order: no blocking sort", async () => {
    const history = new GlobalTrendsHistory(db, (work) => work());
    const snapshotId = await history.withSnapshot(async (snapshot) => snapshot.id);
    for (const { key, index } of DEDUPE_PASSES) {
      const plan = JSON.stringify(await history.collection.aggregate(duplicateRowsPipeline(snapshotId, key), { hint: index }).explain("executionStats"));
      expect(plan).toContain(`"indexName":"${index}"`);
      expect(plan).not.toMatch(/"stage":"SORT"/);
      expect(plan).not.toContain('"$sort"');
    }
  });

  test("MMR progression opens and closes each series without sorting every eligible game", async () => {
    const service = new AdminGlobalTrendsService({ db });
    const result = await service.run("mmrProgression", {}, { interval: "day", tz: "UTC" });
    expect(result.points.length).toBeGreaterThan(0);
    // The sort the previous pipeline needed overflows the same cap.
    const snapshotId = service.history.current.id;
    await expect(service.history.collection.aggregate([
      { $match: { _globalSnapshotId: snapshotId, _globalTrustedMmr: true } }, { $sort: { date: 1, gameId: 1 } },
    ]).toArray()).rejects.toMatchObject({ codeName: MEMORY_LIMIT_NO_DISK_USE });
    const read = jest.spyOn(service.history.collection, "aggregate");
    await service.run("mmrProgression", { refresh_after: Date.now() }, { interval: "week", tz: "UTC" });
    const chart = read.mock.calls.map(([pipeline]) => pipeline).find((pipeline) => pipeline.at(-1)?.$facet?.points);
    const points = chart.at(-1).$facet.points;
    expect(points.findIndex((stage) => stage.$sort)).toBeGreaterThan(points.findIndex((stage) => stage.$group));
    for (const [, options] of read.mock.calls) expect(options).not.toHaveProperty("allowDiskUse");
  });
});
