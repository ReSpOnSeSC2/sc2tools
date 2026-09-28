// @ts-nocheck
"use strict";

/**
 * Replay Review Exchange: a reviewer's league per region. The accounts
 * come from the reviewer's own synced ladder games; SC2Pulse (a stand-in
 * here) supplies each account's current-season league, which is the
 * only way to know Grandmaster.
 */

const request = require("supertest");

jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());

const { createHarness } = require("./helpers/reviewsHarness");
const { PulseMmrService } = require("../src/services/pulseMmr");
const { VERIFICATION_VERSION } = require("../src/services/reviewerReputation");

const NA = "1-S2-1-267727";
const EU = "2-S2-1-8780508";
const KR = "3-S2-1-6833017";

/** SC2Pulse's current-season teams per account. */
const LADDER = {
  [NA]: [{ region: "NA", race: "Protoss", leagueId: 6, rating: 5350, games: 375 }],
  [EU]: [
    { region: "EU", race: "Protoss", leagueId: 6, rating: 5136, games: 214 },
    { region: "EU", race: "Terran", leagueId: 5, rating: 4539, games: 2 },
  ],
  [KR]: [{ region: "KR", race: "Protoss", leagueId: 6, rating: 6200, games: 300 }],
};

const GM = { id: 6, label: "Grandmaster" };
const MASTER = { id: 5, label: "Master" };

let h;
let pulse;

beforeAll(async () => {
  pulse = new PulseMmrService({
    fetchImpl: async () => {
      throw new Error("network_disabled_in_tests");
    },
  });
  pulse.getLadderTeams = jest.fn(async (ids) => ids.flatMap((id) => LADDER[id] || []));
  h = await createHarness({ pulseMmr: pulse });
});
afterAll(async () => {
  await h.close();
});
beforeEach(() => {
  pulse.getLadderTeams.mockClear();
});

/** ``count`` ranked 1v1 Protoss games on ``toon`` around ``mmr``. */
async function seedGames(name, toon, count, mmr) {
  await h.db.games.insertMany(Array.from({ length: count }, (_, i) => ({
    userId: h.userId(name),
    gameId: `${name}-${toon}-${i}`,
    date: new Date(Date.now() - (i + 1) * 3600_000),
    result: i % 2 ? "Victory" : "Defeat",
    myRace: "Protoss",
    myToonHandle: toon,
    map: "Alcyone LE",
    matchFormat: "1v1",
    playerCount: 2,
    isLadderGame: true,
    myMmr: mmr - (i % 4) * 10,
    myMmrSource: "replay",
    durationSec: 600,
  })));
}

/** GET /v1/me/reviewer as ``name``. */
async function me(name) {
  const res = await request(h.app).get("/v1/me/reviewer").set("authorization", h.bearer(name));
  expect(res.status).toBe(200);
  return res.body;
}

describe("reviews: verified league per region", () => {
  test("a Grandmaster on NA and EU is verified Grandmaster in both regions", async () => {
    await h.seedUser("gm");
    await seedGames("gm", NA, 20, 5350);
    await seedGames("gm", EU, 12, 5140);
    // Two games on a KR account are not enough to borrow its league.
    await seedGames("gm", KR, 2, 3900);

    const body = await me("gm");
    expect(body.verified).toEqual({
      band: GM,
      race: "Protoss",
      mmr: 5400,
      regions: [
        { region: "NA", band: GM, race: "Protoss" },
        { region: "EU", band: GM, race: "Protoss" },
      ],
    });
    expect(pulse.getLadderTeams).toHaveBeenCalledTimes(1);
    expect(pulse.getLadderTeams).toHaveBeenCalledWith([NA, EU]);
    const stored = (await h.db.users.findOne({ userId: h.userId("gm") })).reviewer.verified;
    expect(stored).toMatchObject({ v: VERIFICATION_VERSION, band: GM });
    expect(stored.regions.map((r) => [r.region, r.source])).toEqual([["NA", "ladder"], ["EU", "ladder"]]);
  });

  test("without SC2Pulse each region keeps the band its games reach", async () => {
    await h.seedUser("offline");
    await seedGames("offline", NA, 12, 5350);
    await seedGames("offline", EU, 12, 5140);
    pulse.getLadderTeams.mockRejectedValueOnce(new Error("SC2Pulse down"));

    const body = await me("offline");
    expect(body.verified.band).toEqual(MASTER);
    expect(body.verified.regions).toEqual([
      { region: "NA", band: MASTER, race: "Protoss" },
      { region: "EU", band: MASTER, race: "Protoss" },
    ]);
  });

  test("a verification cached before regions existed is recomputed", async () => {
    await h.seedUser("cached", {
      reviewer: {
        verified: { band: MASTER, race: "Protoss", mmr: 5300, games: 20, verifiedAt: new Date(), windowStart: new Date(0) },
      },
    });
    await seedGames("cached", NA, 12, 5350);

    const body = await me("cached");
    expect(body.verified.band).toEqual(GM);
    expect(body.verified.regions).toEqual([{ region: "NA", band: GM, race: "Protoss" }]);
    // The fresh verification is cached: a second read doesn't ask SC2Pulse again.
    await me("cached");
    expect(pulse.getLadderTeams).toHaveBeenCalledTimes(1);
  });

  test("games synced before toon handles were recorded still verify a band, with no regions", async () => {
    await h.seedUser("legacy");
    await h.seedLadderHistory("legacy", { count: 12, mmr: 4700, race: "Zerg" });

    const body = await me("legacy");
    expect(body.verified).toEqual({ band: MASTER, race: "Zerg", mmr: 4700, regions: [] });
    expect(pulse.getLadderTeams).not.toHaveBeenCalled();
  });
});
