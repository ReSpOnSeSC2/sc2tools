"use strict";

const { GlobalTrendsQueries, QUERY_MAX_TIME_MS, queryKey } = require("../src/services/adminGlobalTrendsQueries");
const { TIMEOUTS } = require("../src/config/constants");

function deferred() {
  /** @type {(value: any) => void} */
  let resolve = () => {};
  /** @type {(error: Error) => void} */
  let reject = () => {};
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("Global Trends query admission and caching", () => {
  afterEach(() => jest.restoreAllMocks());

  test("slow pending work is shared and its TTL starts when it finishes", async () => {
    let now = 1000;
    jest.spyOn(Date, "now").mockImplementation(() => now);
    const queries = new GlobalTrendsQueries();
    const pending = deferred();
    const work = jest.fn(() => pending.promise);
    const first = queries.cached("chart", work);
    await Promise.resolve();
    now += 60000;
    expect(queries.cached("chart", work)).toBe(first);
    expect(work).toHaveBeenCalledTimes(1);
    pending.resolve("result");
    await first;
    now += 29999;
    expect(queries.cached("chart", work)).toBe(first);
    now += 2;
    expect(queries.cached("chart", work)).not.toBe(first);
    await Promise.resolve();
    expect(work).toHaveBeenCalledTimes(2);
  });

  test("failure from before a refresh cannot evict the replacement request", async () => {
    const queries = new GlobalTrendsQueries();
    const old = deferred();
    const fresh = deferred();
    const first = queries.cached("roster", () => old.promise);
    const failed = expect(first).rejects.toThrow("old query failed");
    queries.clear();
    const second = queries.cached("roster", () => fresh.promise);
    await Promise.resolve();
    old.reject(new Error("old query failed"));
    await failed;
    expect(queries.cached("roster", () => Promise.resolve("wrong"))).toBe(second);
    fresh.resolve("fresh");
    await expect(second).resolves.toBe("fresh");
  });

  test("all consumers share two DB slots and release them after failure", async () => {
    const queries = new GlobalTrendsQueries();
    const active = [deferred(), deferred(), deferred(), deferred()];
    /** @type {number[]} */
    const started = [];
    const requests = active.map((pending, i) => queries.execute(() => {
      started.push(i);
      return pending.promise;
    }));
    const outcomes = Promise.allSettled(requests);
    expect(started).toEqual([0, 1]);
    active[0].resolve("roster");
    await requests[0];
    expect(started).toEqual([0, 1, 2]);
    active[1].reject(new Error("timeout"));
    await requests[1].catch(() => {});
    expect(started).toEqual([0, 1, 2, 3]);
    active[2].resolve("chart");
    active[3].resolve("options");
    await outcomes;
    expect(queries.active).toBe(0);
    expect(queries.waiters).toHaveLength(0);
  });

  test("regex filters keep distinct cache keys and DB timeout precedes socket timeout", () => {
    expect(queryKey([{ $match: { map: /Arena/i } }])).not.toBe(queryKey([{ $match: { map: /Test/i } }]));
    expect(QUERY_MAX_TIME_MS).toBeLessThan(TIMEOUTS.MONGO_SOCKET_MS);
  });
});
