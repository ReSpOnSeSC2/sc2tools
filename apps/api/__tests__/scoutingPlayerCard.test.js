"use strict";

const { computeOpponentTendencies, computePlayerCard } = require("../src/services/scouting/playerCard");
const { buildSamplePayload } = require("../src/services/overlayLiveSamples");

const UNKNOWN = { earlyFinish: null, expansion: null, economy: null, tech: null, air: null };

describe("replay evidence for scouting player cards", () => {
  test("missing and invalid channels stay unknown", () => {
    expect(computeOpponentTendencies({})).toEqual(UNKNOWN);
    expect(computeOpponentTendencies({ durationSec: -1, macroBreakdown: {
      opp_stats_events: [{ time: 300, food_workers: null }],
      unit_timeline: [{ time: 300, opp: {} }],
    } })).toEqual(UNKNOWN);
  });

  test("uses opponent evidence only and excludes supply/scouting air", () => {
    expect(computeOpponentTendencies({ durationSec: 600, oppBuildLog: ["[9:45] SpawningPool"], macroBreakdown: {
      bases: [{ name: "Nexus", born_time: 0, died_time: 600 }, { name: "Nexus", born_time: 200, died_time: 600 }],
      stats_events: [{ time: 600, food_workers: 90 }],
      opp_stats_events: [{ time: 600, food_workers: 30 }],
      unit_timeline: [{ time: 600, my: { Carrier: 8 }, opp: { Overlord: 8, Observer: 1 } }],
    } })).toEqual({ earlyFinish: false, expansion: null, economy: false, tech: false, air: false });
  });

  test("measures real bases, workers, technology and combat air", () => {
    expect(computeOpponentTendencies({ durationSec: 240, oppBuildLog: ["[3:00] FleetBeacon"], macroBreakdown: {
      opp_bases: [{ name: "Nexus", born_time: 0, died_time: 240 }, { name: "Nexus", born_time: 200, died_time: 240 }],
      opp_stats_events: [{ time: 240, food_workers: 60 }],
      unit_timeline: [{ time: 240, opp: { VoidRay: 2 } }],
    } })).toEqual({ earlyFinish: true, expansion: true, economy: true, tech: true, air: true });
  });

  test("does not double-count a townhall morph or bases that never coexist", () => {
    const base = { durationSec: 600, macroBreakdown: { opp_bases: [
      { name: "CommandCenter", born_time: 0, died_time: 120 },
      { name: "OrbitalCommand", born_time: 120, died_time: 600 },
    ] } };
    expect(computeOpponentTendencies(base).expansion).toBe(false);
    base.macroBreakdown.opp_bases[1].name = "CommandCenter";
    expect(computeOpponentTendencies(base).expansion).toBe(false);
  });

  test("truncated timelines can establish presence but not absence", () => {
    const game = { durationSec: 1200, macroBreakdown: {
      opp_stats_events: [{ time: 240, food_workers: 30 }],
      unit_timeline: [{ time: 240, opp: { Marine: 5 } }],
    } };
    expect(computeOpponentTendencies(game)).toMatchObject({ economy: null, air: null });
    game.macroBreakdown.opp_stats_events[0].food_workers = 70;
    game.macroBreakdown.unit_timeline[0].opp = /** @type {any} */ ({ Battlecruiser: 1 });
    expect(computeOpponentTendencies(game)).toMatchObject({ economy: true, air: true, tech: true });
  });

  test("does not infer missing technology from capped logs or army snapshots", () => {
    const game = { durationSec: 600, oppBuildLog: Array(256).fill("[0:30] Marine"), macroBreakdown: {
      unit_timeline: [{ time: 600, opp: { Marine: 5 } }],
    } };
    expect(computeOpponentTendencies(game).tech).toBeNull();
    game.oppBuildLog[255] = "[5:30] Battlecruiser";
    expect(computeOpponentTendencies(game).tech).toBe(true);
    game.oppBuildLog = ["[0:30] Marine"];
    expect(computeOpponentTendencies(game).tech).toBeNull();
  });

  test("canonicalizes transformed air units and ignores observations after game end", () => {
    const game = { durationSec: 300, oppBuildLog: ["[5:30] Battlecruiser"], macroBreakdown: {
      opp_stats_events: [{ time: 301, food_workers: 80 }],
      unit_timeline: [{ time: 301, opp: { Battlecruiser: 1 } }, { time: 290, opp: { VikingAssault: 1 } }],
    } };
    expect(computeOpponentTendencies(game)).toMatchObject({ economy: null, air: true, tech: null });
  });

  test("rates retain separate denominators and disclose the bounded sample", () => {
    const card = computePlayerCard([
      { ...UNKNOWN, earlyFinish: true, expansion: true },
      { ...UNKNOWN, earlyFinish: false, economy: false },
      UNKNOWN,
    ], { totalGames: 100, sampleLimit: 3 });
    expect(card).toMatchObject({ version: 1, sampleSize: 3, totalGames: 100, sampleLimit: 3, sampled: true });
    expect(card.axes.map(({ key, value, matches, samples }) => ({ key, value, matches, samples }))).toEqual([
      { key: "earlyFinish", value: 50, matches: 1, samples: 2 },
      { key: "expansion", value: 100, matches: 1, samples: 1 },
      { key: "economy", value: 0, matches: 0, samples: 1 },
      { key: "tech", value: null, matches: 0, samples: 0 },
      { key: "air", value: null, matches: 0, samples: 0 },
    ]);
  });

  test("an empty sample never produces invented ratings", () => {
    const card = computePlayerCard([], { totalGames: 0, sampleLimit: 100 });
    expect(card.sampled).toBe(false);
    expect(card.axes.every((axis) => axis.value === null && axis.samples === 0)).toBe(true);
  });

  test("the scouting Settings test event includes a populated player card", () => {
    const payload = /** @type {any} */ (buildSamplePayload("scouting"));
    expect(payload.playerCard.sampleSize).toBe(5);
    expect(payload.playerCard.axes.every((/** @type {any} */ axis) => typeof axis.value === "number")).toBe(true);
    expect(payload.playerCard.axes.find((/** @type {any} */ axis) => axis.key === "expansion").value).toBe(80);
    expect(/** @type {any} */ (buildSamplePayload("rank")).playerCard).toBeUndefined();
  });
});
