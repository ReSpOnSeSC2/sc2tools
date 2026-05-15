// @ts-nocheck
"use strict";

/**
 * Unit tests for the games-route helpers that drive the streamer's
 * own-MMR Pulse fill at ingest. The route exports them via the
 * ``_testing`` namespace so we can assert the contract without
 * spinning up the full express + Mongo stack.
 *
 * Why this matters: the bingo MMR predicates
 * (``win_vs_higher_mmr`` / ``win_close_mmr``) compute
 * ``oppMmr - myMmr`` — without ``g.myMmr`` they can't fire. sc2reader
 * usually carries it for the player's own row, but a sizable cohort
 * of replays (mods, certain build versions) ship null; this fill is
 * the safety net.
 */

const { _testing } = require("../src/routes/games");

const { loadUserProfile, pickRegionForGame, fetchMyMmrFromPulse } = _testing;

describe("loadUserProfile", () => {
  test("returns null when UsersService is missing", async () => {
    expect(await loadUserProfile(undefined, "u1")).toBeNull();
    expect(await loadUserProfile({}, "u1")).toBeNull();
  });

  test("returns the pulseIds array when present", async () => {
    const users = {
      getProfile: jest.fn(async () => ({ pulseIds: ["1", "2"] })),
    };
    const r = await loadUserProfile(users, "u1");
    expect(r).toEqual({ pulseIds: ["1", "2"] });
    expect(users.getProfile).toHaveBeenCalledWith("u1");
  });

  test("normalises missing pulseIds to an empty array", async () => {
    const users = { getProfile: jest.fn(async () => ({})) };
    const r = await loadUserProfile(users, "u1");
    expect(r).toEqual({ pulseIds: [] });
  });

  test("returns null when getProfile throws", async () => {
    const users = {
      getProfile: jest.fn(async () => {
        throw new Error("db_down");
      }),
    };
    expect(await loadUserProfile(users, "u1")).toBeNull();
  });
});

describe("pickRegionForGame", () => {
  test("derives region from opponent.toonHandle (preferred)", () => {
    expect(
      pickRegionForGame({
        opponent: { toonHandle: "1-S2-1-1" },
        myToonHandle: "2-S2-1-1",
      }),
    ).toBe("NA");
  });

  test("falls back to myToonHandle when opponent's is absent", () => {
    expect(
      pickRegionForGame({
        opponent: {},
        myToonHandle: "2-S2-1-1",
      }),
    ).toBe("EU");
  });

  test("returns null when neither handle decodes", () => {
    expect(pickRegionForGame({})).toBeNull();
    expect(pickRegionForGame({ opponent: { toonHandle: "junk" } })).toBeNull();
  });
});

describe("fetchMyMmrFromPulse", () => {
  test("returns null when pulseIds is empty", async () => {
    const pulseMmr = { getCurrentMmrForAny: jest.fn() };
    expect(await fetchMyMmrFromPulse(pulseMmr, [], "NA")).toBeNull();
    expect(pulseMmr.getCurrentMmrForAny).not.toHaveBeenCalled();
  });

  test("prefers the multi-id batch path when available, region-aware", async () => {
    const pulseMmr = {
      getCurrentMmrForAny: jest.fn(async () => ({ mmr: 4321, region: "NA" })),
      getCurrentMmr: jest.fn(),
    };
    const r = await fetchMyMmrFromPulse(pulseMmr, ["123", "456"], "NA");
    expect(r).toBe(4321);
    expect(pulseMmr.getCurrentMmrForAny).toHaveBeenCalledWith(
      ["123", "456"],
      { preferredRegion: "NA" },
    );
    expect(pulseMmr.getCurrentMmr).not.toHaveBeenCalled();
  });

  test("falls back to single-id path when getCurrentMmrForAny is absent", async () => {
    const pulseMmr = {
      getCurrentMmr: jest.fn(async () => ({ mmr: 4321, region: "EU" })),
    };
    const r = await fetchMyMmrFromPulse(pulseMmr, ["123", "456"], "EU");
    expect(r).toBe(4321);
    expect(pulseMmr.getCurrentMmr).toHaveBeenCalledWith("123");
  });

  test("returns null on Pulse miss / null result", async () => {
    const pulseMmr = {
      getCurrentMmrForAny: jest.fn(async () => null),
    };
    expect(await fetchMyMmrFromPulse(pulseMmr, ["123"], "NA")).toBeNull();
  });

  test("returns null on non-finite / non-positive MMR", async () => {
    const pulseMmr = {
      getCurrentMmrForAny: jest.fn(async () => ({ mmr: 0, region: "NA" })),
    };
    expect(await fetchMyMmrFromPulse(pulseMmr, ["123"], "NA")).toBeNull();
    pulseMmr.getCurrentMmrForAny.mockResolvedValue({
      mmr: Number.NaN,
      region: "NA",
    });
    expect(await fetchMyMmrFromPulse(pulseMmr, ["123"], "NA")).toBeNull();
  });

  test("swallows Pulse exceptions and returns null", async () => {
    const pulseMmr = {
      getCurrentMmrForAny: jest.fn(async () => {
        throw new Error("rate_limited");
      }),
    };
    expect(await fetchMyMmrFromPulse(pulseMmr, ["123"], "NA")).toBeNull();
  });

  test("rounds the returned MMR to an integer", async () => {
    const pulseMmr = {
      getCurrentMmrForAny: jest.fn(async () => ({ mmr: 4321.7, region: "NA" })),
    };
    expect(await fetchMyMmrFromPulse(pulseMmr, ["123"], "NA")).toBe(4322);
  });
});
