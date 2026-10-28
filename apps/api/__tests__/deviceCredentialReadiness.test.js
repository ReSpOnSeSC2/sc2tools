"use strict";

const { DeviceCredentialReadiness, prepareDeviceCredentialsForServing, READINESS_MS, READINESS_WAITERS } = require("../src/services/deviceCredentialReadiness");
const { deferred, until } = require("./helpers/deviceAuthFixture");

afterEach(() => jest.useRealTimers());

test("one actual readiness operation coalesces bounded waiters without a replacement queue", async () => {
  const held = deferred(), prepare = jest.fn(() => held.promise), readiness = new DeviceCredentialReadiness(null, { capability: "causal", prepare });
  const requests = Array.from({ length: READINESS_WAITERS }, () => readiness.ensure());
  await expect(readiness.ensure()).rejects.toThrow("readiness_unavailable");
  expect(prepare).toHaveBeenCalledTimes(1); expect(readiness.attempt.waiters).toBe(READINESS_WAITERS);
  held.resolve({ incarnation: "one" });
  expect(await Promise.all(requests)).toEqual(Array(READINESS_WAITERS).fill({ incarnation: "one" }));
  expect(readiness.attempt).toBeNull();
});

test("a timed-out readiness attempt remains charged and cannot publish late or be replaced", async () => {
  jest.useFakeTimers(); let now = 0;
  const held = deferred(), prepare = jest.fn(() => held.promise), readiness = new DeviceCredentialReadiness(null, { capability: "causal", prepare, now: () => now });
  const result = readiness.ensure().catch(error => error);
  now = READINESS_MS; await jest.advanceTimersByTimeAsync(READINESS_MS);
  expect((await result).code).toBe("device_credential_readiness_unavailable");
  expect(readiness.attempt.retired).toBe(true);
  await expect(readiness.ensure()).rejects.toThrow("readiness_unavailable"); expect(prepare).toHaveBeenCalledTimes(1);
  held.resolve({ incarnation: "late" }); await until(() => readiness.attempt === null);
  prepare.mockImplementationOnce(async () => ({ incarnation: "fresh" }));
  expect(await readiness.ensure()).toEqual({ incarnation: "fresh" }); expect(prepare).toHaveBeenCalledTimes(2);
});

test("stop retires synchronously and drains actual preparation through its cleanup", async () => {
  const held = deferred(), readiness = new DeviceCredentialReadiness(null, { capability: "causal", prepare: () => held.promise });
  const request = readiness.ensure().catch(error => error); let drained = false;
  const stop = readiness.stopAndDrain().then(() => { drained = true; });
  expect(readiness.stopped).toBe(true); expect(readiness.attempt.retired).toBe(true);
  await Promise.resolve(); expect(drained).toBe(false);
  await expect(readiness.ensure()).rejects.toThrow("readiness_unavailable");
  held.resolve({ incarnation: "retired" }); await stop;
  expect((await request).code).toBe("device_credential_readiness_unavailable"); expect(drained).toBe(true);
});

test.each(["reject", "null", "throwing clock", "backward clock"])("failed %s readiness does not create a serving outage", async mode => {
  let calls = 0;
  const now = () => {
    calls += 1;
    if (mode === "throwing clock") throw new Error("clock");
    return mode === "backward clock" && calls > 1 ? -1 : 0;
  };
  const readiness = new DeviceCredentialReadiness(null, { capability: "causal", now, prepare: async () => {
    if (mode === "reject") throw new Error("metadata unavailable"); return null;
  } });
  const logger = { warn: jest.fn(() => { throw new Error("diagnostics unavailable"); }) };
  expect(await prepareDeviceCredentialsForServing({ readiness }, logger)).toBe(false);
  expect(logger.warn).toHaveBeenCalledTimes(1);
});

test("writer-owned later recovery revalidates rather than remembering a failed ready result", async () => {
  const prepare = jest.fn().mockRejectedValueOnce(new Error("unknown ACK")).mockResolvedValueOnce({ incarnation: "prepared" });
  const readiness = new DeviceCredentialReadiness(null, { capability: "causal", prepare });
  expect(await prepareDeviceCredentialsForServing({ readiness }, null)).toBe(false);
  expect(await readiness.ensure()).toEqual({ incarnation: "prepared" }); expect(prepare).toHaveBeenCalledTimes(2);
});

test("an undeclared capability cannot invoke even an injected preparation transport", async () => {
  const prepare = jest.fn(async () => ({ incarnation: "synthetic" }));
  const readiness = new DeviceCredentialReadiness(null, { prepare });
  await expect(readiness.ensure()).rejects.toThrow("readiness_unavailable");
  expect(prepare).not.toHaveBeenCalled();
});
