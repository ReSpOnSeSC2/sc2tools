"use strict";

const { randomUUID } = require("crypto");
const { sha256 } = require("../src/util/hash");
const { deviceAuthOwnerHash } = require("../src/services/deviceAuthAuthority");
const { authFixture, deferred, until } = require("./helpers/deviceAuthFixture");
const HASH = sha256("synthetic-device-a"), OTHER = sha256("synthetic-device-b");
afterEach(() => jest.useRealTimers());

test("positive tickets are one-use, private and cloned, with zero token reads on retained hits", async () => {
  const f = authFixture(), ticket = await f.cache.prepare(HASH);
  expect(ticket).toEqual({}); expect(Object.isFrozen(ticket)).toBe(true);
  const value = f.cache.consume(HASH, ticket);
  expect(value).toEqual({ userId: "owner-a", deviceId: "device-a" });
  value.userId = "changed"; expect(f.cache.consume(HASH, ticket)).toBeNull();
  expect(f.cache.consume(HASH, await f.cache.prepare(HASH))).toEqual({ userId: "owner-a", deviceId: "device-a" });
  expect(f.read).toHaveBeenCalledTimes(1); expect(f.command).toHaveBeenCalledTimes(1);
  expect([...f.cache.states.keys()]).not.toContain(HASH); expect(JSON.stringify(ticket)).not.toContain("owner-a");
  expect(f.cache.consume(OTHER, await f.cache.prepare(HASH))).toBeNull(); await f.cache.stopAndDrain();
});

test("completed entries renew under the same generation, but an older prepared ticket cannot renew", async () => {
  const f = authFixture(), old = await f.cache.prepare(HASH);
  f.clock.mono = 1800;
  const fresh = await f.cache.prepare(HASH);
  expect(f.cache.consume(HASH, old)).toBeNull(); expect(f.cache.consume(HASH, fresh)).not.toBeNull();
  expect(f.read).toHaveBeenCalledTimes(1); expect(f.command).toHaveBeenCalledTimes(2);
  await f.cache.stopAndDrain();
});

test.each(["generation", "incarnation"])("new %s retires entries and prepared admissions", async field => {
  const f = authFixture(), old = await f.cache.prepare(HASH);
  f.row[field] = randomUUID(); f.clock.mono = 1800;
  const fresh = await f.cache.prepare(HASH);
  expect(f.cache.consume(HASH, old)).toBeNull(); expect(f.cache.consume(HASH, fresh)).not.toBeNull();
  expect(f.read).toHaveBeenCalledTimes(2); await f.cache.stopAndDrain();
});

test("a held old lookup is not rebound after same-generation renewal, including owner-unknown IO", async () => {
  const f = authFixture(), gate = deferred(); f.read.mockImplementationOnce(() => gate.promise);
  const old = f.cache.prepare(HASH); await until(() => f.read.mock.calls.length === 1);
  const originalGrant = f.lease.current(); f.clock.mono = 1800;
  const freshGrant = await f.lease.acquire(); expect(freshGrant.generation).toBe(originalGrant.generation);
  gate.resolve(f.snapshot); expect(await old).toBeNull();
  expect([...f.cache.states.values()].every(state => !state.entry)).toBe(true);
  expect(f.cache.consume(HASH, await f.cache.prepare(HASH))).not.toBeNull();
  expect(f.read).toHaveBeenCalledTimes(2); await f.cache.stopAndDrain();
});

test("denied and uncertain owner snapshots cannot become tickets; unrelated owners remain eligible", async () => {
  const f = authFixture();
  f.row.pending = [{ operationId: randomUUID(), ownerHash: deviceAuthOwnerHash("owner-a"), kind: "erase", phase: "uncertain" }];
  expect(await f.cache.prepare(HASH)).toBeNull();
  f.snapshot.hit.userId = "owner-b";
  expect(f.cache.consume(OTHER, await f.cache.prepare(OTHER))).toEqual({ userId: "owner-b", deviceId: "device-a" });
  expect(f.read).toHaveBeenCalledTimes(2); await f.cache.stopAndDrain();
});

test("denyAll, missing positives and malformed owner scope bypass without negative retention", async () => {
  const f = authFixture(); f.row.denyAll = true;
  expect(await f.cache.prepare(HASH)).toBeNull(); expect(f.read).not.toHaveBeenCalled();
  f.row.denyAll = false; f.clock.mono = 1800; f.snapshot.hit = null;
  expect(await f.cache.prepare(HASH)).toBeNull(); expect(await f.cache.prepare(HASH)).toBeNull();
  f.snapshot.hit = { userId: {}, deviceId: "id" };
  expect(await f.cache.prepare(HASH)).toBeNull(); expect(f.read).toHaveBeenCalledTimes(3);
  expect([...f.cache.states.values()].every(state => !state.entry)).toBe(true); await f.cache.stopAndDrain();
});

test.each([null, NaN, 1e20, 940000])("invalid or exactly due observed lastSeen %s forces an independent-lookup decision", async seen => {
  const f = authFixture(); f.snapshot.observedLastSeenAtMs = seen;
  expect(await f.cache.prepare(HASH)).toBeNull(); expect(f.cache.tickets.size).toBe(0);
  expect([...f.cache.states.values()].every(state => !state.entry)).toBe(true);
  await f.cache.stopAndDrain();
});

test("the +2s independent heartbeat does not let a +60s refresh hide the +62s touch boundary", async () => {
  const f = authFixture(); expect(f.cache.consume(HASH, await f.cache.prepare(HASH))).not.toBeNull();
  f.snapshot.observedLastSeenAtMs += 2000;
  f.clock.mono = 60000; f.clock.wall += 60000;
  expect(await f.cache.prepare(HASH)).toBeNull(); // expired old entry: caller performs a fresh baseline lookup
  expect(f.cache.consume(HASH, await f.cache.prepare(HASH))).not.toBeNull();
  f.clock.mono = 62000; f.clock.wall += 2000;
  expect(await f.cache.prepare(HASH)).toBeNull(); expect(f.read).toHaveBeenCalledTimes(2);
  await f.cache.stopAndDrain();
});

test("absolute token TTL never slides even when the wall-clock liveness timestamp remains recent", async () => {
  const f = authFixture(); expect(f.cache.consume(HASH, await f.cache.prepare(HASH))).not.toBeNull();
  f.clock.mono = 59000;
  expect(f.cache.consume(HASH, await f.cache.prepare(HASH))).not.toBeNull(); expect(f.read).toHaveBeenCalledTimes(1);
  f.clock.mono = 60000; expect(await f.cache.prepare(HASH)).toBeNull();
  expect(f.read).toHaveBeenCalledTimes(1); await f.cache.stopAndDrain();
});

test("LRU eviction retires old tickets and reads only the evicted positive again", async () => {
  const f = authFixture({ entries: 2 });
  for (const hash of [HASH, OTHER, HASH, sha256("third"), OTHER]) {
    expect(f.cache.consume(hash, await f.cache.prepare(hash))).not.toBeNull();
  }
  expect(f.read).toHaveBeenCalledTimes(4); expect(f.cache.stateCount).toBe(2);
  expect(f.cache.bytes).toBeLessThanOrEqual(f.cache.limits.bytes); await f.cache.stopAndDrain();
  expect(f.cache.bytes).toBe(0); expect(f.cache.stateCount).toBe(0);
});

test("evicted held work keeps its key/bytes charged and cannot refill after actual settlement", async () => {
  const f = authFixture({ entries: 1 }), gate = deferred(); f.read.mockImplementationOnce(() => gate.promise);
  const pending = f.cache.prepare(HASH); await until(() => f.read.mock.calls.length === 1);
  const charged = f.cache.bytes;
  expect(await f.cache.prepare(OTHER)).toBeNull(); expect(f.cache.stateCount).toBe(1);
  expect(f.cache.bytes).toBe(charged); expect(f.cache.tasks.size).toBe(1);
  gate.resolve(f.snapshot); expect(await pending).toBeNull(); expect(f.cache.stateCount).toBe(0);
  expect(f.cache.bytes).toBe(0); await f.cache.stopAndDrain();
});

test("four actual held loads stay charged and preparation pressure takes the uncached decision", async () => {
  const f = authFixture(), gate = deferred(); f.read.mockImplementation(() => gate.promise);
  const pending = Array.from({ length: 4 }, (_, index) => f.cache.prepare(sha256("held" + index)));
  await until(() => f.read.mock.calls.length === 4);
  expect(await f.cache.prepare(HASH)).toBeNull(); expect(f.cache.tasks.size).toBe(4);
  gate.resolve(f.snapshot); for (const ticket of await Promise.all(pending)) expect(ticket).not.toBeNull();
  await f.cache.stopAndDrain(); expect(f.cache.bytes).toBe(0);
});

test("sixteen one-use tickets have a bounded charge and releasing one restores admission capacity", async () => {
  const f = authFixture(), tickets = [];
  for (let index = 0; index < 16; index += 1) tickets.push(await f.cache.prepare(HASH));
  expect(tickets.every(Boolean)).toBe(true); expect(await f.cache.prepare(HASH)).toBeNull();
  expect(f.cache.tickets.size).toBe(16); expect(f.read).toHaveBeenCalledTimes(1);
  expect(f.cache.consume(HASH, tickets[0])).not.toBeNull(); expect(await f.cache.prepare(HASH)).not.toBeNull();
  await f.cache.stopAndDrain(); expect(f.cache.bytes).toBe(0);
});

test("byte pressure and oversize DTOs do not create unaccounted retained entries", async () => {
  const small = authFixture({ bytes: 200 }); expect(await small.cache.prepare(HASH)).toBeNull();
  expect(small.read).not.toHaveBeenCalled(); expect(small.cache.bytes).toBeLessThanOrEqual(200);
  const large = authFixture(); large.snapshot.hit.deviceId = "x".repeat(257);
  expect(await large.cache.prepare(HASH)).toBeNull(); expect(large.cache.tickets.size).toBe(0);
  await Promise.all([small.cache.stopAndDrain(), large.cache.stopAndDrain()]);
  expect(small.cache.bytes).toBe(0); expect(large.cache.bytes).toBe(0);
});

test("throwing snapshot and wall-clock seams bypass without reusing their failed result", async () => {
  const f = authFixture(); f.read.mockRejectedValueOnce(new Error("provider failure"));
  expect(await f.cache.prepare(HASH)).toBeNull(); expect(f.cache.tickets.size).toBe(0);
  const ticket = await f.cache.prepare(HASH); expect(ticket).not.toBeNull();
  f.cache.wallNow = () => { throw new Error("clock failure"); };
  expect(f.cache.consume(HASH, ticket)).toBeNull(); expect(f.cache.tickets.size).toBe(0);
  f.cache.wallNow = () => f.clock.wall;
  expect(f.cache.consume(HASH, await f.cache.prepare(HASH))).not.toBeNull();
  expect(f.read).toHaveBeenCalledTimes(2); await f.cache.stopAndDrain();
});

test("shutdown retires immediately and owns timed-out load/session work until actual completion", async () => {
  jest.useFakeTimers(); const f = authFixture(), gate = deferred(); f.read.mockImplementationOnce(() => gate.promise);
  const pending = f.cache.prepare(HASH); await until(() => f.read.mock.calls.length === 1);
  f.clock.mono = 1800; await jest.advanceTimersByTimeAsync(1800); expect(await pending).toBeNull();
  expect(f.cache.tasks.size).toBe(1); expect(f.cache.bytes).toBeGreaterThan(0);
  let drained = false; const stop = f.cache.stopAndDrain().then(() => { drained = true; });
  await Promise.resolve(); expect(drained).toBe(false); expect(await f.cache.prepare(OTHER)).toBeNull();
  gate.resolve(f.snapshot); await stop;
  expect(f.cache.tasks.size).toBe(0); expect(f.cache.bytes).toBe(0); expect(f.cache.stateCount).toBe(0);
});
