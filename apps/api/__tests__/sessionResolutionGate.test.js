// @ts-nocheck
"use strict";

/* eslint-disable max-lines-per-function */

const {
  SessionResolutionGate,
} = require("../src/services/sessionResolutionGate");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("SessionResolutionGate", () => {
  test("coalesces a many-socket reconnect burst into one computation", async () => {
    const gate = new SessionResolutionGate();
    const work = deferred();
    const compute = jest.fn(() => work.promise);

    const calls = Array.from({ length: 20 }, () =>
      gate.resolve("u1", "America/New_York", { reuseRecent: true }, compute));
    await new Promise((resolve) => setImmediate(resolve));
    expect(compute).toHaveBeenCalledTimes(1);

    const snapshot = { wins: 3, losses: 2, games: 5, mmrCurrent: 4821 };
    work.resolve(snapshot);
    await expect(Promise.all(calls)).resolves.toEqual(
      Array.from({ length: 20 }, () => snapshot),
    );
  });

  test("serializes different timezone buckets for the same user", async () => {
    const gate = new SessionResolutionGate();
    let active = 0;
    let peak = 0;
    const first = deferred();
    const computeFirst = jest.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await first.promise;
      active -= 1;
      return { games: 1 };
    });
    const computeSecond = jest.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      active -= 1;
      return { games: 2 };
    });

    const a = gate.resolve("u1", "UTC", {}, computeFirst);
    const b = gate.resolve("u1", "Europe/Berlin", {}, computeSecond);
    await new Promise((resolve) => setImmediate(resolve));
    expect(computeFirst).toHaveBeenCalledTimes(1);
    expect(computeSecond).not.toHaveBeenCalled();
    first.resolve();
    await expect(Promise.all([a, b])).resolves.toEqual([
      { games: 1 },
      { games: 2 },
    ]);
    expect(peak).toBe(1);
  });

  test("serves a short cache and write invalidation starts a new generation", async () => {
    let now = 1_000;
    const gate = new SessionResolutionGate({
      ttlMs: 15_000,
      now: () => now,
    });
    const compute = jest
      .fn()
      .mockResolvedValueOnce({ games: 1 })
      .mockResolvedValueOnce({ games: 2 });

    await expect(gate.resolve("u1", "UTC", { reuseRecent: true }, compute)).resolves.toEqual({
      games: 1,
    });
    now += 10_000;
    await expect(gate.resolve("u1", "UTC", { reuseRecent: true }, compute)).resolves.toEqual({
      games: 1,
    });
    expect(compute).toHaveBeenCalledTimes(1);

    gate.invalidate("u1");
    await expect(gate.resolve("u1", "UTC", { reuseRecent: true }, compute)).resolves.toEqual({
      games: 2,
    });
    expect(compute).toHaveBeenCalledTimes(2);
  });

  test("forced refreshes coalesce and normal reconnects wait for the fresh value", async () => {
    const gate = new SessionResolutionGate();
    const refresh = deferred();
    const compute = jest
      .fn()
      .mockResolvedValueOnce({ mmrCurrent: 4800 })
      .mockImplementationOnce(() => refresh.promise);

    await gate.resolve("u1", "UTC", { reuseRecent: true }, compute);
    const forcedA = gate.resolve(
      "u1",
      "UTC",
      { refreshCurrentMmr: true },
      compute,
    );
    const forcedB = gate.resolve(
      "u1",
      "UTC",
      { refreshCurrentMmr: true },
      compute,
    );
    const normal = gate.resolve("u1", "UTC", { reuseRecent: true }, compute);
    await new Promise((resolve) => setImmediate(resolve));
    expect(compute).toHaveBeenCalledTimes(2);

    refresh.resolve({ mmrCurrent: 4821 });
    await expect(Promise.all([forcedA, forcedB, normal])).resolves.toEqual([
      { mmrCurrent: 4821 },
      { mmrCurrent: 4821 },
      { mmrCurrent: 4821 },
    ]);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  test("bounds subscribers retained by one slow resolution", async () => {
    const gate = new SessionResolutionGate({ maxSubscribersPerTask: 2 });
    const work = deferred();
    const compute = jest.fn(() => work.promise);
    const first = gate.resolve("u1", "UTC", {}, compute);
    const second = gate.resolve("u1", "UTC", {}, compute);
    await expect(
      gate.resolve("u1", "UTC", {}, compute),
    ).rejects.toMatchObject({ code: "SESSION_RESOLUTION_BUSY" });
    work.resolve({ games: 0 });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { games: 0 },
      { games: 0 },
    ]);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  test("bounds simultaneous computations across different users", async () => {
    const gate = new SessionResolutionGate({
      maxActiveComputes: 4,
      maxComputeWaiters: 32,
    });
    const blocker = deferred();
    let active = 0;
    let peak = 0;
    let started = 0;
    const calls = Array.from({ length: 10 }, (_, index) =>
      gate.resolve(`u${index}`, "UTC", {}, async () => {
        active += 1;
        started += 1;
        peak = Math.max(peak, active);
        await blocker.promise;
        active -= 1;
        return { games: index };
      }));

    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toBe(4);
    expect(gate.capacitySnapshot()).toEqual(
      expect.objectContaining({
        computeActive: 4,
        computeWaiters: 6,
        maxActiveComputes: 4,
        maxComputeWaiters: 32,
      }),
    );

    blocker.resolve();
    await expect(Promise.all(calls)).resolves.toHaveLength(10);
    expect(peak).toBeLessThanOrEqual(4);
    expect(gate.capacitySnapshot()).toEqual(
      expect.objectContaining({ computeActive: 0, computeWaiters: 0 }),
    );
  });

  test("fails excess cross-user work once the global wait queue is full", async () => {
    const gate = new SessionResolutionGate({
      maxActiveComputes: 1,
      maxComputeWaiters: 2,
    });
    const blocker = deferred();
    const calls = Array.from({ length: 4 }, (_, index) =>
      gate.resolve(`u${index}`, "UTC", {}, async () => {
        await blocker.promise;
        return { games: index };
      }));
    const settled = Promise.allSettled(calls);

    await new Promise((resolve) => setImmediate(resolve));
    expect(gate.capacitySnapshot()).toEqual(
      expect.objectContaining({ computeActive: 1, computeWaiters: 2 }),
    );
    blocker.resolve();

    const results = await settled;
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
    const rejected = results.filter((result) => result.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({
      code: "SESSION_RESOLUTION_BUSY",
    });
  });
});
