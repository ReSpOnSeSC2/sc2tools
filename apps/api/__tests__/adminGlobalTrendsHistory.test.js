// @ts-nocheck
"use strict";

const {
  GlobalTrendsHistory, HISTORY_FRESH_MS, HISTORY_BUILD_TIMEOUT_MS,
  DEDUPE_PASSES, STORED_DEDUPE_ORDER,
} = require("../src/services/adminGlobalTrendsHistory");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(read = () => Promise.resolve([]), duplicates = () => Promise.resolve([])) {
  const collection = {
    createIndex: jest.fn().mockResolvedValue("index"),
    deleteMany: jest.fn().mockResolvedValue({ deletedCount: 1 }),
    aggregate: jest.fn((pipeline) => ({ toArray: () => duplicates(pipeline) })),
  };
  const db = { db: { collection: () => collection }, games: { aggregate: jest.fn(() => ({ toArray: read })) } };
  return { db, collection, history: new GlobalTrendsHistory(db, (work) => work()) };
}

async function until(predicate) {
  for (let i = 0; i < 50 && !predicate(); i += 1) await Promise.resolve();
  expect(predicate()).toBe(true);
}

/** Stages that hold their whole input in memory unless an index supplies the order. */
const BLOCKING = ["$sort", "$group", "$bucket", "$bucketAuto", "$setWindowFields", "$facet", "$sortByCount"];

describe("Global Trends canonical-history lifecycle", () => {
  afterEach(() => jest.restoreAllMocks());

  test("simultaneous cards share one build and completed generations stay fresh for five minutes", async () => {
    let now = 1000;
    jest.spyOn(Date, "now").mockImplementation(() => now);
    const pending = deferred();
    const { db, history } = fixture(() => pending.promise);
    const first = history.withSnapshot(async (snapshot) => snapshot.id);
    const second = history.withSnapshot(async (snapshot) => snapshot.id);
    await until(() => db.games.aggregate.mock.calls.length === 1);
    now += 60000;
    pending.resolve([]);
    expect(await second).toBe(await first);
    now += HISTORY_FRESH_MS - 1;
    expect(await history.withSnapshot(async (snapshot) => snapshot.id)).toBe(await first);
    expect(db.games.aggregate).toHaveBeenCalledTimes(1);
    now += 2;
    expect(await history.withSnapshot(async (snapshot) => snapshot.id)).not.toBe(await first);
    expect(db.games.aggregate).toHaveBeenCalledTimes(2);
  });

  test("a refresh during a build waits for a post-refresh generation", async () => {
    const reads = [deferred(), deferred()];
    let index = 0;
    const { db, history } = fixture(() => reads[index++].promise);
    const first = history.withSnapshot(async (snapshot) => ({ id: snapshot.id, revision: snapshot.revision }));
    await until(() => db.games.aggregate.mock.calls.length === 1);
    history.invalidate();
    const refreshed = history.withSnapshot(async (snapshot) => ({ id: snapshot.id, revision: snapshot.revision }));
    reads[0].resolve([]);
    await until(() => db.games.aggregate.mock.calls.length === 2);
    reads[1].resolve([]);
    expect((await first).revision).toBe(0);
    expect((await refreshed).revision).toBe(1);
    expect((await refreshed).id).not.toBe((await first).id);
  });

  test("retired generations live until readers finish, including failed readers; a third build waits", async () => {
    const { db, collection, history } = fixture();
    const hold = deferred();
    let firstId;
    const first = history.withSnapshot(async (snapshot) => { firstId = snapshot.id; await hold.promise; });
    const failed = expect(first).rejects.toThrow("reader failed");
    await until(() => !!firstId);
    history.invalidate();
    const secondId = await history.withSnapshot(async (snapshot) => snapshot.id);
    expect(secondId).not.toBe(firstId);
    expect(collection.deleteMany).not.toHaveBeenCalledWith({ _globalSnapshotId: firstId });
    history.invalidate();
    const third = history.withSnapshot(async (snapshot) => snapshot.id);
    await Promise.resolve();
    expect(db.games.aggregate).toHaveBeenCalledTimes(2);
    hold.reject(new Error("reader failed"));
    await failed;
    expect(await third).not.toBe(secondId);
    expect(collection.deleteMany).toHaveBeenCalledWith({ _globalSnapshotId: firstId });
    expect(db.games.aggregate).toHaveBeenCalledTimes(3);
  });

  test("a failed insert pass is unpublished and cleaned up; retry builds a new complete generation", async () => {
    const read = jest.fn().mockRejectedValueOnce(new Error("merge timed out")).mockResolvedValue([]);
    const { db, collection, history } = fixture(read);
    await expect(history.withSnapshot(async (snapshot) => snapshot.id)).rejects.toThrow("merge timed out");
    const pipeline = db.games.aggregate.mock.calls[0][0];
    const options = db.games.aggregate.mock.calls[0][1];
    expect(options.timeoutMS).toBe(options.maxTimeMS);
    expect(options.maxTimeMS).toBeGreaterThan(30000);
    expect(options.maxTimeMS).toBeLessThanOrEqual(HISTORY_BUILD_TIMEOUT_MS);
    expect(pipeline.at(-1).$merge).toMatchObject({ whenMatched: "fail", whenNotMatched: "insert" });
    const stamp = pipeline.at(-2).$set;
    expect(stamp._globalExpiresAt).toBeInstanceOf(Date);
    expect(stamp._globalSourceId).toBe("$_id");
    expect(collection.deleteMany).toHaveBeenCalledWith({ _globalSnapshotId: stamp._globalSnapshotId });
    expect(collection.aggregate).not.toHaveBeenCalled();
    expect(history.current).toBeNull();
    const indexCalls = collection.createIndex.mock.calls.length;
    const id = await history.withSnapshot(async (snapshot) => snapshot.id);
    expect(id).not.toBe(stamp._globalSnapshotId);
    expect(db.games.aggregate).toHaveBeenCalledTimes(2);
    // A failure re-ensures the hinted indexes, in case one was dropped.
    expect(collection.createIndex.mock.calls.slice(indexCalls)).toEqual(collection.createIndex.mock.calls.slice(0, indexCalls));
  });

  test("a failed duplicate pass is unpublished and cleaned up too", async () => {
    const { collection, history } = fixture(undefined, () => Promise.reject(new Error("window timed out")));
    await expect(history.withSnapshot(async (snapshot) => snapshot.id)).rejects.toThrow("window timed out");
    const snapshotId = collection.aggregate.mock.calls[0][0][0].$match._globalSnapshotId;
    expect(collection.deleteMany).toHaveBeenCalledWith({ _globalSnapshotId: snapshotId });
    expect(history.current).toBeNull();
  });
});

describe("Global Trends history build on Atlas Flex limits (32 MB sort, no disk use)", () => {
  afterEach(() => jest.restoreAllMocks());

  test("the insert pass streams: no stage sorts or groups the corpus, and no command asks for disk use", async () => {
    const { db, collection, history } = fixture();
    const id = await history.withSnapshot(async (snapshot) => snapshot.id);
    const [pipeline, options] = db.games.aggregate.mock.calls[0];
    expect(pipeline.filter((stage) => BLOCKING.some((name) => name in stage))).toEqual([]);
    const stamp = pipeline.at(-2).$set;
    expect(stamp).toMatchObject({
      _globalSnapshotId: id, _globalSourceId: "$_id", _id: { generation: id, source: "$_id" },
      _globalReplayKey: { player: "$_globalPlayerId" }, _globalFileKey: { player: "$_globalPlayerId" },
    });
    for (const call of [[pipeline, options], ...collection.aggregate.mock.calls]) {
      expect(call[1]).not.toHaveProperty("allowDiskUse");
    }
  });

  test("each duplicate pass is a window whose sort the hinted index supplies", async () => {
    const { collection, history } = fixture();
    const id = await history.withSnapshot(async (snapshot) => snapshot.id);
    const indexes = new Map(collection.createIndex.mock.calls.filter(([, opts]) => opts?.name).map(([keys, opts]) => [opts.name, keys]));
    expect(collection.aggregate.mock.calls.map(([, opts]) => opts.hint)).toEqual(DEDUPE_PASSES.map((pass) => pass.index));
    for (const [[pipeline, options], pass] of collection.aggregate.mock.calls.map((call, i) => [call, DEDUPE_PASSES[i]])) {
      // Only the snapshot $match precedes the window, so its sort is pushed
      // down to the query layer and read in index order (no blocking sort).
      expect(pipeline[0]).toEqual({ $match: { _globalSnapshotId: id } });
      const window = pipeline[1].$setWindowFields;
      expect(window.partitionBy).toBe(`$${pass.key}`);
      expect(window.sortBy).toEqual(STORED_DEDUPE_ORDER);
      expect(Object.keys(indexes.get(options.hint))).toEqual(["_globalSnapshotId", pass.key, ...Object.keys(STORED_DEDUPE_ORDER)]);
      expect(indexes.get(options.hint)).toEqual({ _globalSnapshotId: 1, [pass.key]: 1, ...STORED_DEDUPE_ORDER });
      expect(pipeline.slice(2)).toEqual([{ $match: { _globalDuplicate: true } }, { $project: { _id: 1 } }]);
      expect(options).not.toHaveProperty("allowDiskUse");
      expect(options.maxTimeMS).toBeLessThanOrEqual(HISTORY_BUILD_TIMEOUT_MS);
    }
    // Same preference as the reference $sort, with the stored source id.
    expect(STORED_DEDUPE_ORDER).toEqual({ _globalTrustedMmr: -1, updatedAt: -1, _globalSourceId: 1 });
  });
});

describe("Global Trends history duplicate removal and deadline", () => {
  afterEach(() => jest.restoreAllMocks());

  test("duplicates are deleted from the unpublished generation in bounded batches, replay id first", async () => {
    const replayDuplicates = Array.from({ length: 5001 }, (_, i) => ({ _id: { generation: "g", source: `r${i}` } }));
    const fileDuplicates = [{ _id: { generation: "g", source: "f0" } }];
    const passes = [];
    const { collection, history } = fixture(undefined, (pipeline) => {
      passes.push(pipeline[1].$setWindowFields.partitionBy);
      return Promise.resolve(passes.length === 1 ? replayDuplicates : fileDuplicates);
    });
    const id = await history.withSnapshot(async (snapshot) => snapshot.id);
    expect(passes).toEqual(["$_globalReplayKey", "$_globalFileKey"]);
    const deletes = collection.deleteMany.mock.calls.map(([filter]) => filter);
    expect(deletes).toEqual([
      { _globalSnapshotId: id, _id: { $in: replayDuplicates.slice(0, 5000).map((row) => row._id) } },
      { _globalSnapshotId: id, _id: { $in: replayDuplicates.slice(5000).map((row) => row._id) } },
      { _globalSnapshotId: id, _id: { $in: fileDuplicates.map((row) => row._id) } },
    ]);
    // The file pass runs only after the replay-id duplicates are gone.
    expect(collection.deleteMany.mock.invocationCallOrder[1]).toBeLessThan(collection.aggregate.mock.invocationCallOrder[1]);
  });

  test("all build commands share one deadline, which starts once the build is admitted", async () => {
    let now = 5000;
    jest.spyOn(Date, "now").mockImplementation(() => now);
    const { db, collection } = fixture(() => { now += 20000; return Promise.resolve([]); });
    // Waiting for a query slot does not spend the build's budget.
    const history = new GlobalTrendsHistory(db, async (work) => { now += 15000; return work(); });
    await history.withSnapshot(async () => {});
    const left = (ms) => ({ maxTimeMS: ms, timeoutMS: ms });
    expect([db.games.aggregate.mock.calls[0][1], collection.aggregate.mock.calls[0][1]])
      .toMatchObject([left(HISTORY_BUILD_TIMEOUT_MS), left(HISTORY_BUILD_TIMEOUT_MS - 20000)]);
  });
});
