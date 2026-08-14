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
  test("getCurrentMmr falls through to the toon-handle path on non-numeric input", async () => {
    // A streamer who pasted their raw toon handle into Settings →
    // Profile → Pulse ID still gets a real number on the overlay; the
    // numeric branch returns null and the service then runs the
    // /character/search → /group/team round-trip via getCurrentMmrByToon.
    const fetchImpl = jest.fn(async (url) => {
      if (url.includes("/character/search")) {
        return jsonResponse([{ character: { id: 994428 } }]);
      }
      if (url.includes("/season/list/all")) {
        return jsonResponse([{ battlenetId: 60, region: "EU" }]);
      }
      return jsonResponse([
        { rating: 5343, lastPlayed: "2026-05-01T10:00:00Z" },
      ]);
    });
    const svc = new PulseMmrService({ fetchImpl });
    const out = await svc.getCurrentMmr("2-S2-1-12345");
    expect(out?.mmr).toBe(5343);
    expect(out?.region).toBe("EU");
    // /character/search must run; otherwise we'd be in the legacy
    // numeric-only branch.
    expect(
      fetchImpl.mock.calls.some((c) =>
        String(c[0]).includes("/character/search"),
      ),
    ).toBe(true);
  });

  test("returns null for malformed handles that match neither numeric id nor toon shape", async () => {
    const fetchImpl = jest.fn();
    const svc = new PulseMmrService({ fetchImpl });
    expect(await svc.getCurrentMmr("not-a-handle")).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("returns null for empty / nullish input", async () => {
    const svc = new PulseMmrService({ fetchImpl: jest.fn() });
    expect(await svc.getCurrentMmr(null)).toBeNull();
    expect(await svc.getCurrentMmr(undefined)).toBeNull();
    expect(await svc.getCurrentMmr("")).toBeNull();
    expect(await svc.getCurrentMmr("   ")).toBeNull();
  });

  test("getCurrentMmrByToon resolves toon → characterId via /character/search", async () => {
    const fetchImpl = jest.fn(async (url) => {
      if (url.includes("/character/search")) {
        // SC2Pulse returns the canonical id under either `character.id`
        // or `member.character.id` depending on which endpoint shape
        // the user query hits — we accept both.
        return jsonResponse([
          { member: { character: { id: 994428 } } },
        ]);
      }
      if (url.includes("/season/list/all")) {
        return jsonResponse([{ battlenetId: 60, region: "EU" }]);
      }
      return jsonResponse([
        { rating: 5100, lastPlayed: "2026-05-04T10:00:00Z" },
      ]);
    });
    const svc = new PulseMmrService({ fetchImpl });
    const out = await svc.getCurrentMmrByToon("2-S2-1-99999");
    expect(out?.mmr).toBe(5100);
    expect(out?.region).toBe("EU");
    // The resolver tries the bare toon handle first (cheapest), then
    // falls through to profile-URL forms. Either way, at least one
    // /character/search call must carry enough of the toon's identity
    // (region/realm/id) for SC2Pulse to pick the right account.
    const searchUrls = fetchImpl.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes("/character/search"));
    expect(searchUrls.length).toBeGreaterThan(0);
    const carriesIdentity = searchUrls.some(
      (u) => u.includes("2-S2-1-99999") || /profile%2F2%2F1%2F99999/.test(u),
    );
    expect(carriesIdentity).toBe(true);
  });

  test("getCurrentMmrByToon caches the toon→characterId mapping", async () => {
    const fetchImpl = jest.fn(async (url) => {
      if (url.includes("/character/search")) {
        return jsonResponse([{ character: { id: 994428 } }]);
      }
      if (url.includes("/season/list/all")) {
        return jsonResponse([{ battlenetId: 60, region: "EU" }]);
      }
      return jsonResponse([
        { rating: 5100, lastPlayed: "2026-05-04T10:00:00Z" },
      ]);
    });
    const svc = new PulseMmrService({ fetchImpl, cacheTtlMs: 60_000 });
    await svc.getCurrentMmrByToon("2-S2-1-99999");
    await svc.getCurrentMmrByToon("2-S2-1-99999");
    const searchCalls = fetchImpl.mock.calls.filter((c) =>
      String(c[0]).includes("/character/search"),
    ).length;
    // Without caching this would be 2.
    expect(searchCalls).toBe(1);
  });

  test("getCurrentMmrByToon rejects garbage handles without a network call", async () => {
    const fetchImpl = jest.fn();
    const svc = new PulseMmrService({ fetchImpl });
    expect(await svc.getCurrentMmrByToon("nope")).toBeNull();
    expect(await svc.getCurrentMmrByToon(null)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("returns most recently played team's rating + region", async () => {
    const fetchImpl = jest.fn(async (url) => {
      if (url.includes("/season/list/all")) {
        return jsonResponse([
          { battlenetId: 60, region: "US", year: 2026, number: 2 },
          { battlenetId: 60, region: "EU", year: 2026, number: 2 },
        ]);
      }
      if (url.includes("/group/team") && url.includes("characterId=994428")) {
        // US and EU share battlenetId 60, so a single ``season=60``
        // query returns both regions' teams in one response — EU is
        // more recently played and should win.
        return jsonResponse([
          { id: 1, rating: 4800, region: "US", lastPlayed: "2026-04-01T10:00:00Z" },
          { id: 2, rating: 5343, region: "EU", lastPlayed: "2026-05-01T10:00:00Z" },
        ]);
      }
      return failureResponse();
    });
    const svc = new PulseMmrService({ fetchImpl });
    const result = await svc.getCurrentMmr("994428");
    expect(result).not.toBeNull();
    expect(result?.mmr).toBe(5343);
    expect(result?.region).toBe("EU");
    // The shared battlenetId is queried exactly once (deduped), not
    // once per region.
    const teamCalls = fetchImpl.mock.calls.filter((c) =>
      String(c[0]).includes("/group/team"),
    ).length;
    expect(teamCalls).toBe(1);
  });

  test("surfaces the member's proNickname as revealedName (SC2Pulse barcode reveal)", async () => {
    // A barcode opponent whose anonymised account the community linked
    // to a known pro/main on sc2pulse.nephest.com — the /group/team
    // member carries ``proNickname``. We pull it through as
    // ``revealedName`` so the Opponents tab / overlay can label the
    // bars with the real player.
    const fetchImpl = jest.fn(async (url) => {
      if (url.includes("/season/list/all")) {
        return jsonResponse([{ battlenetId: 60, region: "US" }]);
      }
      if (url.includes("/group/team") && url.includes("characterId=4771238")) {
        return jsonResponse([
          {
            id: 9,
            rating: 5400,
            region: "US",
            lastPlayed: "2026-06-01T10:00:00Z",
            members: [{ terranGamesPlayed: 1571, proNickname: "THERIDDLER" }],
          },
        ]);
      }
      return failureResponse();
    });
    const svc = new PulseMmrService({ fetchImpl });
    const result = await svc.getCurrentMmr("4771238");
    expect(result?.mmr).toBe(5400);
    expect(result?.region).toBe("NA");
    expect(result?.revealedName).toBe("THERIDDLER");
  });

  test("revealedName is null when no member carries a proNickname", async () => {
    const fetchImpl = jest.fn(async (url) => {
      if (url.includes("/season/list/all")) {
        return jsonResponse([{ battlenetId: 60, region: "US" }]);
      }
      if (url.includes("/group/team")) {
        return jsonResponse([
          {
            id: 1,
            rating: 4800,
            region: "US",
            lastPlayed: "2026-05-01T10:00:00Z",
            members: [{ protossGamesPlayed: 200 }],
          },
        ]);
      }
      return failureResponse();
    });
    const svc = new PulseMmrService({ fetchImpl });
    const result = await svc.getCurrentMmr("994428");
    expect(result?.mmr).toBe(4800);
    expect(result?.revealedName).toBeNull();
  });

  test("surfaces the team's REAL league + tier (tierType is 0-indexed)", async () => {
    // 5124 MMR sits in the "Master 2" band of any MMR-threshold table,
    // but Blizzard assigns tiers by ladder position — this player is
    // Master TIER 1. The team row is the source of truth, not the
    // rating; the rank widget must not re-guess from MMR.
    const fetchImpl = jest.fn(async (url) => {
      if (url.includes("/season/list/all")) {
        return jsonResponse([{ battlenetId: 60, region: "US" }]);
      }
      if (url.includes("/group/team")) {
        return jsonResponse([
          {
            id: 1,
            rating: 5124,
            region: "US",
            league: 5,
            tierType: 0,
            lastPlayed: "2026-06-01T10:00:00Z",
            members: [{ protossGamesPlayed: 200 }],
          },
        ]);
      }
      return failureResponse();
    });
    const svc = new PulseMmrService({ fetchImpl });
    const result = await svc.getCurrentMmr("994428");
    expect(result?.mmr).toBe(5124);
    expect(result?.league).toBe("Master");
    expect(result?.tier).toBe(1);
  });

  test("Grandmaster teams carry no tier (GM is a single top-N bucket)", async () => {
    const fetchImpl = jest.fn(async (url) => {
      if (url.includes("/season/list/all")) {
        return jsonResponse([{ battlenetId: 60, region: "US" }]);
      }
      if (url.includes("/group/team")) {
        return jsonResponse([
          {
            id: 1,
            rating: 6100,
            region: "US",
            league: 6,
            tierType: 0,
            lastPlayed: "2026-06-01T10:00:00Z",
            members: [{ zergGamesPlayed: 900 }],
          },
        ]);
      }
      return failureResponse();
    });
    const svc = new PulseMmrService({ fetchImpl });
    const result = await svc.getCurrentMmr("994428");
    expect(result?.league).toBe("Grandmaster");
    expect(result?.tier).toBeNull();
  });

  test("league + tier are null when the team row omits them", async () => {
    const fetchImpl = jest.fn(async (url) => {
      if (url.includes("/season/list/all")) {
        return jsonResponse([{ battlenetId: 60, region: "US" }]);
      }
      if (url.includes("/group/team")) {
        return jsonResponse([
          { id: 1, rating: 4800, region: "US", lastPlayed: "2026-05-01T10:00:00Z" },
        ]);
      }
      return failureResponse();
    });
    const svc = new PulseMmrService({ fetchImpl });
    const result = await svc.getCurrentMmr("994428");
    expect(result?.mmr).toBe(4800);
    expect(result?.league).toBeNull();
    expect(result?.tier).toBeNull();
  });

  test("getCurrentMmrForAny carries league + tier from the winning team", async () => {
    const fetchImpl = jest.fn(async (url) => {
      if (url.includes("/season/list/all")) {
        return jsonResponse([{ battlenetId: 60, region: "EU" }]);
      }
      if (url.includes("/group/team")) {
        return jsonResponse([
          {
            id: 7,
            rating: 5210,
            region: "EU",
            league: 5,
            tierType: 0,
            lastPlayed: "2026-06-02T10:00:00Z",
            members: [{ terranGamesPlayed: 431 }],
          },
        ]);
      }
      return failureResponse();
    });
    const svc = new PulseMmrService({ fetchImpl });
    const out = await svc.getCurrentMmrForAny(["994428"], {
      preferredRegion: "EU",
    });
    expect(out?.mmr).toBe(5210);
    expect(out?.league).toBe("Master");
    expect(out?.tier).toBe(1);
  });

  test("uses team.region for the label so cross-region duplicates don't mis-tag (2026-05 fix)", async () => {
    // SC2Pulse's /group/team filters by ``battlenetId``, which is the
    // SAME number across regions for the same season (NA's S67, EU's
    // S67 and KR's S67 all share battlenetId=67). Each region query
    // therefore returns the same team(s), and the loop variable's
    // regionCode is the WRONG label for any team that didn't actually
    // belong to the queried region. The fix: read region from
    // ``team.region`` and dedupe by ``team.id``.
    //
    // This scenario: an NA-only character. /season/list/all returns
    // seasons for NA, EU and KR all with battlenetId=67. Every region
    // query returns the same NA team (Pulse joins by battlenetId).
    // Before the fix, the dashboard tagged that team with the LAST
    // region iterated (KR). After: team.region wins.
    const naTeam = {
      id: 700001,
      region: "US",
      rating: 5459,
      lastPlayed: "2026-05-10T10:00:00Z",
    };
    const fetchImpl = jest.fn(async (url) => {
      if (url.includes("/season/list/all")) {
        return jsonResponse([
          { battlenetId: 67, region: "US", year: 2026, number: 67 },
          { battlenetId: 67, region: "EU", year: 2026, number: 67 },
          { battlenetId: 67, region: "KR", year: 2026, number: 67 },
        ]);
      }
      if (url.includes("/group/team") && url.includes("characterId=994428")) {
        // Whichever region we're querying, Pulse returns the same
        // NA team because battlenetId collides.
        return jsonResponse([naTeam]);
      }
      return failureResponse();
    });
    const svc = new PulseMmrService({ fetchImpl });
    const result = await svc.getCurrentMmr("994428");
    expect(result?.mmr).toBe(5459);
    expect(result?.region).toBe("NA");
  });

  test("dedupes the same team.id across multiple region queries", async () => {
    // Same scenario as above, but with two distinct teams to confirm
    // we end up with TWO candidates (not 6 = 2 teams × 3 regions).
    // The "winner" should be the team with the most recent lastPlayed.
    const naTeam = {
      id: 700001,
      region: "US",
      rating: 5459,
      lastPlayed: "2026-05-10T10:00:00Z",
    };
    const euTeam = {
      id: 700002,
      region: "EU",
      rating: 5172,
      lastPlayed: "2026-05-12T10:00:00Z", // more recent → wins
    };
    const fetchImpl = jest.fn(async (url) => {
      if (url.includes("/season/list/all")) {
        return jsonResponse([
          { battlenetId: 67, region: "US" },
          { battlenetId: 67, region: "EU" },
          { battlenetId: 67, region: "KR" },
        ]);
      }
      if (url.includes("/group/team")) {
        // Every region query returns BOTH teams (Pulse's
        // battlenetId-shared join). After dedup we expect a single
        // pick: EU because lastPlayed is most recent.
        return jsonResponse([naTeam, euTeam]);
      }
      return failureResponse();
    });
    const svc = new PulseMmrService({ fetchImpl });
    const result = await svc.getCurrentMmr("994428");
    expect(result?.mmr).toBe(5172);
    expect(result?.region).toBe("EU");
    // Also confirm the preferredRegion hint still works correctly
    // with the team.region path — pass region="NA" and the NA team
    // wins despite being older.
    svc._cache.clear();
    svc._seasonCache.clear();
    const pinned = await svc.getCurrentMmrForAny(["994428"], {
      preferredRegion: "NA",
    });
    expect(pinned?.mmr).toBe(5459);
    expect(pinned?.region).toBe("NA");
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

  test("getCurrentMmrByToon walks fallback term forms when the first misses", async () => {
    // SC2Pulse only matches the streamer's toon handle on the
    // ``starcraft2.blizzard.com`` form (e.g. because the bare handle
    // wasn't indexed for this character yet). The resolver must keep
    // trying the URL forms instead of giving up after the first miss.
    const fetchImpl = jest.fn(async (url) => {
      if (url.includes("/character/search")) {
        // The bare-handle form (term=1-S2-1-267727) returns nothing.
        // The starcraft2.com URL also returns nothing. Only the legacy
        // starcraft2.blizzard.com URL matches.
        if (url.includes("starcraft2.blizzard.com")) {
          return jsonResponse([{ character: { id: 452727 } }]);
        }
        return jsonResponse([]);
      }
      if (url.includes("/season/list/all")) {
        return jsonResponse([{ battlenetId: 60, region: "US" }]);
      }
      return jsonResponse([
        { rating: 5343, lastPlayed: "2026-05-06T10:00:00Z" },
      ]);
    });
    const svc = new PulseMmrService({ fetchImpl });
    const out = await svc.getCurrentMmrByToon("1-S2-1-267727");
    expect(out?.mmr).toBe(5343);
    // All three search URL forms should have been tried in order.
    const searchUrls = fetchImpl.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes("/character/search"));
    expect(searchUrls.length).toBe(3);
    expect(searchUrls[0]).toMatch(/term=1-S2-1-267727/);
    expect(searchUrls[1]).toMatch(/starcraft2\.com/);
    expect(searchUrls[2]).toMatch(/starcraft2\.blizzard\.com/);
  });

  test("getCurrentMmrByToon prefers the bare toon handle when SC2Pulse matches it", async () => {
    // Happy path: SC2Pulse's TOON_HANDLE term type matches the bare
    // handle directly, so we don't pay the cost of constructing or
    // probing two profile URLs that won't be needed.
    const fetchImpl = jest.fn(async (url) => {
      if (url.includes("/character/search")) {
        return jsonResponse([{ character: { id: 452727 } }]);
      }
      if (url.includes("/season/list/all")) {
        return jsonResponse([{ battlenetId: 60, region: "US" }]);
      }
      return jsonResponse([
        { rating: 4500, lastPlayed: "2026-05-01T10:00:00Z" },
      ]);
    });
    const svc = new PulseMmrService({ fetchImpl });
    await svc.getCurrentMmrByToon("1-S2-1-267727");
    const searchUrls = fetchImpl.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes("/character/search"));
    // Exactly one /character/search call when the bare-handle form
    // resolves on the first try — no extra round-trips.
    expect(searchUrls).toHaveLength(1);
    expect(searchUrls[0]).toMatch(/term=1-S2-1-267727/);
  });

  test("extractCharacterId handles the team-shaped members[] response", async () => {
    // Some SC2Pulse responses come back wrapped in a team object with
    // a ``members`` array — we have to dig into ``members[*].character``
    // to find the canonical id.
    const fetchImpl = jest.fn(async (url) => {
      if (url.includes("/character/search")) {
        return jsonResponse([
          {
            members: [
              { character: { id: 994428, battlenetId: 99999 } },
            ],
          },
        ]);
      }
      if (url.includes("/season/list/all")) {
        return jsonResponse([{ battlenetId: 60, region: "EU" }]);
      }
      return jsonResponse([
        { rating: 5050, lastPlayed: "2026-05-06T10:00:00Z" },
      ]);
    });
    const svc = new PulseMmrService({ fetchImpl });
    const out = await svc.getCurrentMmrByToon("2-S2-1-99999");
    expect(out?.mmr).toBe(5050);
  });

  test("extractCharacterId handles the modern members{} singular-object response", async () => {
    // The live ``/character/search`` endpoint returns a
    // ``LadderDistinctCharacter`` whose ``members`` is a SINGULAR object
    // (not an array), with the canonical id under ``members.character``.
    // Before the fix this shape resolved to null and the toon-only MMR
    // path returned "— MMR" until the cloud resolver healed it later.
    const fetchImpl = jest.fn(async (url) => {
      if (url.includes("/character/search")) {
        return jsonResponse([
          {
            leagueMax: 5,
            ratingMax: 4600,
            members: { character: { id: 455840, battlenetId: 4298860 } },
          },
        ]);
      }
      if (url.includes("/season/list/all")) {
        return jsonResponse([{ battlenetId: 60, region: "US" }]);
      }
      return jsonResponse([
        { rating: 4508, region: 1, lastPlayed: "2026-05-24T10:00:00Z" },
      ]);
    });
    const svc = new PulseMmrService({ fetchImpl });
    const out = await svc.getCurrentMmrByToon("1-S2-1-4298860");
    expect(out?.mmr).toBe(4508);
    expect(out?.region).toBe("NA");
  });

  test("getCurrentMmrForAny batches every id into a single per-region team call", async () => {
    // The streamer has three saved chips: a NA toon and two numeric
    // SC2Pulse ids on EU. The session widget should pay one
    // /character/search round-trip (only for the toon) and one
    // /group/team call PER REGION carrying every numeric id — not three
    // round-trips per region — so adding a tenth chip costs nothing.
    /** @type {string[]} */
    const groupTeamUrls = [];
    const fetchImpl = jest.fn(async (url) => {
      if (url.includes("/character/search")) {
        return jsonResponse([{ character: { id: 111111 } }]);
      }
      if (url.includes("/season/list/all")) {
        return jsonResponse([
          { battlenetId: 60, region: "US" },
          { battlenetId: 61, region: "EU" },
        ]);
      }
      if (url.includes("/group/team")) {
        groupTeamUrls.push(String(url));
        // EU returns the more recently played team, so it should win.
        if (url.includes("season=61")) {
          return jsonResponse([
            { rating: 5343, lastPlayed: "2026-05-08T00:00:00Z" },
          ]);
        }
        return jsonResponse([
          { rating: 4500, lastPlayed: "2026-04-15T00:00:00Z" },
        ]);
      }
      return failureResponse();
    });
    const svc = new PulseMmrService({ fetchImpl });
    const out = await svc.getCurrentMmrForAny([
      "1-S2-1-267727",
      "994428",
      "8970877",
    ]);
    expect(out?.mmr).toBe(5343);
    expect(out?.region).toBe("EU");
    // One call per region. Each call carries all three numeric ids
    // (toon-resolved 111111 + 994428 + 8970877) as repeated
    // ``characterId`` query params.
    expect(groupTeamUrls).toHaveLength(2);
    for (const url of groupTeamUrls) {
      expect(url).toMatch(/characterId=111111/);
      expect(url).toMatch(/characterId=994428/);
      expect(url).toMatch(/characterId=8970877/);
    }
  });

  test("getCurrentMmrForAny picks the most-recently-played team across the union", async () => {
    // Three pulse ids; SC2Pulse returns a team for each on different
    // regions with different last-played dates. The streamer is
    // currently grinding EU, so even though the NA team has higher MMR
    // the resolver must pin to the EU team because it was played most
    // recently — that's what the session widget anchors its region row
    // against.
    const fetchImpl = jest.fn(async (url) => {
      if (url.includes("/season/list/all")) {
        return jsonResponse([
          { battlenetId: 60, region: "US" },
          { battlenetId: 61, region: "EU" },
        ]);
      }
      if (url.includes("/group/team")) {
        if (url.includes("season=60")) {
          // NA team — high rating but stale.
          return jsonResponse([
            { rating: 6000, lastPlayed: "2026-04-01T00:00:00Z" },
          ]);
        }
        // EU team — current grind.
        return jsonResponse([
          { rating: 5200, lastPlayed: "2026-05-08T00:00:00Z" },
        ]);
      }
      return failureResponse();
    });
    const svc = new PulseMmrService({ fetchImpl });
    const out = await svc.getCurrentMmrForAny(["994428", "8970877"]);
    expect(out?.mmr).toBe(5200);
    expect(out?.region).toBe("EU");
  });

  test("getCurrentMmrForAny returns null on empty / nullish input without a network call", async () => {
    const fetchImpl = jest.fn();
    const svc = new PulseMmrService({ fetchImpl });
    expect(await svc.getCurrentMmrForAny([])).toBeNull();
    expect(await svc.getCurrentMmrForAny(null)).toBeNull();
    expect(await svc.getCurrentMmrForAny(undefined)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("getCurrentMmrForAny skips garbage entries and resolves the rest", async () => {
    // Mixed valid/invalid input: a numeric id, a toon, a stray empty
    // string, and a malformed handle. The valid two should still drive
    // a successful resolve.
    const fetchImpl = jest.fn(async (url) => {
      if (url.includes("/character/search")) {
        return jsonResponse([{ character: { id: 222222 } }]);
      }
      if (url.includes("/season/list/all")) {
        return jsonResponse([{ battlenetId: 60, region: "US" }]);
      }
      return jsonResponse([
        { rating: 4800, lastPlayed: "2026-05-01T00:00:00Z" },
      ]);
    });
    const svc = new PulseMmrService({ fetchImpl });
    const out = await svc.getCurrentMmrForAny([
      "994428",
      "",
      "not-a-handle",
      "1-S2-1-99999",
      null,
    ]);
    expect(out?.mmr).toBe(4800);
  });

  test("getCurrentMmrForAny returns null when nothing in the list normalises", async () => {
    const fetchImpl = jest.fn();
    const svc = new PulseMmrService({ fetchImpl });
    const out = await svc.getCurrentMmrForAny(["", "garbage", null]);
    expect(out).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("getCurrentMmrForAny prefers the caller-supplied region over SC2Pulse's lastPlayed sort", async () => {
    // The streamer's most recent replay was on NA, but their SC2Pulse
    // chips include a numeric id whose KR team was touched yesterday.
    // Without a preferred-region hint, SC2Pulse's globally-most-recent
    // sort picks the KR team and the overlay paints "KR 5377" — wrong.
    // With ``preferredRegion: "NA"`` the resolver pins to NA whenever a
    // team exists there, regardless of the KR team being more recent
    // by SC2Pulse's lastPlayed clock.
    const fetchImpl = jest.fn(async (url) => {
      if (url.includes("/season/list/all")) {
        return jsonResponse([
          { battlenetId: 60, region: "US" },
          { battlenetId: 61, region: "KR" },
        ]);
      }
      if (url.includes("/group/team")) {
        if (url.includes("season=60")) {
          // NA team — slightly older lastPlayed.
          return jsonResponse([
            { rating: 5100, lastPlayed: "2026-05-07T12:00:00Z" },
          ]);
        }
        // KR team — more recent globally.
        return jsonResponse([
          { rating: 5377, lastPlayed: "2026-05-08T08:00:00Z" },
        ]);
      }
      return failureResponse();
    });
    const svc = new PulseMmrService({ fetchImpl });
    const out = await svc.getCurrentMmrForAny(
      ["994428", "8970877"],
      { preferredRegion: "NA" },
    );
    expect(out?.mmr).toBe(5100);
    expect(out?.region).toBe("NA");
  });

  test("getCurrentMmrForAny falls back to global sort when the preferred region has no team", async () => {
    // The streamer asked for NA but their chips only resolve teams on
    // KR. We must still return SOMETHING — picking the global most-
    // recent rather than going blank — so the overlay's MMR row stays
    // populated even when the preferred-region hint misses.
    const fetchImpl = jest.fn(async (url) => {
      if (url.includes("/season/list/all")) {
        return jsonResponse([
          { battlenetId: 60, region: "US" },
          { battlenetId: 61, region: "KR" },
        ]);
      }
      if (url.includes("/group/team")) {
        if (url.includes("season=60")) {
          return jsonResponse([]); // no NA team
        }
        return jsonResponse([
          { rating: 5377, lastPlayed: "2026-05-08T08:00:00Z" },
        ]);
      }
      return failureResponse();
    });
    const svc = new PulseMmrService({ fetchImpl });
    const out = await svc.getCurrentMmrForAny(
      ["8970877"],
      { preferredRegion: "NA" },
    );
    expect(out?.mmr).toBe(5377);
    expect(out?.region).toBe("KR");
  });

  test("getCurrentMmrForAny picks most-recently-played within the preferred region", async () => {
    // Multiple teams in the preferred region — pick the freshest one
    // (e.g. a streamer who has both a 2v2 archive team and an active
    // 1v1 team on NA shouldn't see the stale archive bubble up just
    // because it's first in the response array).
    const fetchImpl = jest.fn(async (url) => {
      if (url.includes("/season/list/all")) {
        return jsonResponse([{ battlenetId: 60, region: "US" }]);
      }
      if (url.includes("/group/team")) {
        return jsonResponse([
          { rating: 4800, lastPlayed: "2026-04-01T10:00:00Z" }, // stale
          { rating: 5200, lastPlayed: "2026-05-08T10:00:00Z" }, // current
        ]);
      }
      return failureResponse();
    });
    const svc = new PulseMmrService({ fetchImpl });
    const out = await svc.getCurrentMmrForAny(
      ["994428"],
      { preferredRegion: "NA" },
    );
    expect(out?.mmr).toBe(5200);
    expect(out?.region).toBe("NA");
  });

  test("getCurrentMmrForAny preferred-region hint is part of the cache key", async () => {
    // A streamer who actually flips region mid-day shouldn't keep
    // seeing the prior region's MMR until the 5-minute TTL elapses.
    // Different ``preferredRegion`` values must resolve to different
    // cache slots so a fresh fetch happens on the flip.
    let teamCalls = 0;
    const fetchImpl = jest.fn(async (url) => {
      if (url.includes("/season/list/all")) {
        return jsonResponse([
          { battlenetId: 60, region: "US" },
          { battlenetId: 61, region: "EU" },
        ]);
      }
      if (url.includes("/group/team")) {
        teamCalls += 1;
        if (url.includes("season=60")) {
          return jsonResponse([
            { rating: 5100, lastPlayed: "2026-05-07T12:00:00Z" },
          ]);
        }
        return jsonResponse([
          { rating: 5300, lastPlayed: "2026-05-08T08:00:00Z" },
        ]);
      }
      return failureResponse();
    });
    const svc = new PulseMmrService({ fetchImpl, cacheTtlMs: 60_000 });
    const na = await svc.getCurrentMmrForAny(["994428"], {
      preferredRegion: "NA",
    });
    const eu = await svc.getCurrentMmrForAny(["994428"], {
      preferredRegion: "EU",
    });
    expect(na?.region).toBe("NA");
    expect(eu?.region).toBe("EU");
    // Two distinct cache slots → two team-call rounds (each round =
    // 2 region probes). The first fill missed the cache; the second
    // fill missed too because the cache key differs.
    expect(teamCalls).toBe(4);
  });

  test("getCurrentMmrForAny caches the joint lookup order-insensitively", async () => {
    let teamCalls = 0;
    const fetchImpl = jest.fn(async (url) => {
      if (url.includes("/season/list/all")) {
        return jsonResponse([{ battlenetId: 60, region: "US" }]);
      }
      if (url.includes("/group/team")) {
        teamCalls += 1;
        return jsonResponse([
          { rating: 4800, lastPlayed: "2026-05-01T00:00:00Z" },
        ]);
      }
      return failureResponse();
    });
    const svc = new PulseMmrService({ fetchImpl, cacheTtlMs: 60_000 });
    const a = await svc.getCurrentMmrForAny(["994428", "8970877"]);
    // Reordered list — same logical set, must hit the cache.
    const b = await svc.getCurrentMmrForAny(["8970877", "994428"]);
    expect(a?.mmr).toBe(4800);
    expect(b?.mmr).toBe(4800);
    expect(teamCalls).toBe(1);
  });

  test("getCurrentMmrForAny forceRefresh bypasses a live cache entry", async () => {
    let teamCalls = 0;
    const fetchImpl = jest.fn(async (url) => {
      if (url.includes("/season/list/all")) {
        return jsonResponse([{ battlenetId: 60, region: "US" }]);
      }
      if (url.includes("/group/team")) {
        teamCalls += 1;
        return jsonResponse([
          {
            rating: teamCalls === 1 ? 4800 : 4821,
            lastPlayed: "2026-05-01T00:00:00Z",
          },
        ]);
      }
      return failureResponse();
    });
    const svc = new PulseMmrService({ fetchImpl, cacheTtlMs: 60_000 });
    const before = await svc.getCurrentMmrForAny(["994428"], {
      preferredRegion: "NA",
    });
    const after = await svc.getCurrentMmrForAny(["994428"], {
      preferredRegion: "NA",
      forceRefresh: true,
    });
    expect(before?.mmr).toBe(4800);
    expect(after?.mmr).toBe(4821);
    expect(teamCalls).toBe(2);
  });

  test("concurrent reordered account sets share one upstream fetch and JSON parse", async () => {
    let releaseTeam;
    const teamReady = new Promise((resolve) => {
      releaseTeam = resolve;
    });
    const fetchImpl = jest.fn(async (url) => {
      if (url.includes("/season/list/all")) {
        return jsonResponse([{ battlenetId: 60, region: "US" }]);
      }
      if (url.includes("/group/team")) {
        await teamReady;
        return jsonResponse([
          {
            rating: 4821,
            region: "US",
            lastPlayed: "2026-08-13T20:30:00Z",
          },
        ]);
      }
      return failureResponse();
    });
    const svc = new PulseMmrService({ fetchImpl });
    const a = svc.getCurrentMmrForAny(["994428", "8970877"]);
    const b = svc.getCurrentMmrForAny(["8970877", "994428"]);
    await new Promise((resolve) => setImmediate(resolve));
    releaseTeam();

    await expect(Promise.all([a, b])).resolves.toEqual([
      expect.objectContaining({ mmr: 4821, region: "NA" }),
      expect.objectContaining({ mmr: 4821, region: "NA" }),
    ]);
    const seasonCalls = fetchImpl.mock.calls.filter((call) =>
      String(call[0]).includes("/season/list/all"));
    const teamCalls = fetchImpl.mock.calls.filter((call) =>
      String(call[0]).includes("/group/team"));
    expect(seasonCalls).toHaveLength(1);
    expect(teamCalls).toHaveLength(1);
  });

  test("rejects a streamed JSON response above the decompressed byte cap", async () => {
    const payload = JSON.stringify({ rows: ["x".repeat(256)] });
    const svc = new PulseMmrService({
      responseMaxBytes: 64,
      fetchImpl: jest.fn(async () => new Response(payload, { status: 200 })),
    });
    await expect(
      svc._getJson("https://pulse.invalid/oversize", { throwOnError: true }),
    ).rejects.toMatchObject({ code: "PULSE_RESPONSE_TOO_LARGE" });
  });

  test("parses a streamed JSON response that stays under the byte cap", async () => {
    const payload = { rows: [{ rating: 4821 }] };
    const svc = new PulseMmrService({
      responseMaxBytes: 1024,
      fetchImpl: jest.fn(async () =>
        new Response(JSON.stringify(payload), { status: 200 })),
    });
    await expect(
      svc._getJson("https://pulse.invalid/small", { throwOnError: true }),
    ).resolves.toEqual(payload);
  });

  test("admits at most two distinct Pulse fetch/parses process-wide", async () => {
    const releases = [];
    const makeService = () => new PulseMmrService({
      fetchImpl: jest.fn(() => new Promise((resolve) => {
        releases.push(() => resolve(jsonResponse({ ok: true })));
      })),
    });
    const a = makeService();
    const b = makeService();
    const c = makeService();
    const first = a._getJson("https://pulse.invalid/a", { throwOnError: true });
    const second = b._getJson("https://pulse.invalid/b", { throwOnError: true });
    await new Promise((resolve) => setImmediate(resolve));

    await expect(
      c._getJson("https://pulse.invalid/c", { throwOnError: true }),
    ).rejects.toMatchObject({ code: "PULSE_ADMISSION_BUSY" });
    expect(releases).toHaveLength(2);
    releases.splice(0).forEach((release) => release());
    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true },
      { ok: true },
    ]);
  });

  test("hard-caps and sweeps the in-process MMR cache", () => {
    let now = 1_000;
    const svc = new PulseMmrService({
      now: () => now,
      cacheTtlMs: 100,
      mmrCacheMaxEntries: 2,
    });
    svc._setMmrCache("a", { mmr: 1, region: "NA", fetchedAt: now });
    svc._setMmrCache("b", { mmr: 2, region: "NA", fetchedAt: now });
    svc._setMmrCache("c", { mmr: 3, region: "NA", fetchedAt: now });
    expect([...svc._cache.keys()]).toEqual(["b", "c"]);

    now += 60 * 60 * 1000 + 101;
    svc._setMmrCache("fresh", {
      mmr: 4,
      region: "NA",
      fetchedAt: now,
    });
    expect([...svc._cache.keys()]).toEqual(["fresh"]);
  });

  test("extractCharacterId falls back to character.battlenetId when id is absent", async () => {
    // Older Pulse responses occasionally omit the internal `id`
    // and only ship the Blizzard-side `battlenetId`; that still
    // lets us key the team scan, so accept it.
    const fetchImpl = jest.fn(async (url) => {
      if (url.includes("/character/search")) {
        return jsonResponse([{ character: { battlenetId: 994428 } }]);
      }
      if (url.includes("/season/list/all")) {
        return jsonResponse([{ battlenetId: 60, region: "EU" }]);
      }
      return jsonResponse([
        { rating: 4900, lastPlayed: "2026-05-06T10:00:00Z" },
      ]);
    });
    const svc = new PulseMmrService({ fetchImpl });
    const out = await svc.getCurrentMmrByToon("2-S2-1-99999");
    expect(out?.mmr).toBe(4900);
  });

  describe("getRaceBreakdown", () => {
    test("groups 1v1 teams by race, best rating per race, sorted desc", async () => {
      // Mirrors the real PiLiPiLi case: a Protoss main (highest MMR)
      // who also queues Zerg + Terran. The single-number path would
      // collapse to whichever was played most recently; the breakdown
      // keeps every race so the UI can show the higher Protoss.
      const fetchImpl = jest.fn(async (url) => {
        if (url.includes("/season/list/all")) {
          return jsonResponse([{ battlenetId: 60, region: "US" }]);
        }
        if (url.includes("/group/team")) {
          return jsonResponse([
            {
              id: 1, rating: 5584, region: 1, league: 5,
              lastPlayed: "2026-05-20T00:00:00Z",
              members: [{ protossGamesPlayed: 7387 }],
            },
            {
              id: 2, rating: 5081, region: 1, league: 5,
              lastPlayed: "2026-05-25T00:00:00Z", // most recent, but lower
              members: [{ zergGamesPlayed: 1163 }],
            },
            {
              id: 3, rating: 4667, region: 1, league: 4,
              lastPlayed: "2026-05-10T00:00:00Z",
              members: [{ terranGamesPlayed: 509 }],
            },
          ]);
        }
        return jsonResponse([]);
      });
      const svc = new PulseMmrService({ fetchImpl });
      const races = await svc.getRaceBreakdown(["994428"]);
      expect(races.map((r) => r.race)).toEqual(["Protoss", "Zerg", "Terran"]);
      expect(races[0]).toMatchObject({
        race: "Protoss", mmr: 5584, games: 7387, league: "Master",
      });
      expect(races.find((r) => r.race === "Zerg")).toMatchObject({
        mmr: 5081, games: 1163,
      });
      expect(races.find((r) => r.race === "Terran")).toMatchObject({
        mmr: 4667, league: "Diamond",
      });
    });

    test("keeps the highest-rated team when a race appears twice (multi-region)", async () => {
      const fetchImpl = jest.fn(async (url) => {
        if (url.includes("/season/list/all")) {
          return jsonResponse([
            { battlenetId: 60, region: "US" },
            { battlenetId: 60, region: "EU" },
          ]);
        }
        if (url.includes("/group/team")) {
          // battlenetId collides across regions, so each region query
          // returns both teams; the region-match filter keeps each in
          // its own iteration.
          return jsonResponse([
            { id: 1, rating: 4800, region: 1, league: 4, members: [{ zergGamesPlayed: 100 }] },
            { id: 2, rating: 5200, region: 2, league: 5, members: [{ zergGamesPlayed: 50 }] },
          ]);
        }
        return jsonResponse([]);
      });
      const svc = new PulseMmrService({ fetchImpl });
      const races = await svc.getRaceBreakdown(["994428"]);
      expect(races).toHaveLength(1);
      expect(races[0]).toMatchObject({ race: "Zerg", mmr: 5200 });
    });

    test("ignores stale cross-region teams from a colliding season id (CN-season bug)", async () => {
      // Regression for PiLiPiLi: CN's CURRENT season (battlenetId 54)
      // equals an ANCIENT NA season number, so /group/team?season=54
      // returns this NA character's years-old season-54 teams. Those
      // had a higher Protoss peak (5920) than the live 5584 — and the
      // per-race breakdown picks the highest rating per race, so
      // without the region-match guard the headline showed the stale
      // peak instead of the current rating.
      const fetchImpl = jest.fn(async (url) => {
        if (url.includes("/season/list/all")) {
          return jsonResponse([
            { battlenetId: 67, region: "US" },
            { battlenetId: 54, region: "CN" },
          ]);
        }
        if (url.includes("season=67")) {
          return jsonResponse([
            {
              id: 10, rating: 5584, region: 1, league: 5,
              lastPlayed: "2026-05-02T04:08:13Z",
              members: [{ protossGamesPlayed: 23 }],
            },
          ]);
        }
        if (url.includes("season=54")) {
          // The NA character's ancient season-54 team, surfaced only
          // because CN's current season shares battlenetId 54.
          return jsonResponse([
            {
              id: 11, rating: 5920, region: 1, league: 5,
              lastPlayed: null,
              members: [{ protossGamesPlayed: 104 }],
            },
          ]);
        }
        return jsonResponse([]);
      });
      const svc = new PulseMmrService({ fetchImpl });
      const races = await svc.getRaceBreakdown(["107665"]);
      expect(races).toHaveLength(1);
      expect(races[0]).toMatchObject({ race: "Protoss", mmr: 5584, games: 23 });
    });

    test("returns [] when the character has no 1v1 teams", async () => {
      const fetchImpl = jest.fn(async (url) => {
        if (url.includes("/season/list/all")) {
          return jsonResponse([{ battlenetId: 60, region: "US" }]);
        }
        return jsonResponse([]);
      });
      const svc = new PulseMmrService({ fetchImpl });
      expect(await svc.getRaceBreakdown(["994428"])).toEqual([]);
      await expect(svc.getRaceBreakdown(["994428"], { throwOnError: true }))
        .resolves.toEqual([]);
    });

    test("strict lookups distinguish a transport failure from an empty team list", async () => {
      const fetchImpl = jest.fn(async () => {
        throw new Error("Pulse unavailable");
      });
      const svc = new PulseMmrService({ fetchImpl });

      await expect(svc.getRaceBreakdown(["994428"])).resolves.toEqual([]);
      await expect(svc.getRaceBreakdown(["994428"], { throwOnError: true }))
        .rejects.toThrow("Pulse unavailable");
    });

    test("with a region hint, queries only that region's season (one call)", async () => {
      const fetchImpl = jest.fn(async (url) => {
        if (url.includes("/season/list/all")) {
          return jsonResponse([
            { battlenetId: 67, region: "US" },
            { battlenetId: 67, region: "EU" },
            { battlenetId: 67, region: "KR" },
            { battlenetId: 54, region: "CN" },
          ]);
        }
        if (url.includes("season=67")) {
          return jsonResponse([
            { id: 1, rating: 5584, region: 1, league: 5, members: [{ protossGamesPlayed: 23 }] },
          ]);
        }
        return jsonResponse([]);
      });
      const svc = new PulseMmrService({ fetchImpl });
      const races = await svc.getRaceBreakdown(["994428"], {
        preferredRegion: "NA",
      });
      expect(races).toEqual([
        { race: "Protoss", mmr: 5584, games: 23, league: "Master", region: "NA" },
      ]);
      // Exactly one /group/team call — NA's season 67 — not one per region.
      const teamCalls = fetchImpl.mock.calls.filter((c) =>
        String(c[0]).includes("/group/team"),
      );
      expect(teamCalls).toHaveLength(1);
      expect(String(teamCalls[0][0])).toContain("season=67");
    });

    test("without a hint, dedupes the shared season id to one call per distinct season", async () => {
      // NA/EU/KR all share battlenetId 67; CN is 54. That's 4 regions
      // but only 2 distinct seasons, so 2 calls (not 4).
      const fetchImpl = jest.fn(async (url) => {
        if (url.includes("/season/list/all")) {
          return jsonResponse([
            { battlenetId: 67, region: "US" },
            { battlenetId: 67, region: "EU" },
            { battlenetId: 67, region: "KR" },
            { battlenetId: 54, region: "CN" },
          ]);
        }
        if (url.includes("season=67")) {
          return jsonResponse([
            { id: 1, rating: 5584, region: 1, league: 5, members: [{ protossGamesPlayed: 23 }] },
          ]);
        }
        return jsonResponse([]);
      });
      const svc = new PulseMmrService({ fetchImpl });
      const races = await svc.getRaceBreakdown(["994428"]);
      expect(races).toEqual([
        { race: "Protoss", mmr: 5584, games: 23, league: "Master", region: "NA" },
      ]);
      const teamCalls = fetchImpl.mock.calls.filter((c) =>
        String(c[0]).includes("/group/team"),
      );
      expect(teamCalls).toHaveLength(2); // season 67 + season 54
    });

    test("caches the breakdown for the (long) race TTL", async () => {
      const fetchImpl = jest.fn(async (url) => {
        if (url.includes("/season/list/all")) {
          return jsonResponse([{ battlenetId: 67, region: "US" }]);
        }
        return jsonResponse([
          { id: 1, rating: 5584, region: 1, league: 5, members: [{ protossGamesPlayed: 23 }] },
        ]);
      });
      let now = 1_000_000;
      const svc = new PulseMmrService({
        fetchImpl,
        raceCacheTtlMs: 60 * 60 * 1000,
        now: () => now,
      });
      await svc.getRaceBreakdown(["994428"], { preferredRegion: "NA" });
      now += 30 * 60 * 1000; // +30 min, within the 1h TTL
      await svc.getRaceBreakdown(["994428"], { preferredRegion: "NA" });
      const teamCalls = fetchImpl.mock.calls.filter((c) =>
        String(c[0]).includes("/group/team"),
      );
      expect(teamCalls).toHaveLength(1); // second open served from cache
    });
  });
});
