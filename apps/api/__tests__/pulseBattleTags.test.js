// @ts-nocheck
"use strict";

/**
 * PulseMmrService.getBattleTags — BattleTag backfill source.
 *
 * Replays never carry the ``#discriminator``, so SC2Pulse's account
 * data (``members.account.battleTag`` on /character/search hits) is
 * the only automated way to fill the profile's BattleTag. These tests
 * pin the two resolution ladders (numeric character id → /character/{id}
 * → profile-URL search; toon handle → bare-term then profile-URL
 * search), the placeholder-tag reject, the per-id cache (hits AND
 * misses), and cross-account dedupe.
 *
 * Response shapes mirror live captures from 2026-06-10:
 *   /character/994428        → [{region:"US", realm:1, battlenetId:267727, ...}]
 *   /character/search?term=… → [{members:{account:{battleTag:"ReSpOnSe#1872"}, character:{...}}}]
 */

const { PulseMmrService } = require("../src/services/pulseMmr");

function jsonResponse(payload) {
  return {
    ok: true,
    json: async () => payload,
  };
}

const SEARCH_HIT = [
  {
    members: {
      character: {
        realm: 1,
        name: "ReSpOnSe#722",
        id: 994428,
        region: "US",
        battlenetId: 267727,
      },
      account: { battleTag: "ReSpOnSe#1872", id: 994428 },
    },
  },
];

describe("services/pulseMmr getBattleTags", () => {
  test("numeric id: /character/{id} → profile-URL search → account.battleTag", async () => {
    const fetchImpl = jest.fn(async (url) => {
      if (url.includes("/character/994428")) {
        return jsonResponse([
          { region: "US", realm: 1, battlenetId: 267727, id: 994428 },
        ]);
      }
      if (url.includes("/character/search")) {
        // Note: the live API does NOT match a bare numeric term — the
        // service must arrive here with a profile URL.
        if (url.includes(encodeURIComponent("/profile/1/1/267727"))) {
          return jsonResponse(SEARCH_HIT);
        }
        return jsonResponse([]);
      }
      return jsonResponse([]);
    });
    const svc = new PulseMmrService({ fetchImpl });
    const tags = await svc.getBattleTags(["994428"]);
    expect(tags).toEqual(["ReSpOnSe#1872"]);
  });

  test("toon handle: falls through bare term to the profile-URL forms", async () => {
    const fetchImpl = jest.fn(async (url) => {
      if (!url.includes("/character/search")) return jsonResponse([]);
      // Bare toon term misses (matches observed live behaviour);
      // the blizzard.com URL form hits.
      if (url.includes("starcraft2.blizzard.com")) {
        return jsonResponse(SEARCH_HIT);
      }
      return jsonResponse([]);
    });
    const svc = new PulseMmrService({ fetchImpl });
    const tags = await svc.getBattleTags(["1-S2-1-267727"]);
    expect(tags).toEqual(["ReSpOnSe#1872"]);
  });

  test("rejects SC2Pulse placeholder tags (f#123456) instead of persisting them", async () => {
    const fetchImpl = jest.fn(async (url) => {
      if (url.includes("/character/search")) {
        return jsonResponse([
          { members: { account: { battleTag: "f#314159" } } },
        ]);
      }
      return jsonResponse([]);
    });
    const svc = new PulseMmrService({ fetchImpl });
    const tags = await svc.getBattleTags(["1-S2-1-267727"]);
    expect(tags).toEqual([]);
  });

  test("dedupes when several pulse ids resolve to the same account", async () => {
    // The common real-world profile: the same account saved once as a
    // toon handle (games-ingest backfill) and once as the numeric
    // SC2Pulse id (manual Settings entry).
    const fetchImpl = jest.fn(async (url) => {
      if (url.includes("/character/994428")) {
        return jsonResponse([
          { region: "US", realm: 1, battlenetId: 267727 },
        ]);
      }
      if (url.includes("/character/search")) return jsonResponse(SEARCH_HIT);
      return jsonResponse([]);
    });
    const svc = new PulseMmrService({ fetchImpl });
    const tags = await svc.getBattleTags(["994428", "1-S2-1-267727"]);
    expect(tags).toEqual(["ReSpOnSe#1872"]);
  });

  test("returns multiple tags for ids spanning different accounts", async () => {
    const fetchImpl = jest.fn(async (url) => {
      if (!url.includes("/character/search")) return jsonResponse([]);
      if (url.includes(encodeURIComponent("1-S2-1-111"))) {
        return jsonResponse([
          { members: { account: { battleTag: "MainAcct#1111" } } },
        ]);
      }
      return jsonResponse([
        { members: { account: { battleTag: "Smurf#2222" } } },
      ]);
    });
    const svc = new PulseMmrService({ fetchImpl });
    const tags = await svc.getBattleTags(["1-S2-1-111", "2-S2-1-222"]);
    expect(tags).toEqual(["MainAcct#1111", "Smurf#2222"]);
  });

  test("caches hits AND misses per id within the TTL", async () => {
    let now = 1_000_000;
    const fetchImpl = jest.fn(async (url) => {
      if (url.includes("/character/search")) {
        if (url.includes(encodeURIComponent("1-S2-1-111"))) {
          return jsonResponse(SEARCH_HIT);
        }
        return jsonResponse([]); // the other id never resolves
      }
      return jsonResponse([]);
    });
    const svc = new PulseMmrService({
      fetchImpl,
      now: () => now,
      btagCacheTtlMs: 60_000,
    });
    await svc.getBattleTags(["1-S2-1-111", "3-S2-1-333"]);
    const callsAfterFirst = fetchImpl.mock.calls.length;
    // Second pass inside the TTL: zero new HTTP calls — the miss for
    // 3-S2-1-333 is cached too, which is what keeps the detect
    // endpoint cheap for profiles that simply don't resolve.
    const second = await svc.getBattleTags(["1-S2-1-111", "3-S2-1-333"]);
    expect(second).toEqual(["ReSpOnSe#1872"]);
    expect(fetchImpl.mock.calls.length).toBe(callsAfterFirst);
    // TTL elapsed: the lookup re-runs.
    now += 61_000;
    await svc.getBattleTags(["1-S2-1-111"]);
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  test("network failure yields [] without throwing", async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error("boom");
    });
    const svc = new PulseMmrService({ fetchImpl });
    await expect(svc.getBattleTags(["994428"])).resolves.toEqual([]);
  });

  test("garbage input is skipped", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse([]));
    const svc = new PulseMmrService({ fetchImpl });
    const tags = await svc.getBattleTags([null, "", "   ", "not-an-id", 42]);
    expect(tags).toEqual([]);
    // "not-an-id" is neither numeric nor toon-shaped: no HTTP at all.
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
