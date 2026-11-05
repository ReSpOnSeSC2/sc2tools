// @ts-nocheck
"use strict";

const pino = require("pino");
const http = require("node:http");

const {
  buildKeepaliveWorker,
  __internal,
} = require("../src/services/keepalive");

const silentLogger = pino({ level: "silent" });

describe("keepalive sanitizeTargets", () => {
  test("dedupes, trims, and rejects non-http(s) and malformed entries", () => {
    const out = __internal.sanitizeTargets([
      "https://sc2tools-api.onrender.com/v1/ping",
      "  https://sc2tools-api.onrender.com/v1/ping  ", // dup after trim/normalize
      "https://api.sc2tools.com/v1/ping",
      "ftp://nope.example.com/",
      "not a url",
      "",
      null,
      undefined,
    ]);
    expect(out).toEqual([
      "https://sc2tools-api.onrender.com/v1/ping",
      "https://api.sc2tools.com/v1/ping",
    ]);
  });

  test("rejects website hosts and Vercel previews while preserving API hosts", () => {
    const onWebsiteTarget = jest.fn();
    expect(__internal.sanitizeTargets([
      "https://sc2tools.com/api/ping",
      "https://www.sc2tools.com/api/ping",
      "http://SC2TOOLS.COM.:8080/api/ping?token=private",
      "https://preview.sc2tools.com/api/ping",
      "https://sc2tools-git-feature-team.vercel.app/api/ping",
      "https://VERCEL.APP./",
      "https://api.sc2tools.com/v1/ping",
      "https://sc2tools-api.onrender.com/v1/ping",
      "https://custom-api.example.com/v1/ping",
      "https://notvercel.app/v1/ping",
    ], onWebsiteTarget)).toEqual([
      "https://api.sc2tools.com/v1/ping",
      "https://sc2tools-api.onrender.com/v1/ping",
      "https://custom-api.example.com/v1/ping",
      "https://notvercel.app/v1/ping",
    ]);
    expect(onWebsiteTarget).toHaveBeenCalledTimes(6);
    expect(onWebsiteTarget).toHaveBeenCalledWith();
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
  test("ignores legacy website targets, pings the API, and logs only a count", async () => {
    const logger = { child: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
    logger.child.mockReturnValue(logger);
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const worker = buildKeepaliveWorker({
      targets: [
        "https://sc2tools.com/api/ping?token=do-not-log",
        "https://sc2tools.vercel.app/api/ping",
        "https://api.sc2tools.com/v1/ping",
      ],
      logger,
      fetchImpl: fetchMock,
    });
    await worker.pingNow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("https://api.sc2tools.com/v1/ping", expect.any(Object));
    expect(logger.warn).toHaveBeenCalledWith({ blockedTargetCount: 2 }, "keepalive_website_targets_ignored");
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("do-not-log");
    await worker.stop();
  });

  test("does not start or fetch when all configured targets are websites", async () => {
    const fetchMock = jest.fn();
    const worker = buildKeepaliveWorker({
      targets: ["https://www.sc2tools.com/api/ping", "https://preview.vercel.app/api/ping"],
      logger: silentLogger,
      fetchImpl: fetchMock,
    });
    worker.start();
    expect(worker.isRunning()).toBe(false);
    expect(await worker.pingNow()).toEqual([]);
    await worker.stop();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("forbids redirects so API heartbeats cannot follow a redirect to the website", async () => {
    const requests = [];
    const server = http.createServer((req, res) => {
      requests.push(req.url);
      if (req.url === "/v1/ping") {
        res.writeHead(302, { Location: "/website" });
      } else {
        res.writeHead(200);
      }
      res.end();
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const url = `http://127.0.0.1:${server.address().port}/v1/ping`;
    const worker = buildKeepaliveWorker({ targets: [url], logger: silentLogger });
    try {
      expect(await worker.pingNow()).toEqual([
        expect.objectContaining({ url, ok: false, error: expect.any(String) }),
      ]);
      expect(requests).toEqual(["/v1/ping"]);
    } finally {
      await worker.stop();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

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
