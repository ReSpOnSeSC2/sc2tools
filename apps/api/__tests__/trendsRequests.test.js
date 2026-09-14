"use strict";

const { TrendsRequests, requestKey, MAX_PENDING, MAX_JOIN_AGE_MS } = require("../src/services/trendsRequests");

function deferred() {
  /** @type {(value: any) => void} */
  let resolve = () => {};
  /** @type {(error: Error) => void} */
  let reject = () => {};
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("personal Trends in-flight requests", () => {
  afterEach(() => jest.restoreAllMocks());

  test("shares pending work but every completed request reads fresh data", async () => {
    const requests = new TrendsRequests();
    const pending = deferred();
    const read = jest.fn(() => pending.promise);
    const first = requests.run(["chart", "user-a", {}], read);
    const second = requests.run(["chart", "user-a", {}], read);
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(1);
    pending.resolve({ count: 12 });
    await expect(Promise.all([first, second])).resolves.toEqual([{ count: 12 }, { count: 12 }]);
    expect(requests.pending.size).toBe(0);
    await expect(requests.run(["chart", "user-a", {}], async () => ({ count: 13 }))).resolves.toEqual({ count: 13 });
  });

  test("each caller owns its result, including nested arrays and date values", async () => {
    const requests = new TrendsRequests();
    const row = { points: [{ date: new Date("2026-09-14T12:00:00Z"), total: 12 }] };
    const [first, second] = await Promise.all([
      requests.run(["chart"], async () => row),
      requests.run(["chart"], async () => row),
    ]);
    first.points[0].total = 99;
    first.points[0].date.setUTCFullYear(2000);
    expect(second).toEqual(row);
    // Node's structuredClone returns a Date from the host realm in Jest.
    expect(second.points[0].date.getTime()).toBe(row.points[0].date.getTime());
    expect(second.points).not.toBe(row.points);
  });

  test("failed work is evicted and a subsequent retry can succeed", async () => {
    const requests = new TrendsRequests();
    const failure = new Error("database unavailable");
    const read = jest.fn(async () => { throw failure; });
    const failed = await Promise.allSettled([requests.run(["chart"], read), requests.run(["chart"], read)]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(failed).toEqual([{ status: "rejected", reason: failure }, { status: "rejected", reason: failure }]);
    expect(requests.pending.size).toBe(0);
    await expect(requests.run(["chart"], async () => "recovered")).resolves.toBe("recovered");
  });

  test("does not join aged work and old completion cannot remove the replacement", async () => {
    let now = 1000;
    jest.spyOn(Date, "now").mockImplementation(() => now);
    const requests = new TrendsRequests();
    const old = deferred();
    const fresh = deferred();
    const first = requests.run(["chart"], () => old.promise);
    now += MAX_JOIN_AGE_MS;
    const second = requests.run(["chart"], () => fresh.promise);
    old.resolve("old");
    await first;
    expect(requests.pending.size).toBe(1);
    const duplicateRead = jest.fn(async () => "incorrect");
    const third = requests.run(["chart"], duplicateRead);
    fresh.resolve("fresh");
    await expect(Promise.all([second, third])).resolves.toEqual(["fresh", "fresh"]);
    expect(duplicateRead).not.toHaveBeenCalled();
  });

  test("bounds the registry while allowing uncached work under load", async () => {
    const requests = new TrendsRequests();
    const pending = deferred();
    const active = Array.from({ length: MAX_PENDING }, (_, index) => requests.run([index], () => pending.promise));
    await expect(requests.run(["overflow"], async () => "fresh")).resolves.toBe("fresh");
    expect(requests.pending.size).toBe(MAX_PENDING);
    pending.resolve("done");
    await Promise.all(active);
    expect(requests.pending.size).toBe(0);
  });

  test("typed keys preserve every filter, date, regex and option without collisions", () => {
    const before = new Date("2026-09-14T12:00:00Z");
    expect(requestKey([{ map: /Arena/i, date: before }])).toBe(requestKey([{ date: new Date(before), map: /Arena/i }]));
    expect(requestKey([before])).not.toBe(requestKey([before.toISOString()]));
    expect(requestKey([undefined])).not.toBe(requestKey([null]));
    expect(requestKey([NaN])).not.toBe(requestKey([null]));
    expect(requestKey([{ map: /Arena/i }])).not.toBe(requestKey([{ map: /Arena/ }]));
    expect(requestKey([{ map: /Arena/i }])).not.toBe(requestKey([{ map: /Other/i }]));
    expect(requestKey(["user-a", { race: "P" }])).not.toBe(requestKey(["user-b", { race: "P" }]));
    expect(requestKey(["user-a", { race: "P" }])).not.toBe(requestKey(["user-a", { race: "T" }]));
    expect(requestKey([{ interval: "day" }])).not.toBe(requestKey([{ interval: "week" }]));
    expect(requestKey([{ tz: "UTC" }])).not.toBe(requestKey([{ tz: "America/New_York" }]));
    expect(requestKey([new Map()])).toBeNull();
  });
});
