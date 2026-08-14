// @ts-nocheck
"use strict";

const {
  BoundedRateLimitStore,
} = require("../src/middleware/boundedRateLimitStore");

describe("BoundedRateLimitStore", () => {
  test("keeps attacker-controlled key cardinality under its hard cap", async () => {
    const store = new BoundedRateLimitStore({ maxEntries: 4 });
    store.init({ windowMs: 60_000 });
    for (let index = 0; index < 100; index += 1) {
      await store.increment(`hashed-key-${index}`);
    }
    expect(store.entries.size).toBe(4);
    expect([...store.entries.keys()]).toEqual([
      "hashed-key-96",
      "hashed-key-97",
      "hashed-key-98",
      "hashed-key-99",
    ]);
  });

  test("counts repeated hits and resets one key", async () => {
    const store = new BoundedRateLimitStore({ maxEntries: 2 });
    store.init({ windowMs: 60_000 });
    expect((await store.increment("stable-hash")).totalHits).toBe(1);
    expect((await store.increment("stable-hash")).totalHits).toBe(2);
    await store.resetKey("stable-hash");
    expect((await store.increment("stable-hash")).totalHits).toBe(1);
  });
});
