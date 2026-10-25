// @ts-nocheck
"use strict";
const { CommunityOpponentCache } = require("../src/services/communityOpponentCache");
test("one-hour LRU shares cold materialization and expires without renewing on hits", async () => {
  let now = 0; const cache = new CommunityOpponentCache({ now: () => now }), load = jest.fn(async () => ({ wins: 4 }));
  expect(await cache.read("one", load, 0)).toEqual({ wins: 4 });
  now = 3_599_999; await cache.read("one", load, 0); expect(load).toHaveBeenCalledTimes(1);
  now = 3_600_000; await cache.read("one", load, 0); expect(load).toHaveBeenCalledTimes(2);
});
test("evicts by access order and skips oversized public payloads", async () => {
  const cache = new CommunityOpponentCache({ maxEntries: 2, maxBytes: 100 });
  const value = async () => ({ games: 1 });
  await cache.read("one", value, 0); await cache.read("two", value, 0); await cache.read("one", value, 0); await cache.read("three", value, 0);
  expect([...cache.values.keys()]).toEqual(["one", "three"]);
  await cache.read("large", async () => ({ body: "x".repeat(101) }), 0); expect(cache.values.has("large")).toBe(false);
});
test("same-key consumers share one active loader while unique cold work is capped", async () => {
  let finish; const cache = new CommunityOpponentCache({ maxActive: 1 });
  const load = jest.fn(() => new Promise(resolve => { finish = resolve; }));
  const first = cache.read("one", load, 0), second = cache.read("one", load, 0);
  await Promise.resolve(); expect(load).toHaveBeenCalledTimes(1);
  await expect(cache.read("two", load, 0)).rejects.toMatchObject({ code: "community_aggregate_busy", status: 503 });
  finish({ games: 2 }); expect(await first).toEqual(await second); expect(cache.active).toBe(0);
});
test("invalidation rejects late payloads and cannot refill or delete a newer generation", async () => {
  let finish; const cache = new CommunityOpponentCache();
  const old = cache.read("one", () => new Promise(resolve => { finish = resolve; }), 0);
  const rejected = expect(old).rejects.toMatchObject({ code: "community_data_changed" });
  await Promise.resolve(); cache.invalidate();
  expect(await cache.read("one", async () => ({ fresh: true }), 1)).toEqual({ fresh: true });
  finish({ removed: true }); await rejected;
  expect(cache.values.get("one").value).toEqual({ fresh: true });
  await expect(cache.read("one", async () => ({}), 0)).rejects.toMatchObject({ status: 503 });
});
