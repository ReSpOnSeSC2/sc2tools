// @ts-nocheck
"use strict";

const { AggregationsService } = require("../src/services/aggregations");
const { TrendsRequests, MAX_PENDING } = require("../src/services/trendsRequests");

afterEach(() => jest.restoreAllMocks());

function fixture() {
  const toArray = jest.fn(async () => [{ _id: "Protoss", games: 10, wins: 6, losses: 4 }]);
  const games = { aggregate: jest.fn(() => ({ toArray })) };
  return { service: new AggregationsService({ games }), games, toArray };
}

describe("all-history race metadata cache", () => {
  test("shares concurrent tab loads and cached answers without sharing mutable results", async () => {
    const { service, games } = fixture();
    const [first, second] = await Promise.all([
      service.randomSummary("u1", {}), service.randomSummary("u1", {}),
    ]);
    first.perRace.Protoss.games = 1000;
    expect(second.perRace.Protoss.games).toBe(10);
    expect((await service.randomSummary("u1", {})).perRace.Protoss.games).toBe(10);
    expect(games.aggregate).toHaveBeenCalledTimes(1);
  });

  test("keeps authenticated users isolated and filtered charts fresh", async () => {
    const { service, games } = fixture();
    await service.randomSummary("u1", {});
    await service.randomSummary("u2", {});
    await service.randomSummary("u1", { map: "arena" });
    await service.randomSummary("u1", { map: "arena" });
    expect(games.aggregate).toHaveBeenCalledTimes(4);
    expect(games.aggregate.mock.calls[1][0][0].$match.userId).toBe("u2");
  });

  test("expires within one minute and retries failures immediately", async () => {
    let now = 1000;
    jest.spyOn(Date, "now").mockImplementation(() => now);
    const { service, games, toArray } = fixture();
    toArray.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(service.randomSummary("u1", {})).rejects.toThrow("database unavailable");
    await service.randomSummary("u1", {});
    now += 59999;
    await service.randomSummary("u1", {});
    expect(games.aggregate).toHaveBeenCalledTimes(2);
    now += 1;
    await service.randomSummary("u1", {});
    expect(games.aggregate).toHaveBeenCalledTimes(3);
  });

  test("bounds completed metadata even with many different accounts", async () => {
    const requests = new TrendsRequests();
    for (let n = 0; n < MAX_PENDING + 20; n++) {
      await requests.cached([n], async () => ({ count: n }), 60000);
    }
    expect(requests.completed.size).toBe(MAX_PENDING);
    expect(requests.pending.size).toBe(0);
  });
});

test("an older slow metadata request cannot replace a newer completed answer", async () => {
  let now = 1000;
  jest.spyOn(Date, "now").mockImplementation(() => now);
  const requests = new TrendsRequests();
  let resolveOld;
  const oldWork = new Promise((resolve) => { resolveOld = resolve; });
  const old = requests.cached(["race-metadata"], () => oldWork, 60000);
  await Promise.resolve();
  now += 30000;
  await expect(requests.cached(["race-metadata"], async () => "new", 60000)).resolves.toBe("new");
  resolveOld("old");
  await expect(old).resolves.toBe("old");
  await expect(requests.cached(["race-metadata"], async () => "unexpected", 60000)).resolves.toBe("new");
});

test("with the memo switched off, concurrent loads still join but completed answers are never reused", async () => {
  const { service, games } = fixture();
  const [first, second] = await Promise.all([
    service.randomSummary("u1", {}, { memo: false }), service.randomSummary("u1", {}, { memo: false }),
  ]);
  expect(second).toEqual(first); expect(games.aggregate).toHaveBeenCalledTimes(1);
  await service.randomSummary("u1", {}, { memo: false });
  expect(games.aggregate).toHaveBeenCalledTimes(2);
  expect(service.trendsRequests.completed.size).toBe(0);
});
