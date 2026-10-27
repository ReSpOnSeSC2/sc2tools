// @ts-nocheck
"use strict";

const { PrivateSearchCapacity } = require("../src/services/privateSearchCapacity");
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test("one owner has one permit and an old release cannot retire its replacement", () => {
  const gate = new PrivateSearchCapacity();
  const release = gate.acquire("owner-a");
  expect(() => gate.acquire("owner-a")).toThrow("private_search_busy");
  release();
  const replacement = gate.acquire("owner-a");
  release();
  expect(gate.capacitySnapshot().active).toBe(1);
  replacement(); replacement();
  expect(gate.capacitySnapshot().active).toBe(0);
});

test("a full global lane rejects work immediately without a queue or joining", async () => {
  const gate = new PrivateSearchCapacity();
  const first = gate.acquire("owner-a"), second = gate.acquire("owner-b");
  const work = jest.fn();
  await expect(gate.run("owner-c", work)).rejects.toMatchObject({ code: "private_search_busy", status: 503 });
  await expect(gate.run("owner-a", work)).rejects.toMatchObject({ code: "private_search_busy" });
  expect(work).not.toHaveBeenCalled();
  expect(gate.capacitySnapshot()).toMatchObject({ active: 2, queued: 0, cached: 0 });
  first(); second();
});

test("an outward timeout does not release an unsettled reader or its cleanup", async () => {
  const gate = new PrivateSearchCapacity({ maxActive: 1 });
  const read = deferred(), cleanup = deferred();
  const worker = gate.run("owner-a", async () => { await read.promise; await cleanup.promise; return "done"; });
  expect(await Promise.race([worker, Promise.resolve("response expired")])).toBe("response expired");
  read.resolve(); await Promise.resolve();
  expect(() => gate.acquire("owner-b")).toThrow("private_search_busy");
  cleanup.resolve();
  await expect(worker).resolves.toBe("done");
  expect(gate.capacitySnapshot().active).toBe(0);
});

test.each(["synchronous", "asynchronous"])("%s worker failure releases its permit", async mode => {
  const gate = new PrivateSearchCapacity();
  await expect(gate.run("owner-a", () => {
    if (mode === "synchronous") throw new Error("worker failed");
    return Promise.reject(new Error("worker failed"));
  })).rejects.toThrow("worker failed");
  expect(gate.capacitySnapshot().active).toBe(0);
});

test("an uncertain reader cleanup quarantines its slot instead of admitting more work", async () => {
  const gate = new PrivateSearchCapacity({ maxActive: 1 });
  await expect(gate.run("owner-a", async () => {
    throw Object.assign(new Error("cleanup failed"), { code: "private_search_cleanup_failed" });
  })).rejects.toMatchObject({ code: "private_search_cleanup_failed" });
  expect(() => gate.acquire("owner-b")).toThrow("private_search_busy");
  expect(gate.capacitySnapshot().active).toBe(1);
});

test("sixty attempts use the owner quota, including busy attempts; expiry restores it", () => {
  let now = 1000;
  const gate = new PrivateSearchCapacity({ now: () => now });
  const release = gate.acquire("owner-a");
  for (let attempt = 1; attempt < 60; attempt += 1) {
    expect(() => gate.acquire("owner-a")).toThrow("private_search_busy");
  }
  expect(() => gate.acquire("owner-a")).toThrow("private_search_rate_limited");
  release();
  try { gate.acquire("owner-a"); } catch (error) {
    expect(error).toMatchObject({ status: 429, retryAfter: 60 });
  }
  now += 60_000;
  gate.acquire("owner-a")();
});

test("new owners cannot evict an unexpired quota; expired buckets can be pruned", () => {
  let now = 1000;
  const gate = new PrivateSearchCapacity({ maxOwners: 2, now: () => now });
  gate.acquire("owner-a")(); gate.acquire("owner-b")();
  expect(() => gate.acquire("owner-c")).toThrow("private_search_busy");
  expect(gate.capacitySnapshot().rateBuckets).toBe(2);
  now += 60_000;
  gate.acquire("owner-c")();
  expect(gate.capacitySnapshot().rateBuckets).toBe(1);
  expect(JSON.stringify(gate.capacitySnapshot())).not.toContain("owner");
});
