// @ts-nocheck
"use strict";

/**
 * services/reviewerLeagues.js: which accounts and regions a reviewer's
 * own games verify, and how SC2Pulse's current-season league and the
 * games' MMR band combine per region.
 */

const {
  groupLadderRows,
  bestBandFromGames,
  ladderAccounts,
  ladderLeaguesByRegion,
  gameLeaguesByRegion,
  mergeRegionLeagues,
  storedRegions,
  publicRegions,
  MAX_LADDER_ACCOUNTS,
} = require("../src/services/reviewerLeagues");

const NA = "1-S2-1-267727";
const EU = "2-S2-1-8780508";
const KR = "3-S2-1-6833017";

/** ``count`` ranked Protoss rows on ``toon`` at ``mmr`` (minus a little per game). */
function rows(toon, count, mmr, race = "Protoss") {
  return Array.from({ length: count }, (_, i) => ({ myRace: race, myMmr: mmr - i * 5, myToonHandle: toon }));
}

const GM = { id: 6, label: "Grandmaster" };
const MASTER = { id: 5, label: "Master" };
const DIAMOND = { id: 4, label: "Diamond" };

describe("groupLadderRows", () => {
  test("groups by race across regions and by region, counting games per account", () => {
    const { byRace, byRegion } = groupLadderRows([
      ...rows(NA, 4, 5350),
      ...rows(EU, 2, 5100),
      { myRace: "Zerg", myMmr: 4000, myToonHandle: EU },
    ]);
    expect(byRace.get("Protoss")).toHaveLength(6);
    expect(byRace.get("Zerg")).toEqual([4000]);
    expect([...byRegion.keys()]).toEqual(["NA", "EU"]);
    expect(byRegion.get("NA").toons.get(NA)).toBe(4);
    expect(byRegion.get("EU").toons.get(EU)).toBe(3);
    expect(byRegion.get("EU").byRace.get("Zerg")).toEqual([4000]);
  });

  test("a row without a toon handle still counts toward its race; Random and implausible rows never count", () => {
    const { byRace, byRegion } = groupLadderRows([
      { myRace: "Terran", myMmr: 3900 },
      { myRace: "Terran", myMmr: 3900, myToonHandle: "not-a-toon" },
      { myRace: "Random", myMmr: 4000, myToonHandle: NA },
      { myRace: "Protoss", myMmr: 0, myToonHandle: NA },
      { myRace: "Protoss", myMmr: 9001, myToonHandle: NA },
    ]);
    expect(byRace.get("Terran")).toEqual([3900, 3900]);
    expect(byRace.has("Random")).toBe(false);
    expect(byRace.has("Protoss")).toBe(false);
    expect(byRegion.size).toBe(0);
  });

  test("PTR rows count toward their race but are never a region or a ladder account", () => {
    const PTR = "98-S2-1-30230";
    const { byRace, byRegion } = groupLadderRows([
      ...rows(NA, 3, 5350),
      ...rows(PTR, 12, 6500, "Zerg"),
    ]);
    expect(byRace.get("Zerg")).toHaveLength(12);
    expect([...byRegion.keys()]).toEqual(["NA"]);
    expect(ladderAccounts(byRegion)).toEqual([NA]);
    expect([...gameLeaguesByRegion(byRegion).keys()]).not.toContain("PTR");
  });
});

describe("bestBandFromGames", () => {
  test("needs 10 games of a race and takes the band of its 3rd-best game", () => {
    const nine = new Map([["Zerg", Array(9).fill(5000)]]);
    expect(bestBandFromGames(nine)).toBeNull();
    const outlier = new Map([["Terran", [6900, ...Array(11).fill(3800)]]]);
    expect(bestBandFromGames(outlier)).toEqual({ race: "Terran", mmr: 3800, band: DIAMOND, games: 12 });
  });

  test("the highest band wins, then the higher MMR", () => {
    const both = new Map([
      ["Terran", Array(12).fill(4700)],
      ["Protoss", Array(12).fill(4900)],
      ["Zerg", Array(12).fill(4000)],
    ]);
    expect(bestBandFromGames(both)).toMatchObject({ race: "Protoss", band: MASTER, mmr: 4900 });
  });
});

describe("ladderAccounts", () => {
  test("only accounts behind 3+ of the reviewer's games, busiest first", () => {
    const { byRegion } = groupLadderRows([...rows(EU, 3, 5100), ...rows(NA, 20, 5350), ...rows(KR, 2, 3800)]);
    expect(ladderAccounts(byRegion)).toEqual([NA, EU]);
  });

  test("looks up at most MAX_LADDER_ACCOUNTS accounts", () => {
    const many = Array.from({ length: MAX_LADDER_ACCOUNTS + 3 }, (_, i) => rows(`1-S2-1-${1000 + i}`, 3 + i, 4000)).flat();
    const accounts = ladderAccounts(groupLadderRows(many).byRegion);
    expect(accounts).toHaveLength(MAX_LADDER_ACCOUNTS);
    expect(accounts[0]).toBe(`1-S2-1-${1000 + MAX_LADDER_ACCOUNTS + 2}`);
  });
});

describe("ladderLeaguesByRegion", () => {
  const { byRegion } = groupLadderRows([...rows(NA, 20, 5350), ...rows(EU, 12, 5100), ...rows(EU, 3, 4500, "Terran")]);

  test("keeps each region's strongest team: Grandmaster Protoss beats a Master Terran off-race", () => {
    const leagues = ladderLeaguesByRegion([
      { region: "NA", race: "Protoss", leagueId: 6, rating: 5350, games: 375 },
      { region: "EU", race: "Terran", leagueId: 5, rating: 4539, games: 2 },
      { region: "EU", race: "Protoss", leagueId: 6, rating: 5136, games: 214 },
    ], byRegion);
    expect(leagues.get("NA")).toEqual({ region: "NA", band: GM, race: "Protoss", mmr: 5350, games: 20, source: "ladder" });
    expect(leagues.get("EU")).toMatchObject({ band: GM, race: "Protoss", mmr: 5136, games: 12 });
  });

  test("ignores teams in regions the reviewer's games never came from, and unusable rows", () => {
    const leagues = ladderLeaguesByRegion([
      { region: "KR", race: "Protoss", leagueId: 6, rating: 6200, games: 300 },
      { region: "NA", race: "Random", leagueId: 6, rating: 5000, games: 50 },
      { region: "NA", race: "Protoss", leagueId: null, rating: 5000, games: 50 },
      { region: null, race: "Protoss", leagueId: 6, rating: 5000, games: 50 },
    ], byRegion);
    expect(leagues.size).toBe(0);
  });
});

describe("mergeRegionLeagues", () => {
  const { byRegion } = groupLadderRows([...rows(NA, 12, 5350), ...rows(EU, 12, 5140), ...rows(KR, 12, 3900)]);
  const games = gameLeaguesByRegion(byRegion);

  test("games alone verify a band per region (Grandmaster is never an MMR line)", () => {
    expect(games.get("NA")).toMatchObject({ band: MASTER, race: "Protoss", source: "games" });
    expect(games.get("KR")).toMatchObject({ band: DIAMOND });
  });

  test("SC2Pulse's league wins, unless the region's games verify higher; strongest first", () => {
    const ladder = ladderLeaguesByRegion([
      { region: "EU", race: "Protoss", leagueId: 6, rating: 5136, games: 214 },
      { region: "NA", race: "Protoss", leagueId: 6, rating: 5350, games: 375 },
      { region: "KR", race: "Protoss", leagueId: 3, rating: 2600, games: 20 },
    ], byRegion);
    const merged = mergeRegionLeagues(ladder, games);
    expect(merged.map((r) => [r.region, r.band.label, r.source])).toEqual([
      ["NA", "Grandmaster", "ladder"],
      ["EU", "Grandmaster", "ladder"],
      ["KR", "Diamond", "games"],
    ]);
  });

  test("regions of the same band and MMR keep NA, EU, KR, CN, SEA order", () => {
    const same = (region) => ({ region, band: MASTER, race: "Zerg", mmr: 4800, games: 10, source: "games" });
    const merged = mergeRegionLeagues(new Map(), new Map([["KR", same("KR")], ["EU", same("EU")], ["NA", same("NA")]]));
    expect(merged.map((r) => r.region)).toEqual(["NA", "EU", "KR"]);
  });
});

describe("stored and public regions", () => {
  const regions = [
    { region: "NA", band: GM, race: "Protoss", mmr: 5350, games: 20, source: "ladder" },
    { region: "EU", band: GM, race: "Protoss", mmr: 5136, games: 12, source: "ladder" },
  ];

  test("stored regions round MMR like the top-level figure", () => {
    expect(storedRegions(regions).map((r) => r.mmr)).toEqual([5400, 5100]);
  });

  test("public regions carry only region, band and race", () => {
    expect(publicRegions(storedRegions(regions))).toEqual([
      { region: "NA", band: GM, race: "Protoss" },
      { region: "EU", band: GM, race: "Protoss" },
    ]);
  });

  test("public regions drop unknown regions and bands, repeats and non-lists", () => {
    expect(publicRegions([
      { region: "XX", band: GM, race: "Protoss" },
      { region: "NA", band: { id: 9 }, race: "Protoss" },
      { region: "EU", band: { id: 5 }, race: "zerg" },
      { region: "EU", band: GM, race: "Protoss" },
      null,
    ])).toEqual([{ region: "EU", band: MASTER, race: "Zerg" }]);
    expect(publicRegions(undefined)).toEqual([]);
    expect(publicRegions("NA")).toEqual([]);
  });
});
