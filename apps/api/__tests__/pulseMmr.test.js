// @ts-nocheck
"use strict";

/**
 * PulseMmrService — Tier-3 fallback for the overlay session widget.
 *
 * The service hits sc2pulse.nephest.com to resolve a streamer's
 * current 1v1 ladder rating when no replay in their cloud history
 * carries a usable `myMmr`. Tests use an injected `fetch` mock so we
 * never actually hit the public API.
 */

const { PulseMmrService } = require("../src/services/pulseMmr");

function jsonResponse(payload) {
  return {
    ok: true,
    json: async () => payload,
  };
}

function failureResponse() {
  return { ok: false, json: async () => null };
}

describe("services/pulseMmr", () => {
  test("returns null for non-numeric pulseIds (raw toon handles)", async () => {
    const fetchImpl = jest.fn();
    const svc = new PulseMmrService({ fetchImpl });
    expect(await svc.getCurrentMmr("2-S2-1-12345")).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("returns null for empty / nullish input", async () => {
    const svc = new PulseMmrService({ fetchImpl: jest.fn() });
    expect(await svc.getCurrentMmr(null)).toBeNull();
    expect(await svc.getCurrentMmr(undefined)).toBeNull();
    expect(await svc.getCurrentMmr("")).toBeNull();
    expect(await svc.getCurrentMmr("   ")).toBeNull();
  });

  test("returns most recently played team's rating + region", async () => {
    const fetchImpl = jest.fn(async (url) => {
      if (url.includes("/season/list/all")) {
        return jsonResponse([
          { battlenetId: 60, region: "US", year: 2026, number: 2 },
          { battlenetId: 60, region: "EU", year: 2026, number: 2 },
        ]);
      }
      if (url.includes("season=60") && url.includes("characterId=994428")) {
        if (url.includes("season=60")) {
          // Both regions return one team each. EU is more recently played.
          if (url.includes("&characterId=994428")) {
            // Naive split: first call returns US team, second returns EU.
            // We can disambiguate by checking call order via the mock.
            const callIdx = fetchImpl.mock.calls.filter((c) =>
              String(c[0]).includes("/group/team"),
            ).length;
            if (callIdx === 1) {
              return jsonResponse([
                {
                  rating: 4800,
                  lastPlayed: "2026-04-01T10:00:00Z",
                },
              ]);
            }
            return jsonResponse([
              {
                rating: 5343,
                lastPlayed: "2026-05-01T10:00:00Z",
              },
            ]);
          }
        }
      }
      return failureResponse();
    });
    const svc = new PulseMmrService({ fetchImpl });
    const result = await svc.getCurrentMmr("994428");
    expect(result).not.toBeNull();
    expect(result?.mmr).toBe(5343);
    expect(result?.region).toBe("EU");
  });

  test("returns null when no team carries a rating in any region", async () => {
    const fetchImpl = jest.fn(async (url) => {
      if (url.includes("/season/list/all")) {
        return jsonResponse([
          { battlenetId: 60, region: "US" },
        ]);
      }
      return jsonResponse([]); // empty teams
    });
    const svc = new PulseMmrService({ fetchImpl });
    expect(await svc.getCurrentMmr("994428")).toBeNull();
  });

  test("caches successful lookups for the configured TTL", async () => {
    const fetchImpl = jest.fn(async (url) => {
      if (url.includes("/season/list/all")) {
        return jsonResponse([{ battlenetId: 60, region: "US" }]);
      }
      return jsonResponse([
        { rating: 4500, lastPlayed: "2026-05-01T10:00:00Z" },
      ]);
    });
    const svc = new PulseMmrService({
      fetchImpl,
      cacheTtlMs: 60_000,
    });
    const a = await svc.getCurrentMmr("994428");
    const b = await svc.getCurrentMmr("994428");
    expect(a?.mmr).toBe(4500);
    expect(b?.mmr).toBe(4500);
    // Two fetches total: one season probe + one team probe. The second
    // call should reuse the cache.
    const teamCalls = fetchImpl.mock.calls.filter((c) =>
      String(c[0]).includes("/group/team"),
    ).length;
    expect(teamCalls).toBe(1);
  });

  test("serves a stale cache entry when a follow-up fetch fails", async () => {
    let callCount = 0;
    const fetchImpl = jest.fn(async (url) => {
      callCount += 1;
      if (url.includes("/season/list/all")) {
        return jsonResponse([{ battlenetId: 60, region: "US" }]);
      }
      // First team fetch succeeds; subsequent ones fail.
      if (callCount > 2) return failureResponse();
      return jsonResponse([
        { rating: 4500, lastPlayed: "2026-05-01T10:00:00Z" },
      ]);
    });
    let now = 1_000_000;
    const svc = new PulseMmrService({
      fetchImpl,
      cacheTtlMs: 1_000,
      now: () => now,
    });
    const first = await svc.getCurrentMmr("994428");
    expect(first?.mmr).toBe(4500);
    // Advance past the TTL — the cache is stale and the network call
    // returns a failure. We expect the stale entry to keep serving.
    now += 5_000;
    const second = await svc.getCurrentMmr("994428");
    expect(second?.mmr).toBe(4500);
  });

  test("survives a thrown fetch (network down) by returning null", async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error("ENETUNREACH");
    });
    const svc = new PulseMmrService({ fetchImpl });
    expect(await svc.getCurrentMmr("994428")).toBeNull();
  });
});
