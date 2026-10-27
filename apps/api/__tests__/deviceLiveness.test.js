// @ts-nocheck
"use strict";
const { DeviceLiveness } = require("../src/services/deviceLiveness");
const summary = (version = "1") => ({ paired: true, version, lastSeenAt: new Date(1000) });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
// Independent byte audit: no charge fields or accounting counters are inputs.
function retainedBytes(cache) {
  const states = new Set([...cache.owners.values(), ...[...cache.tasks].map(task => task.state)]);
  return [...states].reduce((bytes, state) => bytes + Buffer.byteLength(state.key)
    + (state.entry ? Buffer.byteLength(JSON.stringify(state.entry.value)) : 0), 0)
    + [...cache.touches.keys()].reduce((bytes, key) => bytes + Buffer.byteLength(key), 0);
}

test("latest-agent hits clone their Date and expire absolutely at 30 seconds", async () => {
  let now = 0; const cache = new DeviceLiveness({ now: () => now }), read = jest.fn(async () => summary());
  const first = await cache.latest("a", read); first.lastSeenAt.setTime(99999); first.version = "changed";
  now = 29999; expect(await cache.latest("a", read)).toEqual(summary()); expect(read).toHaveBeenCalledTimes(1);
  now = 30000; expect(await cache.latest("a", read)).toEqual(summary()); expect(read).toHaveBeenCalledTimes(2);
});

test("confirmed unpaired is reusable while a failed read remains an error and retries", async () => {
  const cache = new DeviceLiveness(), failure = new Error("read failed");
  const read = jest.fn().mockRejectedValueOnce(failure).mockResolvedValue({ paired: false, version: null, lastSeenAt: null });
  await expect(cache.latest("a", read)).rejects.toBe(failure);
  expect(await cache.latest("a", read)).toEqual({ paired: false, version: null, lastSeenAt: null });
  await cache.latest("a", read); expect(read).toHaveBeenCalledTimes(2);
});

test("same-owner cache readers coalesce while another owner's DTO remains separate", async () => {
  const cache = new DeviceLiveness(), gate = deferred(), read = jest.fn(() => gate.promise);
  const first = cache.latest("a", read), joined = cache.latest("a", read);
  expect(await cache.latest("b", async () => summary("b"))).toEqual(summary("b"));
  gate.resolve(summary("a")); const [a, b] = await Promise.all([first, joined]);
  expect(read).toHaveBeenCalledTimes(1); expect(a).toEqual(summary("a")); expect(a).not.toBe(b); expect(a.lastSeenAt).not.toBe(b.lastSeenAt);
});

test("active mutation bypasses once without retention and retires positive and unpaired cache entries", async () => {
  const cache = new DeviceLiveness(), read = jest.fn(async () => summary());
  await cache.latest("a", read); const finish = cache.begin("a"), during = jest.fn(async () => summary("during"));
  expect(await cache.latest("a", during)).toEqual(summary("during")); expect(during).toHaveBeenCalledTimes(1);
  expect(await cache.latest("b", async () => summary("b"))).toEqual(summary("b"));
  finish(); finish(); await cache.latest("a", read); expect(read).toHaveBeenCalledTimes(2);
  const unpaired = jest.fn(async () => ({ paired: false, version: null, lastSeenAt: null }));
  await cache.latest("c", unpaired); await cache.mutate("c", async () => {}); await cache.latest("c", unpaired);
  expect(unpaired).toHaveBeenCalledTimes(2);
});

test("a retired held read returns its original snapshot but cannot refill or join the fresh generation", async () => {
  const cache = new DeviceLiveness(), gate = deferred(), error = new Error("unknown write");
  const old = cache.latest("a", () => gate.promise);
  await expect(cache.mutate("a", async () => { throw error; })).rejects.toBe(error);
  const fresh = jest.fn(async () => summary("new")); expect(await cache.latest("a", fresh)).toEqual(summary("new"));
  gate.resolve(summary("old")); expect(await old).toEqual(summary("old"));
  expect(await cache.latest("a", fresh)).toEqual(summary("new")); expect(fresh).toHaveBeenCalledTimes(1);
});

test("owner eviction and recreation cannot let an older DB snapshot replace the new cached generation", async () => {
  const cache = new DeviceLiveness({ limits: { owners: 2 } }), gate = deferred();
  const old = cache.latest("a", () => gate.promise);
  await cache.latest("b", async () => summary("b")); await cache.latest("c", async () => summary("c"));
  await cache.latest("a", async () => summary("fresh-a"));
  gate.resolve(summary("old-a")); expect(await old).toEqual(summary("old-a"));
  expect(await cache.latest("a", async () => summary("wrong"))).toEqual(summary("fresh-a")); expect(cache.owners.size).toBe(1);
});

test("retired cache IO keeps its permit while a new request uses exactly one baseline query", async () => {
  const cache = new DeviceLiveness({ limits: { reads: 1 } }), gate = deferred();
  const old = cache.latest("a", () => gate.promise); await cache.mutate("a", async () => {});
  const bypass = jest.fn(async () => summary("fresh")); expect(await cache.latest("a", bypass)).toEqual(summary("fresh"));
  expect(bypass).toHaveBeenCalledTimes(1); expect(cache.reads).toBe(1);
  gate.resolve(summary("old")); expect(await old).toEqual(summary("old")); expect(cache.reads).toBe(0);
  await cache.latest("a", bypass); expect(bypass).toHaveBeenCalledTimes(2);
});

test("subscriber capacity performs one baseline query rather than rejecting or joining excess callers", async () => {
  const cache = new DeviceLiveness({ limits: { subscribers: 16 } }), gate = deferred();
  const read = jest.fn().mockImplementationOnce(() => gate.promise).mockResolvedValue(summary("bypass"));
  const joined = Array.from({ length: 16 }, () => cache.latest("a", read));
  expect(await cache.latest("a", read)).toEqual(summary("bypass")); expect(read).toHaveBeenCalledTimes(2);
  gate.resolve(summary("shared")); expect((await Promise.all(joined)).every(value => value.version === "shared")).toBe(true);
  expect(cache.reads).toBe(0);
});

test("the byte budget independently includes negative, empty, pending, active and evicted-pinned keys plus DTOs", async () => {
  const cache = new DeviceLiveness({ limits: { bytes: 384, entryBytes: 200, owners: 4, reads: 1 } }), gate = deferred();
  const audit = () => { const bytes = retainedBytes(cache); expect(bytes).toBe(cache.bytes); expect(bytes).toBeLessThanOrEqual(384); };
  await cache.latest("negative", async () => ({ paired: false, version: null, lastSeenAt: null })); audit();
  const finish = cache.begin("active"); const pending = cache.latest("pending", () => gate.promise);
  await cache.latest("empty-bypass", async () => summary()); audit(); expect(cache.owners.size).toBe(4);
  await cache.latest("extra", async () => summary()); await cache.latest("extra-again", async () => summary()); audit();
  const pinnedBytes = retainedBytes(cache); gate.resolve(summary("old")); expect(await pending).toEqual(summary("old")); audit();
  expect(retainedBytes(cache)).toBe(pinnedBytes - 64); finish();
  const touchGate = deferred(), touching = cache.touch("active", "hash", () => touchGate.promise);
  await Promise.resolve(); audit(); touchGate.resolve(); await touching; audit();
  const large = summary("界".repeat(500)), readLarge = jest.fn(async () => large);
  expect(await cache.latest("large", readLarge)).toEqual(large); expect(await cache.latest("large", readLarge)).toEqual(large);
  expect(readLarge).toHaveBeenCalledTimes(2); audit();
});

test("all-active owner saturation keeps bounded keys and returns honest baseline metadata", async () => {
  const cache = new DeviceLiveness({ limits: { owners: 1, bytes: 128 } });
  const a = cache.begin("a"), b = cache.begin("b"), read = jest.fn(async () => summary("uncached"));
  expect(await cache.latest("c", read)).toEqual(summary("uncached")); expect(read).toHaveBeenCalledTimes(1);
  expect(cache.owners.size).toBe(1); expect(cache.overflow).toBe(1); expect(retainedBytes(cache)).toBe(cache.bytes);
  a(); b(); b(); expect(cache.overflow).toBe(0); expect(await cache.latest("b", async () => summary())).toEqual(summary());
  expect(retainedBytes(cache)).toBeLessThanOrEqual(128);
});

test("stale touch bursts coalesce with finite admission and no detached retry", async () => {
  const cache = new DeviceLiveness({ limits: { touches: 1 } }), gate = deferred(), work = jest.fn(() => gate.promise), other = jest.fn();
  const first = cache.touch("a", "hash", work), joined = cache.touch("a", "hash", work);
  await cache.touch("b", "other", other); await Promise.resolve();
  expect(work).toHaveBeenCalledTimes(1); expect(other).not.toHaveBeenCalled(); expect(cache.touches.size).toBe(1);
  try { expect(retainedBytes(cache)).toBe(cache.bytes); } finally { gate.resolve(); await Promise.all([first, joined]); }
  expect(cache.touches.size).toBe(0); await cache.touch("b", "other", async () => { other(); }); expect(other).toHaveBeenCalledTimes(1);
});

test("failed and unknown touch writes stay nonfatal while their old metadata snapshots cannot refill cache", async () => {
  const cache = new DeviceLiveness(), gate = deferred(), error = new Error("unknown touch");
  const old = cache.latest("a", () => gate.promise);
  await expect(cache.touch("a", "hash", async () => { throw error; })).resolves.toBeUndefined();
  gate.resolve(summary("old")); expect(await old).toEqual(summary("old"));
  const fresh = jest.fn(async () => summary("fresh")); expect(await cache.latest("a", fresh)).toEqual(summary("fresh"));
  expect(fresh).toHaveBeenCalledTimes(1); const retry = jest.fn(async () => {});
  await cache.touch("a", "hash", retry); expect(retry).toHaveBeenCalledTimes(1);
});

test("GDPR invalidation encloses even an unknown exclusive-fence acquisition outcome", async () => {
  const { GdprService } = require("../src/services/gdpr");
  const cache = new DeviceLiveness(), read = jest.fn(async () => summary()); await cache.latest("a", read);
  const gdpr = new GdprService({ users: { findOne: async () => ({ userId: "a" }) } }, { beginDeviceMutation: owner => cache.begin(owner) });
  const failure = new Error("unknown fence acknowledgement"); gdpr._acquireMutationFence = jest.fn(async () => { throw failure; });
  await expect(gdpr.deleteAll("a")).rejects.toBe(failure); await cache.latest("a", read); expect(read).toHaveBeenCalledTimes(2);
});
