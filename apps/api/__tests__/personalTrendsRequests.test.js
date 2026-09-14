"use strict";

const { AggregationsService } = require("../src/services/aggregations");

function deferred() {
  /** @type {(value: any) => void} */
  let resolve = () => {};
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}

/** @param {any} aggregate */
function service(aggregate) {
  return new AggregationsService({ games: /** @type {any} */ ({ aggregate }) });
}

describe("personal Trends query reuse integration", () => {
  test("day/week and MMR requests share one date probe and retain their own interval", async () => {
    const range = deferred();
    const aggregate = jest.fn((pipeline) => ({ toArray: () => pipeline[1]?.$group?.minDate
      ? range.promise : Promise.resolve([]) }));
    const agg = service(aggregate);
    const pending = [
      agg.timeseries("user-a", { interval: "day" }, {}),
      agg.timeseries("user-a", { interval: "week" }, {}),
      agg.mmrProgression("user-a", { interval: "week" }, {}),
    ];
    await Promise.resolve();
    await Promise.resolve();
    expect(aggregate).toHaveBeenCalledTimes(1);
    range.resolve([{ minDate: new Date("2026-09-01"), maxDate: new Date("2026-09-14") }]);
    const results = await Promise.all(pending);
    expect(results.map((result) => result.interval)).toEqual(["day", "week", "week"]);
    expect(aggregate).toHaveBeenCalledTimes(4);
    expect(aggregate.mock.calls.filter(([pipeline]) => pipeline[1]?.$group?.minDate)).toHaveLength(1);
  });

  test("identical chart requests share all DB work and retain the established result shape", async () => {
    const pending = deferred();
    const aggregate = jest.fn((/** @type {any[]} */ _pipeline = []) => ({ toArray: () => pending.promise }));
    const agg = service(aggregate);
    const first = agg.timeseries("user-a", { interval: "month", tz: "UTC" }, { map: "Arena" });
    const second = agg.timeseries("user-a", { tz: "UTC", interval: "month" }, { map: "Arena" });
    await Promise.resolve();
    await Promise.resolve();
    expect(aggregate).toHaveBeenCalledTimes(1);
    pending.resolve([{ bucket: new Date("2026-09-01"), wins: 2, losses: 1, total: 3, avgMacroScore: 71.234 }]);
    const expected = { interval: "month", points: [{ bucket: new Date("2026-09-01"), wins: 2, losses: 1, total: 3, avgMacroScore: 71.2, winRate: 2 / 3 }] };
    await expect(first).resolves.toEqual(expected);
    await expect(second).resolves.toEqual(expected);
    await agg.timeseries("user-a", { interval: "month", tz: "UTC" }, { map: "Arena" });
    expect(aggregate).toHaveBeenCalledTimes(2);
  });

  test("different authenticated users, filters, timezone and options never share chart results", async () => {
    const pending = deferred();
    const aggregate = jest.fn((/** @type {any[]} */ _pipeline = []) => ({ toArray: () => pending.promise }));
    const agg = service(aggregate);
    const active = [
      agg.timeseries("user-a", { interval: "month", tz: "UTC" }, { map: "Arena" }),
      agg.timeseries("user-b", { interval: "month", tz: "UTC" }, { map: "Arena" }),
      agg.timeseries("user-a", { interval: "month", tz: "UTC" }, { map: "Other" }),
      agg.timeseries("user-a", { interval: "month", tz: "America/New_York" }, { map: "Arena" }),
      agg.timeseries("user-a", { interval: "month", tz: "UTC" }, { race: "T" }),
    ];
    await Promise.resolve();
    await Promise.resolve();
    expect(aggregate).toHaveBeenCalledTimes(5);
    expect(aggregate.mock.calls.map(([pipeline]) => pipeline?.[0].$match.userId)).toEqual(["user-a", "user-b", "user-a", "user-a", "user-a"]);
    pending.resolve([]);
    await Promise.all(active);
  });

  test("date probes retain date/race/user filters and do not survive completion", async () => {
    const pending = deferred();
    const aggregate = jest.fn((/** @type {any[]} */ _pipeline = []) => ({ toArray: () => pending.promise }));
    const agg = service(aggregate);
    const matches = [
      { userId: "user-a", date: { $gte: new Date("2026-01-01") } },
      { userId: "user-a", date: { $gte: new Date("2026-09-01") } },
      { userId: "user-b", date: { $gte: new Date("2026-01-01") } },
      { userId: "user-a", date: { $gte: new Date("2026-01-01") }, myRace: /^P/i },
    ];
    const active = matches.map((match) => /** @type {any} */ (agg)._fitInterval(match, "day"));
    await Promise.resolve();
    expect(aggregate).toHaveBeenCalledTimes(4);
    expect(aggregate.mock.calls.map(([pipeline]) => pipeline?.[0].$match)).toEqual(matches);
    pending.resolve([{ minDate: new Date("2026-01-01"), maxDate: new Date("2026-09-14") }]);
    await Promise.all(active);
    await /** @type {any} */ (agg)._fitInterval(matches[0], "day");
    expect(aggregate).toHaveBeenCalledTimes(5);
  });

  test("separate adapters with the same internal user marker cannot share data", async () => {
    const pending = deferred();
    const firstAggregate = jest.fn(() => ({ toArray: () => pending.promise }));
    const secondAggregate = jest.fn(() => ({ toArray: () => Promise.resolve([]) }));
    const first = service(firstAggregate).timeseries("__admin_global_trends_internal__", { interval: "month" }, {});
    const second = service(secondAggregate).timeseries("__admin_global_trends_internal__", { interval: "month" }, {});
    await expect(second).resolves.toEqual({ interval: "month", points: [] });
    expect(firstAggregate).toHaveBeenCalledTimes(1);
    expect(secondAggregate).toHaveBeenCalledTimes(1);
    pending.resolve([{ total: 4, wins: 3, losses: 1 }]);
    expect(/** @type {any} */ (await first).points[0].total).toBe(4);
  });
});
