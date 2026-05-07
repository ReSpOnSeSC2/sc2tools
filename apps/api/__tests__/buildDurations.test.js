// @ts-nocheck
"use strict";

const {
  toStartSeconds,
  isFinishTimeEvent,
  buildSecondsFor,
} = require("../src/services/buildDurations");

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

    test("Terran add-on / surfacing morphs subtract their duration", () => {
      expect(toStartSeconds("OrbitalCommand", 200)).toBe(175);
      expect(toStartSeconds("PlanetaryFortress", 400)).toBe(364);
    });

    test("units rewind by their train/morph duration", () => {
      // Stalker is a 30s build out of a Gateway.
      expect(toStartSeconds("Stalker", 134)).toBe(104);
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
