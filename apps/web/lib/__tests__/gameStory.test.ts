import { describe, expect, it } from "vitest";
import { gameStory, storyFights, storyLeadSeries, type GameStoryInput } from "../gameStory";
import type { CasualtyEvent, StatsEvent } from "@/components/analyzer/macro/MacroBreakdownPanel.types";

const sample = (time: number, army: number, workers = 20, income = 500): StatsEvent => ({ time, army_value: army, food_workers: workers, minerals_collection_rate: income, vespene_collection_rate: 0 });
const death = (time: number, owner: "me" | "opp", name = "Marine", category: CasualtyEvent["category"] = "units"): CasualtyEvent => ({ time, owner, name, category, killer: owner === "me" ? "opp" : "me" });
const golden: GameStoryInput = {
  gameId: "golden", result: "Victory",
  statsEvents: [sample(0, 100, 10), sample(30, 200, 20), sample(60, 1000, 35), sample(90, 600, 40)],
  oppStatsEvents: [sample(0, 100, 12), sample(30, 200, 22), sample(60, 400, 30), sample(90, 600, 35)],
  casualtyEvents: [death(61, "me"), death(65, "opp", "Marauder"), death(69, "opp"), death(120, "me", "SCV", "workers")],
  supplyBlockedSeconds: 22, supplyBlockWindows: [{ start: 32, end: 54 }],
  leaks: [{ name: "Supply Blocked", mineral_cost: 200, time: 32 }],
  buildEvents: [{ time: 12, name: "SupplyDepot", category: "building" }],
};

describe("game story fixed rules", () => {
  it("has a golden recap, peak, worker overtake, trade counts, blocks and top leak", () => {
    const story = gameStory(golden);
    expect(story.leadSeries.map(row => [row.time, row.armyLead, row.workerLead])).toEqual([[0, 0, -2], [30, 0, -2], [60, 600, 5], [90, 0, 5]]);
    expect(story.fights.map(fight => [fight.start, fight.end, fight.me.minerals, fight.opp.minerals, fight.opp.gas, fight.outcome])).toEqual([[61, 69, 50, 150, 25, "won"], [120, 120, 50, 0, 0, "lost"]]);
    expect(story.fights[0].tradeRatio).toBe(3.5);
    expect(story.chips.map(chip => [chip.id, chip.time])).toEqual([["army-peak", 60], ["worker-overtake", 60], ["fights-won", 61], ["fights-lost", 120], ["supply-blocks", 32]]);
    expect(story.recap).toEqual(["Your largest sampled army lead was 600 resources at 1:00.", "You moved ahead in sampled workers at 1:00 and kept that lead through the last paired sample.", "Recorded casualty clusters: 1 trade won, 1 lost and 0 even.", "The build log records SupplyDepot starting at 0:12."]);
    expect(story.topLeak).toEqual({ name: "Supply Blocked", detail: "Estimated 200 minerals lost under the macro rules.", time: 32 });
    expect(story.meaningful).toBe(true);
  });

  it("chains exact ten-second gaps through long fights, splitting only a greater gap", () => {
    const casualties = Array.from({ length: 31 }, (_, i) => death(i * 10, "me"));
    casualties.push(death(311, "opp"));
    const fights = storyFights({ gameId: "long", casualtyEvents: casualties });
    expect(fights.map(row => [row.start, row.end, row.duration])).toEqual([[0, 300, 300], [311, 311, 0]]);
    expect(fights[0].me).toMatchObject({ minerals: 1550, gas: 0, supply: 31, units: [{ name: "Marine", count: 31 }] });
  });

  it("keeps worker harass and zero-own-loss trades, and treats exact empty ledgers as authoritative", () => {
    expect(storyFights({ ...golden, casualtyEvents: [] })).toEqual([]);
    const fight = storyFights({ gameId: "harass", casualtyEvents: [death(80, "opp", "Probe", "workers"), death(85, "opp", "Probe", "workers")] })[0];
    expect(fight.opp).toMatchObject({ minerals: 100, supply: 2 });
    expect(fight).toMatchObject({ tradeRatio: null, outcome: "won", estimated: false });
  });

  it("uses full morph investments, canonical stances and discloses unknown prices/supply", () => {
    const fights = storyFights({ gameId: "costs", casualtyEvents: [death(10, "me", "Baneling"), death(11, "opp", "SiegeTankSieged"), death(30, "opp", "UnknownUnit")] });
    expect(fights[0].me).toMatchObject({ minerals: 50, gas: 25, supply: .5 });
    expect(fights[0].opp).toMatchObject({ minerals: 150, gas: 125, supply: 3 });
    expect(fights[1].opp).toMatchObject({ unpriced: 1, supply: null });
    expect(fights[1].outcome).toBe("unknown");
  });

  it("uses even thresholds and excludes malformed deaths without changing the source", () => {
    const events = [death(10, "me"), death(11, "opp"), death(-1, "me"), death(Number.NaN, "me")];
    const saved = events.slice();
    expect(storyFights({ gameId: "even", casualtyEvents: events })[0]).toMatchObject({ outcome: "even", tradeRatio: 1, label: "Even" });
    expect(events).toEqual(saved);
  });

  it("only estimates absent ledgers and never calls a one-sided sample a won trade", () => {
    const input = { gameId: "legacy", statsEvents: [sample(0, 1200), sample(30, 200)], oppStatsEvents: [sample(0, 1000), sample(30, 900)] };
    expect(storyFights(input)[0]).toMatchObject({ estimated: true, outcome: "lost" });
    expect(storyFights({ ...input, oppStatsEvents: [] })[0]).toMatchObject({ estimated: true, outcome: "unknown", label: "Estimated fight · one side unmeasured" });
    expect(storyFights(input)[0].me).toMatchObject({ minerals: 0, gas: 0, estimatedValue: 1000, supply: null });
  });

  it("requires measurements bracketing this estimated fight, not just samples somewhere in the game", () => {
    const input = { gameId: "disjoint", statsEvents: [sample(0, 1200), sample(30, 200)], oppStatsEvents: [sample(100, 1000), sample(130, 900)] };
    expect(storyFights(input)[0]).toMatchObject({ estimated: true, outcome: "unknown" });
    expect(storyFights({ ...input, oppStatsEvents: [sample(0, 1000), sample(90, 900)] })[0].outcome).toBe("unknown");
  });

  it("pairs staggered samples without leaking a future sample and stops at the common range", () => {
    const series = storyLeadSeries([sample(0, 100), sample(20, 200), sample(50, 300)], [sample(10, 50), sample(30, 250)]);
    expect(series.map(row => [row.time, row.armyLead])).toEqual([[10, 50], [20, 150], [30, -50]]);
    expect(storyLeadSeries([sample(0, 1)], [])).toEqual([]);
  });

  it("never invents income/army from missing observations or turns a new channel into a swing", () => {
    const me = [sample(0, 100), { time: 30, food_workers: 40 }, sample(60, 1000, 40)];
    const story = gameStory({ gameId: "missing", statsEvents: me, oppStatsEvents: [sample(0, 100), sample(30, 100), sample(60, 100)] });
    expect(story.leadSeries[1]).toMatchObject({ armyLead: null, incomeLead: null, combinedLead: null });
    expect(story.turningPoints).toEqual([]);
  });

  it("frequent opposing samples cannot hide a long gap in the player's observations", () => {
    const story = gameStory({ gameId: "gap", statsEvents: [sample(0, 100), sample(90, 1000)], oppStatsEvents: Array.from({ length: 10 }, (_, i) => sample(i * 10, 100)) });
    expect(story.leadSeries.find(row => row.time === 60)).toMatchObject({ armyLead: null, workerLead: null, incomeLead: null, combinedLead: null });
    expect(story.turningPoints).toEqual([]);
  });

  it("selects at most three non-overlapping largest thirty-second swings with stable ties", () => {
    const me = Array.from({ length: 19 }, (_, i) => sample(i * 10, i % 6 < 3 ? 100 : 1000));
    const opp = me.map(row => sample(row.time, 500));
    const story = gameStory({ gameId: "swing", statsEvents: me, oppStatsEvents: opp });
    expect(story.turningPoints).toHaveLength(3);
    expect(story.turningPoints.every(row => row.time - row.start === 30 && row.label.startsWith("Largest swing"))).toBe(true);
    for (let i = 1; i < story.turningPoints.length; i++) expect(story.turningPoints[i].start).toBeGreaterThanOrEqual(story.turningPoints[i - 1].time);
    expect(gameStory({ gameId: "swing", statsEvents: me, oppStatsEvents: opp })).toEqual(story);
  });

  it("does not claim a held worker lead when it was lost or unmeasured later", () => {
    const story = gameStory({ gameId: "workers", statsEvents: [sample(0, 0, 10), sample(30, 0, 30), sample(60, 0, 15)], oppStatsEvents: [sample(0, 0, 20), sample(30, 0, 20), sample(60, 0, 20)] });
    expect(story.recap).toContain("You moved ahead in sampled workers at 0:30.");
    expect(story.recap.join(" ")).not.toContain("kept that lead");
  });

  it("keeps wins, draws and losses deterministic without causal or win-probability claims", () => {
    for (const result of ["Victory", "Defeat", "Tie", "Draw"]) {
      const story = gameStory({ ...golden, result });
      expect(story.fights).toEqual(gameStory(golden).fights);
      expect(story.recap.join(" ")).not.toMatch(/caused|because|probability|decided/i);
    }
  });

  it("drops the filler for quiet games and reports whole-game block context honestly", () => {
    expect(gameStory({ gameId: "quiet", statsEvents: [sample(0, 100)], oppStatsEvents: [sample(0, 100)], casualtyEvents: [], supplyBlockedSeconds: 0 }).meaningful).toBe(false);
    expect(gameStory({ gameId: "blocks", supplyBlockedSeconds: 11 }).chips[0]).toEqual({ id: "supply-blocks", time: 0, label: "11s supply blocked · at/above 10s threshold · whole game" });
  });
});
