// @ts-nocheck
"use strict";

/**
 * Unit tests for the cloud-side SC2Pulse resolver.
 *
 * The resolver mirrors the Python ``core.pulse_resolver`` algorithm
 * but runs server-side so the backfill cron can heal opponents
 * whose pulseCharacterId never landed at first ingest. Tests pin:
 *   * happy-path resolution against the real SC2Pulse JSON shape
 *   * 429 rate-limit retry honouring Retry-After
 *   * positive cache short-circuits the second call
 *   * negative cache TTL expiry — a miss is retried later
 *   * forceRefresh bypasses both caches
 */

const { buildPulseResolver, parseToonHandle } = require("../src/services/pulseResolver");

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("parseToonHandle", () => {
  test("canonical handles parse", () => {
    expect(parseToonHandle("1-S2-1-267727")).toEqual({
      region: 1, realm: 1, bnid: 267727,
    });
    expect(parseToonHandle("2-S2-1-9876543")).toEqual({
      region: 2, realm: 1, bnid: 9876543,
    });
  });
  test("rejects malformed / legacy / unknown", () => {
    expect(parseToonHandle("")).toBeNull();
    expect(parseToonHandle(null)).toBeNull();
    expect(parseToonHandle("garbage")).toBeNull();
    expect(parseToonHandle("1-S1-1-267727")).toBeNull(); // legacy S1
    expect(parseToonHandle("9-S2-1-267727")).toBeNull(); // unknown region
    expect(parseToonHandle("1-S2-x-267727")).toBeNull(); // non-numeric
  });
});

describe("buildPulseResolver — happy path", () => {
  test("resolves a toon to the candidate matching the bnid", async () => {
    const fetchImpl = jest.fn(async (url) => {
      if (url.includes("/season/list/all")) {
        return jsonResponse([{ region: "US", battlenetId: 60 }]);
      }
      if (url.includes("/character/search/advanced")) {
        return jsonResponse([111111, 452727]);
      }
      if (url.includes("/character/111111/teams")) {
        return jsonResponse([
          { members: [{ character: { region: "US", battlenetId: 999999 } }] },
        ]);
      }
      if (url.includes("/character/452727/teams")) {
        return jsonResponse([
          { members: [{ character: { region: "US", battlenetId: 267727 } }] },
        ]);
      }
      throw new Error(`unexpected url: ${url}`);
    });
    const resolver = buildPulseResolver({ fetchImpl });
    const out = await resolver.resolve({
      toonHandle: "1-S2-1-267727",
      displayName: "ReSpOnSe",
    });
    expect(out).toBe("452727");
  });

  test("positive cache short-circuits a repeat call", async () => {
    let callCount = 0;
    const fetchImpl = jest.fn(async (url) => {
      callCount += 1;
      if (url.includes("/season/list/all")) {
        return jsonResponse([{ region: "US", battlenetId: 60 }]);
      }
      if (url.includes("/character/search/advanced")) {
        return jsonResponse([452727]);
      }
      return jsonResponse([
        { members: [{ character: { region: "US", battlenetId: 267727 } }] },
      ]);
    });
    const resolver = buildPulseResolver({ fetchImpl });
    const a = await resolver.resolve({
      toonHandle: "1-S2-1-267727", displayName: "ReSpOnSe",
    });
    const callsAfterFirst = callCount;
    const b = await resolver.resolve({
      toonHandle: "1-S2-1-267727", displayName: "ReSpOnSe",
    });
    expect(a).toBe("452727");
    expect(b).toBe("452727");
    expect(callCount).toBe(callsAfterFirst);
  });

  test("forceRefresh bypasses the cache and re-probes", async () => {
    let probes = 0;
    const fetchImpl = jest.fn(async (url) => {
      if (url.includes("/season/list/all")) {
        return jsonResponse([{ region: "US", battlenetId: 60 }]);
      }
      if (url.includes("/character/search/advanced")) {
        probes += 1;
        return jsonResponse([452727]);
      }
      return jsonResponse([
        { members: [{ character: { region: "US", battlenetId: 267727 } }] },
      ]);
    });
    const resolver = buildPulseResolver({ fetchImpl });
    await resolver.resolve({ toonHandle: "1-S2-1-267727", displayName: "X" });
    expect(probes).toBe(1);
    await resolver.resolve({
      toonHandle: "1-S2-1-267727", displayName: "X", forceRefresh: true,
    });
    expect(probes).toBe(2);
  });

  test("negative cache TTL expires so a miss is retried", async () => {
    // Empty candidate list ⇒ miss. We poke the LRU expiry directly
    // to simulate the TTL elapsing without sleeping in the test.
    let probes = 0;
    const fetchImpl = jest.fn(async (url) => {
      if (url.includes("/season/list/all")) {
        return jsonResponse([{ region: "US", battlenetId: 60 }]);
      }
      probes += 1;
      return jsonResponse([]);
    });
    const resolver = buildPulseResolver({ fetchImpl });
    const first = await resolver.resolve({
      toonHandle: "1-S2-1-267727", displayName: "Ghost",
    });
    expect(first).toBeNull();
    expect(probes).toBe(1);
    // Second call inside the window — cache short-circuits.
    await resolver.resolve({
      toonHandle: "1-S2-1-267727", displayName: "Ghost",
    });
    expect(probes).toBe(1);
    // Manually expire the cache entry — equivalent to advancing the
    // wall clock past the negative TTL.
    const cache = resolver._internal.lookupCache;
    const entry = cache.get("1-S2-1-267727");
    cache.set("1-S2-1-267727", { ...entry, expiresAt: 0 });
    const third = await resolver.resolve({
      toonHandle: "1-S2-1-267727", displayName: "Ghost",
    });
    expect(third).toBeNull();
    expect(probes).toBe(2);
  });
});

describe("buildPulseResolver — error paths", () => {
  test("retries on 429 and honours Retry-After", async () => {
    let calls = 0;
    const fetchImpl = jest.fn(async (url) => {
      calls += 1;
      if (calls === 1) {
        return new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "0" },
        });
      }
      if (url.includes("/season/list/all")) {
        return jsonResponse([{ region: "US", battlenetId: 60 }]);
      }
      if (url.includes("/character/search/advanced")) {
        return jsonResponse([452727]);
      }
      return jsonResponse([
        { members: [{ character: { region: "US", battlenetId: 267727 } }] },
      ]);
    });
    const resolver = buildPulseResolver({ fetchImpl });
    const out = await resolver.resolve({
      toonHandle: "1-S2-1-267727", displayName: "ReSpOnSe",
    });
    expect(out).toBe("452727");
    expect(calls).toBeGreaterThanOrEqual(4); // at least 1 retry + 3 happy
  });

  test("network error returns null without throwing", async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error("ECONNRESET");
    });
    const resolver = buildPulseResolver({ fetchImpl });
    const out = await resolver.resolve({
      toonHandle: "1-S2-1-267727", displayName: "X",
    });
    expect(out).toBeNull();
  });

  test("malformed toon never hits the network", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse([]));
    const resolver = buildPulseResolver({ fetchImpl });
    const out = await resolver.resolve({
      toonHandle: "garbage", displayName: "X",
    });
    expect(out).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
