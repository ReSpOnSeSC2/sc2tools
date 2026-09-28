// @ts-nocheck
"use strict";

/**
 * PulseMmrService.getLadderTeams: every current-season 1v1 team for a
 * player's accounts, with each team's own region and league id. The
 * fixtures mirror real SC2Pulse rows (league as ``{type}``, region as
 * "US"/"EU") for a player who is Grandmaster Protoss on NA and EU.
 */

const { PulseMmrService } = require("../src/services/pulseMmr");

const NA_TOON = "1-S2-1-267727";
const EU_TOON = "2-S2-1-8780508";
const IDS_BY_TOON = { [NA_TOON]: 994428, [EU_TOON]: 8970877 };

const SEASONS = [
  { battlenetId: 68, region: "US" },
  { battlenetId: 68, region: "EU" },
  { battlenetId: 68, region: "KR" },
  { battlenetId: 54, region: "CN" },
];

/** A SC2Pulse 1v1 team row. */
function team(id, region, league, rating, games, raceField = "protossGamesPlayed", tierType = 0) {
  return {
    id,
    region,
    league: { type: league, queueType: 201, teamType: 0 },
    tierType,
    rating,
    lastPlayed: "2026-09-28T13:58:28Z",
    members: [{ [raceField]: games, character: { id: IDS_BY_TOON[region === "US" ? NA_TOON : EU_TOON] } }],
  };
}

const TEAMS_68 = [
  team(1, "US", 6, 5350, 375),
  team(2, "EU", 6, 5136, 214),
  team(3, "EU", 5, 4539, 2, "terranGamesPlayed", 2),
];

function jsonResponse(payload) {
  return { ok: true, json: async () => payload };
}

function pulseFetch() {
  return jest.fn(async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/season/list/all")) return jsonResponse(SEASONS);
    if (u.pathname.endsWith("/character/search")) {
      const id = IDS_BY_TOON[u.searchParams.get("term")];
      return jsonResponse(id ? [{ character: { id } }] : []);
    }
    if (u.pathname.endsWith("/group/team")) {
      return jsonResponse(u.searchParams.get("season") === "68" ? TEAMS_68 : []);
    }
    return { ok: false, json: async () => null };
  });
}

describe("PulseMmrService.getLadderTeams", () => {
  test("returns every current-season team for the accounts, with its region and league id", async () => {
    const fetchImpl = pulseFetch();
    const pulse = new PulseMmrService({ fetchImpl });
    const teams = await pulse.getLadderTeams([NA_TOON, EU_TOON]);
    expect(teams).toEqual([
      { region: "NA", race: "Protoss", leagueId: 6, rating: 5350, games: 375 },
      { region: "EU", race: "Protoss", leagueId: 6, rating: 5136, games: 214 },
      { region: "EU", race: "Terran", leagueId: 5, rating: 4539, games: 2 },
    ]);
    const teamCalls = fetchImpl.mock.calls.map(([url]) => new URL(url)).filter((u) => u.pathname.endsWith("/group/team"));
    // One call per distinct season id (68 for NA/EU/KR, 54 for CN), each carrying both accounts.
    expect(teamCalls.map((u) => u.searchParams.get("season")).sort()).toEqual(["54", "68"]);
    expect(teamCalls[0].searchParams.getAll("characterId").sort()).toEqual(["8970877", "994428"]);
  });

  test("numeric character ids skip the toon search", async () => {
    const fetchImpl = pulseFetch();
    const teams = await new PulseMmrService({ fetchImpl }).getLadderTeams(["994428"]);
    expect(teams).toHaveLength(3);
    expect(fetchImpl.mock.calls.some(([url]) => url.includes("/character/search"))).toBe(false);
  });

  test("is empty, without throwing, when nothing resolves or SC2Pulse is down", async () => {
    const down = jest.fn(async () => {
      throw new Error("ECONNRESET");
    });
    expect(await new PulseMmrService({ fetchImpl: down }).getLadderTeams([NA_TOON])).toEqual([]);
    const fetchImpl = pulseFetch();
    expect(await new PulseMmrService({ fetchImpl }).getLadderTeams(["not-a-toon", null])).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
