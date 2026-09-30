// @ts-nocheck
"use strict";

const {
  toStartSeconds,
  isFinishTimeEvent,
  buildSecondsFor,
  EIGHT_WORKER_BUILD_SECONDS,
} = require("../src/services/buildDurations");

// Patch 5.0.16 (the 8-worker game) and the 12-worker games around it.
const EIGHT_WORKER_GAME = { gameVersion: "5.0.16.97425" };
const PATCH_5_0_17_GAME = { gameVersion: "5.0.17.98000" };
const PRE_5_0_16_GAME = { gameVersion: "5.0.15.96883" };

describe("services/buildDurations", () => {
  describe("toStartSeconds", () => {
    test("plain Protoss/Terran structures pass through unchanged", () => {
      // CyberneticsCore comes through as a UnitInitEvent — the
      // recorded second IS the construction-start time, so we must
      // NOT subtract its build duration on top.
      expect(
        toStartSeconds("CyberneticsCore", 110, { isBuilding: true }),
      ).toBe(110);
      expect(toStartSeconds("Barracks", 90, { isBuilding: true })).toBe(90);
    });

    test("Zerg structure morphs subtract their morph duration", () => {
      // Lair completes 57s after the user clicks Morph-to-Lair.
      expect(toStartSeconds("Lair", 360, { isBuilding: true })).toBe(303);
      expect(toStartSeconds("Hive", 600, { isBuilding: true })).toBe(529);
    });

    test("structure morphs subtract their 12-worker duration by default", () => {
      expect(toStartSeconds("OrbitalCommand", 200)).toBe(175);
      expect(toStartSeconds("PlanetaryFortress", 400)).toBe(364);
      expect(toStartSeconds("WarpGate", 104)).toBe(97);
      expect(buildSecondsFor("WarpGate")).toBe(7);
    });

    test("units rewind by their train/morph duration", () => {
      // Stalker is a 30s build out of a Gateway.
      expect(toStartSeconds("Stalker", 134)).toBe(104);
      expect(buildSecondsFor("Adept")).toBe(27);
      expect(buildSecondsFor("HighTemplar")).toBe(39);
      expect(buildSecondsFor("DarkTemplar")).toBe(39);
      expect(buildSecondsFor("Reaper")).toBe(32);
      // Zergling is a 17s larva-morph.
      expect(toStartSeconds("Zergling", 50)).toBe(33);
    });

    test("upgrades rewind by their research duration", () => {
      // WarpGate research takes 100s.
      expect(
        toStartSeconds("WarpGateResearch", 320, { category: "upgrade" }),
      ).toBe(220);
      // Stimpack: 100s.
      expect(toStartSeconds("Stimpack", 400, { category: "upgrade" })).toBe(
        300,
      );
    });

    test("clamps to zero rather than going negative", () => {
      expect(toStartSeconds("Stalker", 10)).toBe(0);
    });

    test("unknown names pass through unchanged", () => {
      expect(toStartSeconds("FlibbertyGibbet", 200)).toBe(200);
    });

    test("non-finite recorded values become 0", () => {
      expect(toStartSeconds("Stalker", Number.NaN)).toBe(0);
      expect(toStartSeconds("Stalker", -5)).toBe(0);
    });

    test("name-key normalization is case- and separator-insensitive", () => {
      // ``Spawning Pool``, ``SpawningPool``, ``spawning_pool`` should
      // all resolve to the same row.
      expect(buildSecondsFor("Spawning Pool")).toBe(46);
      expect(buildSecondsFor("spawningpool")).toBe(46);
      expect(buildSecondsFor("spawning_pool")).toBe(46);
    });
  });

  describe("patch-aware durations (hints.game)", () => {
    test("an 8-worker patch 5.0.16 game uses that patch's values", () => {
      const hints = { game: EIGHT_WORKER_GAME };
      expect(toStartSeconds("WarpGate", 104, hints)).toBe(100);
      expect(buildSecondsFor("WarpGate", hints)).toBe(4);
      expect(buildSecondsFor("Adept", hints)).toBe(33);
      expect(buildSecondsFor("HighTemplar", hints)).toBe(40);
      expect(buildSecondsFor("DarkTemplar", hints)).toBe(40);
      expect(buildSecondsFor("Reaper", hints)).toBe(34);
      expect(toStartSeconds("Adept", 180, hints)).toBe(147);
    });

    test("5.0.17 and pre-5.0.16 games use the 12-worker values", () => {
      for (const game of [PATCH_5_0_17_GAME, PRE_5_0_16_GAME]) {
        const hints = { game };
        expect(toStartSeconds("WarpGate", 104, hints)).toBe(97);
        expect(buildSecondsFor("Adept", hints)).toBe(27);
        expect(buildSecondsFor("HighTemplar", hints)).toBe(39);
        expect(buildSecondsFor("DarkTemplar", hints)).toBe(39);
        expect(buildSecondsFor("Reaper", hints)).toBe(32);
        expect(toStartSeconds("Adept", 180, hints)).toBe(153);
      }
    });

    test("date-only rows follow the era rule's 8-worker window", () => {
      // 5.0.16 went live 2026-06-22T19:15Z. Live stays on 5.0.16 after the
      // 5.0.17 notes (2026-09-30), until 5.0.17 ships.
      const adeptOn = (iso) => buildSecondsFor("Adept", { game: { date: new Date(iso) } });
      expect(adeptOn("2026-07-01T00:00:00Z")).toBe(33);
      expect(adeptOn("2026-09-30T03:59:59Z")).toBe(33);
      expect(adeptOn("2026-09-30T04:00:00Z")).toBe(33);
      expect(adeptOn("2026-06-01T00:00:00Z")).toBe(27);
      // A 5.0.17 PTR game after the notes has the 12-worker times.
      expect(buildSecondsFor("Adept", {
        game: { gameVersion: "5.0.17.98123", date: new Date("2026-09-30T21:00:00Z") },
      })).toBe(27);
      // A row with no era signal gets the live 12-worker values.
      expect(buildSecondsFor("Adept", { game: {} })).toBe(27);
      expect(buildSecondsFor("Adept", { game: null })).toBe(27);
    });

    test("entries 5.0.16 did not retune are the same in both eras", () => {
      const hints = { game: EIGHT_WORKER_GAME };
      expect(toStartSeconds("Stalker", 134, hints)).toBe(104);
      expect(toStartSeconds("Lair", 360, { ...hints, isBuilding: true })).toBe(303);
      expect(toStartSeconds("CyberneticsCore", 110, { ...hints, isBuilding: true })).toBe(110);
      expect(
        toStartSeconds("WarpGateResearch", 320, { ...hints, category: "upgrade" }),
      ).toBe(220);
      expect(Object.keys(EIGHT_WORKER_BUILD_SECONDS).sort()).toEqual(
        ["Adept", "DarkTemplar", "HighTemplar", "Reaper", "WarpGate"],
      );
    });
  });

  describe("isFinishTimeEvent", () => {
    test("plain structures are start-time events", () => {
      expect(isFinishTimeEvent("Pylon", { isBuilding: true })).toBe(false);
      expect(isFinishTimeEvent("CyberneticsCore", { isBuilding: true })).toBe(
        false,
      );
    });

    test("structure morphs are finish-time events", () => {
      expect(isFinishTimeEvent("Lair", { isBuilding: true })).toBe(true);
      expect(isFinishTimeEvent("Hive", { isBuilding: true })).toBe(true);
      expect(isFinishTimeEvent("OrbitalCommand", {})).toBe(true);
    });

    test("units are finish-time events", () => {
      expect(isFinishTimeEvent("Marine", {})).toBe(true);
      expect(isFinishTimeEvent("Mutalisk", {})).toBe(true);
    });

    test("upgrades are finish-time events", () => {
      expect(isFinishTimeEvent("Stimpack", {})).toBe(true);
      expect(isFinishTimeEvent("Anything", { category: "upgrade" })).toBe(true);
    });
  });
});
