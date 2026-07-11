// @ts-nocheck
"use strict";

const {
  PulseOpponentIntelService,
} = require("../src/services/pulseOpponentIntel");

/**
 * Shape-accurate /character/{id}/common fixture (columns + teams +
 * pro + linked), mirroring a live response captured 2026-07-11.
 */
function commonPayload() {
  return {
    history: {
      rating: [3900, 3950, 4020, 4100],
      dateTime: [
        "2026-06-01T10:00:00Z",
        "2026-06-10T10:00:00Z",
        "2026-06-20T10:00:00Z",
        "2026-07-01T10:00:00Z",
      ],
      leagueType: [4, 4, 5, 5],
      globalRank: [9000, 8200, 4100, 2600],
      globalTeamCount: [65000, 65000, 65000, 65000],
    },
    teams: [
      {
        rating: 4100,
        wins: 60,
        losses: 40,
        season: 67,
        region: "EU",
        league: { type: 5, queueType: 201, teamType: 0 },
        tierType: 1,
        globalRank: 2600,
        lastPlayed: "2026-07-01T10:00:00Z",
      },
      // Older season + a non-1v1 team that must both be ignored.
      {
        rating: 4300,
        wins: 10,
        losses: 5,
        season: 66,
        region: "EU",
        league: { type: 5, queueType: 201, teamType: 0 },
        tierType: 0,
        globalRank: 900,
        lastPlayed: "2026-03-01T10:00:00Z",
      },
      {
        rating: 3000,
        wins: 3,
        losses: 1,
        season: 67,
        region: "EU",
        league: { type: 3, queueType: 202, teamType: 0 },
        tierType: 2,
        lastPlayed: "2026-07-02T10:00:00Z",
      },
    ],
    linkedDistinctCharacters: [
      {
        leagueMax: 6,
        ratingMax: 4350,
        totalGamesPlayed: 2100,
        members: { character: { id: 111, region: "EU", name: "Foe#123" } },
      },
      {
        leagueMax: 5,
        ratingMax: 4100,
        totalGamesPlayed: 300,
        members: { character: { id: 222, region: "US", name: "Smurf#456" } },
      },
    ],
    proPlayer: {
      proPlayer: {
        nickname: "Foe",
        name: "For Example",
        country: "FI",
        earnings: 12345,
      },
      proTeam: { name: "Team X" },
      links: [
        { type: "TWITCH", url: "https://twitch.tv/foe" },
        { type: "ALIGULAC", url: "http://aligulac.com/players/1" },
      ],
    },
  };
}

/** @param {object|Error} result */
function fakeFetch(result) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    if (result instanceof Error) throw result;
    return {
      ok: true,
      json: async () => result,
    };
  };
  return { impl, calls };
}

describe("PulseOpponentIntelService", () => {
  test("normalises the /common payload into the dossier card shape", async () => {
    const { impl, calls } = fakeFetch(commonPayload());
    const svc = new PulseOpponentIntelService({ fetchImpl: impl });
    const intel = await svc.getIntel("111");

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/character/111/common");

    expect(intel.region).toBe("EU");
    // Most recently played 1v1 team wins; the 202-queue team and the
    // stale season-66 team are ignored.
    expect(intel.current).toMatchObject({
      rating: 4100,
      wins: 60,
      losses: 40,
      season: 67,
    });
    expect(intel.league).toEqual({ type: 5, label: "Master", tier: 2 });
    // rank 2600 of 65000 → top 4%.
    expect(intel.percentile).toBe(4);
    expect(intel.peakRating).toBe(4350);
    expect(intel.leagueMax).toEqual({ type: 6, label: "Grandmaster" });
    expect(intel.ratingHistory).toHaveLength(4);
    expect(intel.ratingHistory[3]).toEqual({
      t: "2026-07-01T10:00:00Z",
      rating: 4100,
    });
    expect(intel.pro).toEqual({
      nickname: "Foe",
      name: "For Example",
      country: "FI",
      earnings: 12345,
      team: "Team X",
      links: {
        twitch: "https://twitch.tv/foe",
        aligulac: "http://aligulac.com/players/1",
      },
    });
    // Linked characters exclude the requested id itself.
    expect(intel.linkedCharacters).toEqual([
      {
        characterId: "222",
        name: "Smurf#456",
        region: "US",
        ratingMax: 4100,
        leagueMax: 5,
      },
    ]);
    expect(intel.pulseProfileUrl).toContain("id=111");
  });

  test("caches per character id — concurrent + repeat views share one upstream call", async () => {
    const { impl, calls } = fakeFetch(commonPayload());
    const svc = new PulseOpponentIntelService({ fetchImpl: impl });
    const [a, b] = await Promise.all([svc.getIntel("111"), svc.getIntel("111")]);
    await svc.getIntel("111");
    expect(calls).toHaveLength(1);
    expect(a).toEqual(b);
  });

  test("serves stale intel when a refresh fails", async () => {
    let now = 0;
    let fail = false;
    const impl = async () => {
      if (fail) throw new Error("upstream down");
      return { ok: true, json: async () => commonPayload() };
    };
    const svc = new PulseOpponentIntelService({
      fetchImpl: impl,
      now: () => now,
      cacheTtlMs: 1000,
    });
    const first = await svc.getIntel("111");
    expect(first).not.toBeNull();
    now = 5000; // TTL expired
    fail = true;
    const second = await svc.getIntel("111");
    expect(second).toEqual(first);
  });

  test("returns null (not a throw) for junk ids and upstream errors", async () => {
    const { impl } = fakeFetch(new Error("boom"));
    const svc = new PulseOpponentIntelService({ fetchImpl: impl });
    expect(await svc.getIntel("../../etc/passwd")).toBeNull();
    expect(await svc.getIntel("")).toBeNull();
    expect(await svc.getIntel("12345")).toBeNull();
  });

  test("downsamples long rating histories to the sparkline budget", async () => {
    const payload = commonPayload();
    const n = 500;
    payload.history.rating = Array.from({ length: n }, (_, i) => 3000 + i);
    const base = Date.UTC(2026, 5, 1);
    payload.history.dateTime = Array.from({ length: n }, (_, i) =>
      new Date(base + i * 60_000).toISOString(),
    );
    payload.history.leagueType = Array.from({ length: n }, () => 5);
    payload.history.globalRank = Array.from({ length: n }, () => 100);
    payload.history.globalTeamCount = Array.from({ length: n }, () => 65000);
    const { impl } = fakeFetch(payload);
    const svc = new PulseOpponentIntelService({ fetchImpl: impl });
    const intel = await svc.getIntel("111");
    expect(intel.ratingHistory.length).toBeLessThanOrEqual(120);
    // Last (most recent) point always survives.
    const last = intel.ratingHistory[intel.ratingHistory.length - 1];
    expect(last.rating).toBe(3000 + n - 1);
  });
});
