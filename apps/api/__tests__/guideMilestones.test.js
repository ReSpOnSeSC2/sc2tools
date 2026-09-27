// @ts-nocheck
"use strict";

/**
 * config/guideMilestones.js — the milestone catalog must stay in lockstep
 * with the API's build-log parser: every wire name is a known building or
 * upgrade (case-insensitively), and each milestone's ``event`` matches how
 * the parser + buildDurations classify that name (structures are logged at
 * start, morphs and upgrades at completion).
 */

const {
  GUIDE_MILESTONES,
  milestonesForRace,
  milestoneByKey,
} = require("../src/config/guideMilestones");
const {
  KNOWN_BUILDING_NAMES,
  KNOWN_UPGRADE_NAMES,
  isKnownBuilding,
  isKnownUpgrade,
} = require("../src/services/knownBuildings");
const { parseBuildLogLines } = require("../src/services/perGameCompute");
const { isFinishTimeEvent } = require("../src/services/buildDurations");

const KNOWN_LOWER = new Set(
  [...KNOWN_BUILDING_NAMES, ...KNOWN_UPGRADE_NAMES].map((n) => n.toLowerCase()),
);

function allMilestones() {
  return Object.entries(GUIDE_MILESTONES).flatMap(([race, list]) => list.map((m) => ({ race, m })));
}

describe("guide milestone catalog", () => {
  test("every race has an ordered, non-empty list with unique keys", () => {
    for (const race of ["P", "T", "Z"]) {
      const list = GUIDE_MILESTONES[race];
      expect(list.length).toBeGreaterThan(0);
      expect(new Set(list.map((m) => m.key)).size).toBe(list.length);
    }
  });

  test("entries are well-formed", () => {
    for (const { m } of allMilestones()) {
      expect(typeof m.key).toBe("string");
      expect(m.key).toMatch(/^[A-Za-z0-9#]+$/); // safe as a Mongo field key
      expect(typeof m.label).toBe("string");
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.names.length).toBeGreaterThan(0);
      expect([1, 2, 3]).toContain(m.occurrence);
      expect(["start", "finish"]).toContain(m.event);
    }
  });

});

describe("guide milestone catalog vs the build-log parser", () => {
  test("every wire name is a known building or upgrade (case-insensitive)", () => {
    for (const { m } of allMilestones()) {
      for (const name of m.names) {
        const known = isKnownBuilding(name) || isKnownUpgrade(name) || KNOWN_LOWER.has(name.toLowerCase());
        expect({ key: m.key, name, known }).toEqual({ key: m.key, name, known: true });
      }
    }
  });

  test("event matches the parser's start/finish classification", () => {
    for (const { m } of allMilestones()) {
      for (const name of m.names) {
        const [ev] = parseBuildLogLines([`[3:00] ${name}`], null);
        expect(ev).toBeDefined();
        const finish = isFinishTimeEvent(ev.name, { isBuilding: ev.is_building, category: ev.category });
        expect({ key: m.key, name, event: finish ? "finish" : "start" })
          .toEqual({ key: m.key, name, event: m.event });
      }
    }
  });

  test("names never logged by the replay engine are absent", () => {
    // SKIP_BUILDINGS in apps/replay-engine/core/event_extractor.py
    const names = allMilestones().flatMap(({ m }) => m.names.map((n) => n.toLowerCase()));
    expect(names).not.toContain("supplydepot");
    expect(names).not.toContain("shieldbattery");
  });

});

describe("guide milestone lookups", () => {
  test("expansion milestones count the starting town hall", () => {
    expect(milestoneByKey("P", "Nexus#2")).toMatchObject({ names: ["Nexus"], occurrence: 2 });
    expect(milestoneByKey("T", "CommandCenter#3")).toMatchObject({ names: ["CommandCenter"], occurrence: 3 });
    expect(milestoneByKey("Z", "Hatchery#2")).toMatchObject({ names: ["Hatchery"], occurrence: 2 });
  });

  test("lookups by race letter or race word", () => {
    expect(milestonesForRace("Protoss")).toBe(GUIDE_MILESTONES.P);
    expect(milestonesForRace("zerg")).toBe(GUIDE_MILESTONES.Z);
    expect(milestonesForRace("Random")).toEqual([]);
    expect(milestonesForRace(undefined)).toEqual([]);
    expect(milestoneByKey("P", "BlinkTech")).toMatchObject({ label: "Blink", event: "finish" });
    expect(milestoneByKey("P", "nope")).toBeNull();
  });

  test("the catalog is frozen", () => {
    expect(Object.isFrozen(GUIDE_MILESTONES)).toBe(true);
    expect(Object.isFrozen(GUIDE_MILESTONES.P)).toBe(true);
    expect(Object.isFrozen(GUIDE_MILESTONES.P[0])).toBe(true);
  });
});
