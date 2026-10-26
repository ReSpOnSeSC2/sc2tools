// @ts-nocheck
"use strict";
const { createHmac } = require("crypto");
const { buildCommunityRevalidator } = require("../src/services/communityRevalidate");
const url = "https://web.example/api/revalidate-community", secret = "disposable-secret";
const configured = (options = {}) => buildCommunityRevalidator({ url, secret, ...options });
afterEach(() => jest.useRealTimers());

test("unset or malformed configuration never sends a notification", async () => {
  const fetchImpl = jest.fn();
  for (const options of [{}, { url }, { secret }, { url: "file:///private", secret }]) {
    const sender = buildCommunityRevalidator({ ...options, fetchImpl });
    expect(sender.configured).toBe(false); expect(sender.notify()).toBeUndefined(); await sender.flush();
  }
  expect(fetchImpl).not.toHaveBeenCalled();
});

test("uses the existing timestamped raw-body HMAC protocol with community scope", async () => {
  const fetchImpl = jest.fn(async () => ({ ok: true, status: 200 }));
  const sender = configured({ fetchImpl, now: () => 123456 });
  sender.notify(); await sender.flush();
  const [target, request] = fetchImpl.mock.calls[0];
  expect(target).toBe(url); expect(JSON.parse(request.body)).toEqual({ ts: 123456, scope: "community" });
  expect(request.headers["x-sc2tools-signature"]).toBe(`sha256=${createHmac("sha256", secret).update(`123456.${request.body}`).digest("hex")}`);
  expect(request.signal).toBeInstanceOf(AbortSignal);
});

test("coalesces synchronous writes and retains only one pending ping behind a held request", async () => {
  let release;
  const fetchImpl = jest.fn().mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockResolvedValue({ ok: true, status: 200 });
  const sender = configured({ fetchImpl });
  for (let i = 0; i < 100; i++) sender.notify();
  await Promise.resolve(); expect(fetchImpl).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 100; i++) sender.notify();
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  release({ ok: true, status: 200 }); await sender.flush();
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

test("an ignored abort still reaches the five-second deadline without retry or leaked diagnostics", async () => {
  jest.useFakeTimers(); const logger = { warn: jest.fn() };
  const fetchImpl = jest.fn(() => new Promise(() => {})), sender = configured({ fetchImpl, logger });
  sender.notify(); await Promise.resolve(); const request = fetchImpl.mock.calls[0][1];
  await jest.advanceTimersByTimeAsync(5000); await sender.flush();
  expect(request.signal.aborted).toBe(true); expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(logger.warn).toHaveBeenCalledWith("community_revalidate_failed");
  expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(url);
  expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(secret);
});

test.each([401, 503])("provider rejection %s is fail-soft and logs status only", async status => {
  const logger = { warn: jest.fn() }, sender = configured({ logger, fetchImpl: async () => ({ ok: false, status }) });
  sender.notify(); await expect(sender.flush()).resolves.toBeUndefined();
  expect(logger.warn).toHaveBeenCalledWith({ status }, "community_revalidate_rejected");
});

test("neither network nor logger failures escape to a committed write", async () => {
  const sender = configured({ fetchImpl: async () => { throw new Error(`${secret} ${url}`); }, logger: { warn() { throw new Error("logger unavailable"); } } });
  expect(sender.notify()).toBeUndefined(); await expect(sender.flush()).resolves.toBeUndefined();
});
