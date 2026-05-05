// @ts-nocheck
"use strict";

const pino = require("pino");

const {
  buildKeepaliveWorker,
  __internal,
} = require("../src/services/keepalive");

const silentLogger = pino({ level: "silent" });

describe("keepalive sanitizeTargets", () => {
  test("dedupes, trims, and rejects non-http(s) and malformed entries", () => {
    const out = __internal.sanitizeTargets([
      "https://sc2tools.com/api/ping",
      "  https://sc2tools.com/api/ping  ", // dup after trim/normalize
      "https://api.sc2tools.com/v1/ping",
      "ftp://nope.example.com/",
      "not a url",
      "",
      null,
      undefined,
    ]);
    expect(out).toEqual([
      "https://sc2tools.com/api/ping",
      "https://api.sc2tools.com/v1/ping",
    ]);
  });
});

describe("keepalive clampInterval", () => {
  test("falls back to default for non-numbers", () => {
    expect(__internal.clampInterval(undefined)).toBe(13 * 60 * 1000);
    expect(__internal.clampInterval(NaN)).toBe(13 * 60 * 1000);
    expect(__internal.clampInterval(0)).toBe(13 * 60 * 1000);
    expect(__internal.clampInterval(-100)).toBe(13 * 60 * 1000);
  });

  test("enforces 60s minimum but otherwise honours the value", () => {
    expect(__internal.clampInterval(100)).toBe(60 * 1000);
    expect(__internal.clampInterval(120 * 1000)).toBe(120 * 1000);
    expect(__internal.clampInterval(60 * 60 * 1000)).toBe(60 * 60 * 1000);
  });
});

describe("keepalive worker", () => {
  test("disabled when targets are empty — no fetch fired", async () => {
    const fetchMock = jest.fn();
    const worker = buildKeepaliveWorker({
      targets: [],
      logger: silentLogger,
      fetchImpl: fetchMock,
    });
    worker.start();
    expect(worker.isRunning()).toBe(false);
    await worker.stop();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("pingNow hits each target and reports success/failure shape", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: false, status: 503 });
    const worker = buildKeepaliveWorker({
      targets: ["https://a.example.com/ping", "https://b.example.com/ping"],
      logger: silentLogger,
      fetchImpl: fetchMock,
    });
    const results = await worker.pingNow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(results).toEqual([
      expect.objectContaining({
        url: "https://a.example.com/ping",
        ok: true,
        status: 200,
      }),
      expect.objectContaining({
        url: "https://b.example.com/ping",
        ok: false,
        status: 503,
      }),
    ]);
    await worker.stop();
  });

  test("network failures are caught and surfaced, not thrown", async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error("ECONNRESET"));
    const worker = buildKeepaliveWorker({
      targets: ["https://a.example.com/ping"],
      logger: silentLogger,
      fetchImpl: fetchMock,
    });
    const results = await worker.pingNow();
    expect(results).toEqual([
      expect.objectContaining({
        url: "https://a.example.com/ping",
        ok: false,
        error: "ECONNRESET",
      }),
    ]);
    await worker.stop();
  });

  test("stop() clears the timer so the process can exit cleanly", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const worker = buildKeepaliveWorker({
      targets: ["https://a.example.com/ping"],
      intervalMs: 60 * 1000,
      logger: silentLogger,
      fetchImpl: fetchMock,
    });
    worker.start();
    expect(worker.isRunning()).toBe(true);
    await worker.stop();
    expect(worker.isRunning()).toBe(false);
  });
});
