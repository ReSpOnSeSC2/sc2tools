// @ts-nocheck
"use strict";

const { GlobalTrendsHistory, HISTORY_FRESH_MS } = require("../src/services/adminGlobalTrendsHistory");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(read = () => Promise.resolve([])) {
  const collection = { createIndex: jest.fn().mockResolvedValue("index"), deleteMany: jest.fn().mockResolvedValue({ deletedCount: 1 }) };
  const db = { db: { collection: () => collection }, games: { aggregate: jest.fn(() => ({ toArray: read })) } };
  return { db, collection, history: new GlobalTrendsHistory(db, (work) => work()) };
}

async function until(predicate) {
  for (let i = 0; i < 50 && !predicate(); i += 1) await Promise.resolve();
  expect(predicate()).toBe(true);
}

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

  test("a failed merge is unpublished and cleaned up; retry builds a new complete generation", async () => {
    const read = jest.fn().mockRejectedValueOnce(new Error("merge timed out")).mockResolvedValue([]);
    const { db, collection, history } = fixture(read);
    await expect(history.withSnapshot(async (snapshot) => snapshot.id)).rejects.toThrow("merge timed out");
    const pipeline = db.games.aggregate.mock.calls[0][0];
    const stamp = pipeline.at(-2).$set;
    expect(stamp._globalExpiresAt).toBeInstanceOf(Date);
    expect(stamp._globalSourceId).toBe("$_id");
    expect(collection.deleteMany).toHaveBeenCalledWith({ _globalSnapshotId: stamp._globalSnapshotId });
    expect(history.current).toBeNull();
    const id = await history.withSnapshot(async (snapshot) => snapshot.id);
    expect(id).not.toBe(stamp._globalSnapshotId);
    expect(db.games.aggregate).toHaveBeenCalledTimes(2);
  });
});
