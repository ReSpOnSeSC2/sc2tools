/**
 * reportGames + reportGameDetail — the game list, offline build orders
 * (cosmetic lines dropped like the API does) and the macro chart props,
 * on real payloads.
 */
import { describe, expect, it } from "vitest";

import { gameBuilds, macroChartProps, offlineBuildEvents, withoutCosmeticLines } from "../reportGameDetail";
import { buildReportGames, matchupLabel } from "../reportGames";
import { bare, ladderPair, realWin } from "./fixtures/reportGames";

describe("buildReportGames", () => {
  it("lists real games newest first with matchup, result and MMR", () => {
    const [older, newer] = ladderPair();
    const games = buildReportGames([older, realWin(), newer]);
    expect(games.map((game) => [game.date, game.matchup, game.outcome, game.map])).toEqual([
      ["2026-05-08T19:08:12Z", "PvZ", "W", "Tourmaline LE"],
      ["2026-04-12T14:39:35Z", "TvT", "W", "Tourmaline LE"],
      ["2026-02-21T14:40:28Z", "TvZ", "W", "Winter Madness LE"],
    ]);
    expect(games[0].mmr).toEqual({ my: 5326, opp: 5118, gap: 208 });
    expect(games[0].opponentName).toBe("Squirtuoz");
    // Only the older Terran-queue game has a later game on its queue.
    expect(games.map((game) => game.nextMmr?.delta ?? null)).toEqual([null, null, -32]);
  });

  it("keeps unknowns empty instead of guessing", () => {
    const [game] = buildReportGames([bare({ result: "Tie", myRace: "Protoss" })]);
    expect(game).toMatchObject({ matchup: null, outcome: null, opponentName: null, mmr: null, nextMmr: null });
  });
});

describe("matchupLabel", () => {
  it("needs both races", () => {
    expect(matchupLabel("Terran", "Zerg")).toBe("TvZ");
    expect(matchupLabel("Zerg", "Random")).toBe("ZvR");
    expect(matchupLabel("Protoss", "U")).toBeNull();
    expect(matchupLabel(null, "Zerg")).toBeNull();
  });
});

describe("offline build orders", () => {
  it("drops the reward dances, beacons and sprays the real logs start with", () => {
    const log = realWin().oppBuildLog;
    const cleaned = withoutCosmeticLines(log);
    expect(log.some((line) => /\] (RewardDance|Beacon)/.test(line))).toBe(true);
    expect(cleaned.some((line) => /\] (Reward|Beacon|Spray)/.test(line))).toBe(false);
    expect(withoutCosmeticLines(["[0:00] SprayTerran", "[0:12] Pylon", "garbage"])).toEqual(["[0:12] Pylon", "garbage"]);
  });

  it("parses both sides of a real game into time-ordered events", () => {
    const builds = gameBuilds(realWin());
    expect(builds.myLabel).toBe("PvZ - Adept Glaives (Robo)");
    expect(builds.oppLabel).toBe("ZvP - Speedling Flood");
    expect(builds.myStatus).toBe("ok");
    expect(builds.oppStatus).toBe("ok");
    expect(builds.oppEvents.map((event) => event.name)).toContain("SpawningPool");
    expect(builds.myEvents.every((event) => !/^(Beacon|Reward|Spray)/.test(event.name))).toBe(true);
    const times = builds.oppEvents.map((event) => event.time);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(builds.oppEvents[0].race).toBe("Zerg");
  });

  it("orders out-of-order lines by time and marks an empty side", () => {
    expect(offlineBuildEvents(["[1:05] Gateway", "[0:18] Pylon"], "Protoss").map((e) => e.time_display)).toEqual([
      "0:18",
      "1:05",
    ]);
    const builds = gameBuilds(bare({ buildLog: ["[0:00] RewardDanceStalker"] }));
    expect(builds).toMatchObject({ myEvents: [], oppEvents: [], myStatus: "empty", oppStatus: "empty", oppLabel: null });
  });
});

describe("macroChartProps", () => {
  it("wires the real breakdown like the analyzer's macro panel", () => {
    const payload = realWin();
    const breakdown = payload.macroBreakdown ?? {};
    const builds = gameBuilds(payload);
    const props = macroChartProps(payload, builds);
    if (!props) throw new Error("the real game has samples");
    expect(props.buildOrder).toEqual({ ok: true, events: builds.myEvents, opp_events: builds.oppEvents });
    expect(props.samples).toBe(breakdown.stats_events);
    expect(props.oppSamples).toBe(breakdown.opp_stats_events);
    expect(props.unitTimeline).toBe(breakdown.unit_timeline);
    expect(props.myProductionBuildings).toBe(breakdown.production_buildings);
    expect(props.leaks).toBe(breakdown.all_leaks);
    expect(props.supplyBlockWindows).toHaveLength(4);
    expect(props).toMatchObject({ gameLengthSec: 470, myName: null, oppName: "Squirtuoz", myRace: "Protoss", oppRace: "Zerg" });
    expect(props.apm).toMatchObject({ windowSec: 30, me: { avg: 189.7 } });
    expect(props.apm?.opp).not.toBeNull();
  });

  it("falls back to the top 3 leaks and hides without samples", () => {
    const payload = realWin();
    const breakdown = payload.macroBreakdown ?? {};
    const builds = gameBuilds(payload);
    const topOnly = { ...payload, macroBreakdown: { ...breakdown, all_leaks: [] } };
    expect(macroChartProps(topOnly, builds)?.leaks).toBe(breakdown.top_3_leaks);
    expect(macroChartProps({ ...payload, macroBreakdown: { ...breakdown, stats_events: [] } }, builds)).toBeNull();
    expect(macroChartProps({ ...payload, macroBreakdown: null }, builds)).toBeNull();
    expect(macroChartProps({ ...payload, apmCurve: null }, builds)?.apm).toBeNull();
  });
});
