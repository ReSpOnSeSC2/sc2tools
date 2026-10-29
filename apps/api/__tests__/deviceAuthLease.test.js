"use strict";

const { randomUUID } = require("crypto");
const { Timestamp } = require("mongodb");
const { deviceAuthOwnerHash } = require("../src/services/deviceAuthAuthority");
const { deferred, until, authFixture } = require("./helpers/deviceAuthFixture");

test("grant is one actual primary majority nonce write with an owned causal session and command floor", async () => {
  const f = authFixture(), grant = await f.lease.acquire();
  expect(grant).not.toBeNull();
  const [command, options] = f.command.mock.calls[0], filter = command.query, update = command.update;
  expect(filter).toMatchObject({ mode: "active", grantsEverEnabled: true,
    expiresAt: { $exists: false }, owner: { $exists: false } });
  expect(update).toEqual({ $set: { grantProbeNonce: expect.any(String) } });
  expect(command).toMatchObject({ findAndModify: "jobLocks", new: true, upsert: false,
    writeConcern: { w: "majority", j: true, wtimeout: 1800 } });
  expect(options).toMatchObject({ readPreference: "primary", timeoutMS: 1800 });
  expect(f.sessions[0].options).toEqual({ causalConsistency: true });
  expect(grant.operationTime).toEqual(new Timestamp({ t: 20, i: 5 }));
  expect(grant.operationTime).not.toBe(f.sessions[0].operationTime);
  expect(f.sessions[0].endSession).toHaveBeenCalledTimes(1);
  expect(await f.lease.acquire()).toBe(grant); expect(f.command).toHaveBeenCalledTimes(1);
  await f.cache.stopAndDrain();
});

test("demand coalesces sixteen waiters and pressure never starts another actual probe", async () => {
  const f = authFixture(), gate = deferred(), original = f.command.getMockImplementation();
  f.command.mockImplementation(async (/** @type {any} */ command, /** @type {any} */ options) => {
    await gate.promise; return original(command, options);
  });
  const pending = Array.from({ length: 16 }, () => f.lease.acquire());
  expect(await f.lease.acquire()).toBeNull(); expect(f.command).toHaveBeenCalledTimes(1);
  gate.resolve(); const grants = await Promise.all(pending);
  expect(grants.every(grant => grant === grants[0])).toBe(true); expect(grants[0]).not.toBeNull();
  await f.cache.stopAndDrain();
});

test("late grant session cleanup cannot publish or extend the pre-dispatch deadline", async () => {
  const f = authFixture(), gate = deferred();
  const pending = f.lease.acquire(); f.sessions[0].endSession.mockImplementationOnce(() => gate.promise);
  await until(() => f.sessions[0].endSession.mock.calls.length === 1);
  f.clock.mono = 1800; gate.resolve(); expect(await pending).toBeNull(); expect(f.lease.current()).toBeNull();
  await f.cache.stopAndDrain();
});

test.each(["prepared", "namespace", "uuid-array", "duplicate-operation", "expiresAt", "owner", "wrong-nonce", "missing-floor", "zero-floor"])(
  "unsupported %s state cannot grant or repair authority", async kind => {
    const f = authFixture(), original = f.command.getMockImplementation();
    f.command.mockImplementation(async (/** @type {any} */ command, /** @type {any} */ options) => {
      const reply = await original(command, options), row = reply.value;
      if (kind === "prepared") row.mode = "prepared";
      if (kind === "namespace") row.ownerHashNamespace = "different";
      if (kind === "uuid-array") row.generation = [row.generation];
      if (kind === "duplicate-operation") {
        const entry = { operationId: randomUUID(), ownerHash: deviceAuthOwnerHash("owner-a"), kind: "erase", phase: "uncertain" };
        row.pending = [entry, { ...entry }];
      }
      if (kind === "expiresAt" || kind === "owner") row[kind] = null;
      if (kind === "wrong-nonce") row.grantProbeNonce = randomUUID();
      if (kind === "missing-floor") f.sessions[0].operationTime = undefined;
      if (kind === "zero-floor") f.sessions[0].operationTime = new Timestamp({ t: 0, i: 0 });
      return reply;
    });
    expect(await f.lease.acquire()).toBeNull(); expect(f.command).toHaveBeenCalledTimes(1);
    expect(f.collection.updateOne).toBeUndefined(); await f.cache.stopAndDrain();
  },
);

test("unknown grant ACK does not authorize even if metadata may have committed", async () => {
  const f = authFixture(), original = f.command.getMockImplementation();
  f.command.mockImplementationOnce(async (/** @type {any} */ command, /** @type {any} */ options) => {
    await original(command, options); throw new Error("lost ACK");
  });
  expect(await f.lease.acquire()).toBeNull(); expect(f.lease.current()).toBeNull();
  const grant = await f.lease.acquire(); expect(grant).not.toBeNull();
  expect(f.command).toHaveBeenCalledTimes(2); await f.cache.stopAndDrain();
});

test.each(["not-ok", "write-concern-error", "null-write-concern-error", "no-match", "null-value"])(
  "raw grant reply %s cannot be mistaken for acknowledged majority success", async kind => {
    const f = authFixture(), original = f.command.getMockImplementation();
    f.command.mockImplementationOnce(async (/** @type {any} */ command, /** @type {any} */ options) => {
      const reply = await original(command, options);
      if (kind === "not-ok") reply.ok = 0;
      if (kind === "write-concern-error") reply.writeConcernError = { code: 64 };
      if (kind === "null-write-concern-error") reply.writeConcernError = null;
      if (kind === "no-match") reply.lastErrorObject.n = 0;
      if (kind === "null-value") reply.value = null;
      return reply;
    });
    expect(await f.lease.acquire()).toBeNull(); expect(f.lease.current()).toBeNull();
    expect(f.sessions[0].endSession).toHaveBeenCalledTimes(1); await f.cache.stopAndDrain();
  },
);

test("cold reads use distinct causal sessions advanced to the acknowledged command floor", async () => {
  const f = authFixture(), grant = await f.lease.acquire();
  const reader = jest.fn(async options => {
    expect(options.session).not.toBe(f.sessions[0]);
    expect(options.session.options).toEqual({ causalConsistency: true });
    expect(options.session.advanceOperationTime).toHaveBeenCalledWith(grant.operationTime);
    expect(options).toMatchObject({ readPreference: "primary", readConcern: { level: "majority" } });
    return "actual result";
  });
  expect((await f.lease.read(grant, reader)).snapshot).toBe("actual result");
  expect(f.sessions[1].endSession).toHaveBeenCalledTimes(1); await f.cache.stopAndDrain();
});

test("held cold-read cleanup stays owned and cannot rebind after same-generation renewal", async () => {
  const f = authFixture(), grant = await f.lease.acquire(), gate = deferred();
  const pending = f.lease.read(grant, async () => "old snapshot");
  f.sessions[1].endSession.mockImplementationOnce(() => gate.promise);
  await until(() => f.sessions[1].endSession.mock.calls.length === 1);
  f.clock.mono = 1800; const fresh = await f.lease.acquire(); expect(fresh.generation).toBe(grant.generation);
  expect(f.lease.reads.size).toBe(1); gate.resolve(); expect(await pending).toBeNull();
  await f.cache.stopAndDrain();
});

test("four actual reads remain charged until settlement, including expired work", async () => {
  const f = authFixture(), grant = await f.lease.acquire(), gate = deferred(), reader = jest.fn(() => gate.promise);
  const tasks = Array.from({ length: 4 }, () => f.lease.read(grant, reader));
  expect(await f.lease.read(grant, reader)).toBeNull(); expect(reader).toHaveBeenCalledTimes(4);
  f.clock.mono = 1800; const next = await f.lease.acquire();
  expect(await f.lease.read(next, reader)).toBeNull(); expect(f.lease.reads.size).toBe(4);
  gate.resolve("late"); expect(await Promise.all(tasks)).toEqual([null, null, null, null]);
  await f.cache.stopAndDrain();
});

test.each([NaN, -1])("invalid elapsed clock %s retires reuse without an authority query", async value => {
  const f = authFixture(); await f.lease.acquire(); f.clock.mono = value;
  expect(f.lease.current()).toBeNull(); expect(await f.lease.acquire()).toBeNull();
  expect(f.command).toHaveBeenCalledTimes(1); await f.cache.stopAndDrain();
});

test("request timeout keeps the actual probe charged; shutdown owns its late settlement", async () => {
  jest.useFakeTimers(); const f = authFixture(), gate = deferred();
  const original = f.command.getMockImplementation();
  f.command.mockImplementation(async (/** @type {any} */ command, /** @type {any} */ options) => {
    await gate.promise; return original(command, options);
  });
  const pending = f.lease.acquire(); f.clock.mono = 1800; await jest.advanceTimersByTimeAsync(1800);
  expect(await pending).toBeNull(); expect(f.lease.probe).not.toBeNull();
  let drained = false; const stop = f.cache.stopAndDrain().then(() => { drained = true; });
  await Promise.resolve(); expect(drained).toBe(false); expect(await f.lease.acquire()).toBeNull();
  gate.resolve(); await stop; expect(f.lease.current()).toBeNull(); jest.useRealTimers();
});
