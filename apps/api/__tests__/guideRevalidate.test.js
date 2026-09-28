// @ts-nocheck
"use strict";

/**
 * services/guideRevalidate.js (signed ISR purge ping), util/wilson.js and
 * the guides config fields in config/loader.js.
 */

const http = require("http");
const { createHmac } = require("crypto");
const {
  buildGuideRevalidator,
  signGuideRevalidation,
  SIGNATURE_HEADER,
  REVALIDATE_TIMEOUT_MS,
} = require("../src/services/guideRevalidate");
const { wilsonInterval, round4 } = require("../src/util/wilson");
const { loadConfig } = require("../src/config/loader");

const SECRET = "test-revalidate-secret";
const TS = 1785585600000;
const BASE_ENV = {
  MONGODB_URI: "mongodb://localhost:27017",
  CLERK_SECRET_KEY: "sk_test_x",
  SERVER_PEPPER_HEX: "a".repeat(64),
};

function fakeLogger() {
  return { warn: jest.fn(), info: jest.fn() };
}

describe("buildGuideRevalidator", () => {
  test("is a no-op without both a URL and a secret", async () => {
    const fetchImpl = jest.fn();
    for (const deps of [{ url: "", secret: SECRET }, { url: "https://x.test/r", secret: null }, {}]) {
      const res = await buildGuideRevalidator({ ...deps, fetchImpl })();
      expect(res).toEqual({ ok: false, skipped: "not_configured" });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("POSTs {ts, scope} with an HMAC over `${ts}.${body}` and a 5 s timeout", async () => {
    const fetchImpl = jest.fn(async () => ({ ok: true, status: 200 }));
    const res = await buildGuideRevalidator({
      url: " https://web.test/api/revalidate-guides ", secret: SECRET, fetchImpl, now: () => TS,
    })();
    expect(res).toEqual({ ok: true, status: 200 });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://web.test/api/revalidate-guides");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ ts: TS, scope: "guides" });
    const expected = `sha256=${createHmac("sha256", SECRET).update(`${TS}.${init.body}`).digest("hex")}`;
    expect(init.headers[SIGNATURE_HEADER]).toBe(expected);
    expect(init.headers["content-type"]).toBe("application/json");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(REVALIDATE_TIMEOUT_MS).toBe(5000);
    expect(signGuideRevalidation(SECRET, TS, init.body)).toBe(expected);
  });

  test("fail-soft: rejections, network errors and timeouts resolve with a reason (status only in logs)", async () => {
    const logger = fakeLogger();
    const base = { url: "https://web.test/r", secret: SECRET, logger };
    const rejected = await buildGuideRevalidator({ ...base, fetchImpl: async () => ({ ok: false, status: 401 }) })();
    expect(rejected).toEqual({ ok: false, status: 401 });
    expect(logger.warn).toHaveBeenLastCalledWith({ status: 401 }, "guide_revalidate_rejected");

    const network = await buildGuideRevalidator({
      ...base, fetchImpl: async () => { throw new TypeError("fetch failed"); },
    })();
    expect(network).toEqual({ ok: false, error: "network" });
    const timeout = await buildGuideRevalidator({
      ...base,
      fetchImpl: async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); },
    })();
    expect(timeout).toEqual({ ok: false, error: "timeout" });
    for (const call of logger.warn.mock.calls) expect(JSON.stringify(call)).not.toContain(SECRET);
  });

  test("end to end over HTTP: the receiver can verify the signature", async () => {
    let received = null;
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        received = { body, signature: req.headers[SIGNATURE_HEADER], type: req.headers["content-type"] };
        res.writeHead(204);
        res.end();
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address();
      const url = `http://127.0.0.1:${port}/api/revalidate-guides`;
      const res = await buildGuideRevalidator({ url, secret: SECRET })();
      expect(res).toEqual({ ok: true, status: 204 });
      const { ts } = JSON.parse(received.body);
      expect(received.signature).toBe(signGuideRevalidation(SECRET, ts, received.body));
      expect(received.type).toBe("application/json");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("util/wilson", () => {
  test("95% Wilson interval, rounded to 4 dp", () => {
    expect(wilsonInterval(60, 100)).toEqual({ low: 0.502, high: 0.6906 });
    expect(wilsonInterval(24, 40)).toEqual({ low: 0.446, high: 0.7365 });
    expect(wilsonInterval(30, 30)).toEqual({ low: 0.8865, high: 1 });
    expect(wilsonInterval(0, 30)).toEqual({ low: 0, high: 0.1135 });
  });

  test("rejects empty or impossible inputs", () => {
    expect(wilsonInterval(0, 0)).toBeNull();
    expect(wilsonInterval(5, 4)).toBeNull();
    expect(wilsonInterval(-1, 4)).toBeNull();
    expect(wilsonInterval(Number.NaN, 4)).toBeNull();
    expect(round4(2 / 3)).toBe(0.6667);
  });
});

describe("config/loader — guides fields", () => {
  test("GUIDES_ENABLED defaults off and accepts true/1/on", () => {
    expect(loadConfig(BASE_ENV).guidesEnabled).toBe(false);
    for (const value of ["true", "1", "on", "TRUE"]) {
      expect(loadConfig({ ...BASE_ENV, GUIDES_ENABLED: value }).guidesEnabled).toBe(true);
    }
    expect(loadConfig({ ...BASE_ENV, GUIDES_ENABLED: "0" }).guidesEnabled).toBe(false);
  });

  test("revalidate URL and secret pass through, null when unset", () => {
    const off = loadConfig(BASE_ENV);
    expect(off.guidesRevalidateUrl).toBeNull();
    expect(off.guidesRevalidateSecret).toBeNull();
    const on = loadConfig({
      ...BASE_ENV,
      GUIDES_REVALIDATE_URL: "https://sc2tools.test/api/revalidate-guides",
      GUIDES_REVALIDATE_SECRET: SECRET,
    });
    expect(on.guidesRevalidateUrl).toBe("https://sc2tools.test/api/revalidate-guides");
    expect(on.guidesRevalidateSecret).toBe(SECRET);
  });
});
