import { describe, expect, it } from "vitest";
import {
  buildOrderUnitsAt,
  canonicalizeName,
  countBuildingsAt,
  countUpgradesAt,
  deriveUnitComposition,
  derivedDeathsFromTimeline,
  nearestTimelineEntry,
  type BuildEvent,
} from "../compositionAt";
import type { UnitTimelineEntry } from "../MacroBreakdownPanel.types";

/**
 * Locks in the cumulative-built semantics for the macro-breakdown
 * units roster. The reported regression: a Protoss player who built
 * 11 Immortals over a 19-minute game (most of them dying to siege
 * tank fire) saw "Immortal × 1" in the Units row, because the panel
 * read alive counts off the death-aware ``unit_timeline``. Buildings
 * and Upgrades on the same panel have always been cumulative built,
 * so the inconsistency made the Units row look broken.
 *
 * Fix: the Units roster now reads ``buildOrderUnitsAt`` like the
 * Buildings / Upgrades rows do. Death-aware ``unit_timeline`` stays
 * the source of truth for the chart's army-value LINE (alive
 * mineral+gas), so the chart and the roster intentionally disagree on
 * Immortal count: the chart line shows the unit's contribution
 * vanishing when it dies; the roster shows it was BUILT.
 */
describe("buildOrderUnitsAt — cumulative-built semantics", () => {
  it("counts every build event for the unit up to time t (regression: 11 Immortals built, only 1 alive)", () => {
    // 11 Immortals trained between 4:00 and 16:00. None of these
    // events know about death — the build log only records starts.
    const events: BuildEvent[] = Array.from({ length: 11 }, (_, i) => ({
      time: 240 + i * 60,
      name: "Immortal",
      is_building: false,
    }));
    const composition = buildOrderUnitsAt(events, 16 * 60);
    expect(composition.Immortal).toBe(11);
  });

  it("respects time cutoff — only events at-or-before t are counted", () => {
    const events: BuildEvent[] = [
      { time: 60, name: "Stalker", is_building: false },
      { time: 120, name: "Stalker", is_building: false },
      { time: 180, name: "Stalker", is_building: false },
      { time: 240, name: "Stalker", is_building: false },
    ];
    expect(buildOrderUnitsAt(events, 200).Stalker).toBe(3);
    expect(buildOrderUnitsAt(events, 60).Stalker).toBe(1);
    // Boundary: t equal to event time → included.
    expect(buildOrderUnitsAt(events, 240).Stalker).toBe(4);
  });

  it("skips buildings, workers, and noise — only army-relevant units count", () => {
    const events: BuildEvent[] = [
      { time: 10, name: "Probe", is_building: false },
      { time: 20, name: "Probe", is_building: false },
      { time: 30, name: "Pylon", is_building: true },
      { time: 40, name: "Gateway", is_building: true },
      { time: 50, name: "Stalker", is_building: false },
      { time: 60, name: "Immortal", is_building: false },
    ];
    const out = buildOrderUnitsAt(events, 9999);
    expect(out.Probe).toBeUndefined();
    expect(out.Pylon).toBeUndefined();
    expect(out.Gateway).toBeUndefined();
    expect(out.Stalker).toBe(1);
    expect(out.Immortal).toBe(1);
  });

  it("applies single-parent morphs (Hydralisk→Lurker decrements the parent)", () => {
    const events: BuildEvent[] = [
      ...Array.from({ length: 8 }, (_, i) => ({
        time: 100 + i * 5,
        name: "Hydralisk",
        is_building: false,
      })),
      ...Array.from({ length: 3 }, (_, i) => ({
        time: 200 + i * 5,
        name: "Lurker",
        is_building: false,
      })),
    ];
    const out = buildOrderUnitsAt(events, 9999);
    // 8 Hydras built, 3 morphed into Lurkers → 5 Hydras left, 3 Lurkers.
    expect(out.Hydralisk).toBe(5);
    expect(out.Lurker).toBe(3);
  });

  it("applies 2-parent morphs (Archon consumes 2 Templar parents, DT-preferred)", () => {
    const events: BuildEvent[] = [
      { time: 100, name: "DarkTemplar", is_building: false },
      { time: 110, name: "DarkTemplar", is_building: false },
      { time: 120, name: "HighTemplar", is_building: false },
      { time: 130, name: "HighTemplar", is_building: false },
      // 1 Archon — consumes 2 DTs first by the ARCHON_PARENTS rule.
      { time: 200, name: "Archon", is_building: false },
    ];
    const out = buildOrderUnitsAt(events, 9999);
    expect(out.Archon).toBe(1);
    expect(out.DarkTemplar ?? 0).toBe(0);
    expect(out.HighTemplar).toBe(2);
  });

  it("returns empty object for null / empty / non-array input", () => {
    expect(buildOrderUnitsAt(undefined, 100)).toEqual({});
    expect(buildOrderUnitsAt(null, 100)).toEqual({});
    expect(buildOrderUnitsAt([], 100)).toEqual({});
  });

  it("strips stance suffixes so a SiegeTank toggle doesn't double-count", () => {
    const events: BuildEvent[] = [
      { time: 100, name: "SiegeTank", is_building: false },
      { time: 110, name: "SiegeTankSieged", is_building: false },
    ];
    const out = buildOrderUnitsAt(events, 9999);
    expect(out.SiegeTank).toBe(2);
    expect(out.SiegeTankSieged).toBeUndefined();
  });
});

describe("canonicalizeName — sc2reader variant collapsing", () => {
  it("strips well-known stance suffixes (legacy regex path)", () => {
    expect(canonicalizeName("BurrowedRoach")).toBe("Roach");
    expect(canonicalizeName("Stalker")).toBe("Stalker");
  });

  it("folds Terran combat-posture / stance variants onto the canonical name", () => {
    expect(canonicalizeName("SiegeTankSieged")).toBe("SiegeTank");
    expect(canonicalizeName("VikingFighter")).toBe("Viking");
    expect(canonicalizeName("VikingAssault")).toBe("Viking");
    expect(canonicalizeName("HellionTank")).toBe("Hellbat");
    expect(canonicalizeName("ThorAP")).toBe("Thor");
    expect(canonicalizeName("ThorAA")).toBe("Thor");
    expect(canonicalizeName("LiberatorAG")).toBe("Liberator");
    expect(canonicalizeName("WidowMineBurrowed")).toBe("WidowMine");
  });

  it("folds Protoss warp-in cocoons + stance toggles onto the canonical unit", () => {
    expect(canonicalizeName("ZealotWarp")).toBe("Zealot");
    expect(canonicalizeName("StalkerWarp")).toBe("Stalker");
    expect(canonicalizeName("AdeptWarp")).toBe("Adept");
    expect(canonicalizeName("SentryWarp")).toBe("Sentry");
    expect(canonicalizeName("DarkTemplarWarp")).toBe("DarkTemplar");
    expect(canonicalizeName("HighTemplarWarp")).toBe("HighTemplar");
    expect(canonicalizeName("ImmortalWarp")).toBe("Immortal");
    expect(canonicalizeName("ColossusWarp")).toBe("Colossus");
    expect(canonicalizeName("ObserverSiegeMode")).toBe("Observer");
    expect(canonicalizeName("WarpPrismPhasing")).toBe("WarpPrism");
  });

  it("folds Zerg burrow + MP + cocoon variants onto the canonical unit", () => {
    // MP is a Wings/HotS data-version tag, not a stance — same unit on
    // current LotV replays. Folding lets one chip + one icon represent
    // the Lurker line across all replay generations.
    expect(canonicalizeName("LurkerMP")).toBe("Lurker");
    expect(canonicalizeName("LurkerMPBurrowed")).toBe("Lurker");
    expect(canonicalizeName("LurkerBurrowed")).toBe("Lurker");
    expect(canonicalizeName("SwarmHostMP")).toBe("SwarmHost");
    expect(canonicalizeName("SwarmHostMPBurrowed")).toBe("SwarmHost");
    expect(canonicalizeName("BanelingMP")).toBe("Baneling");
    expect(canonicalizeName("BanelingBurrowed")).toBe("Baneling");
    expect(canonicalizeName("BanelingCocoon")).toBe("Baneling");
    expect(canonicalizeName("RoachBurrowed")).toBe("Roach");
    expect(canonicalizeName("RoachMP")).toBe("Roach");
    expect(canonicalizeName("ZerglingBurrowed")).toBe("Zergling");
    expect(canonicalizeName("HydraliskBurrowed")).toBe("Hydralisk");
    expect(canonicalizeName("InfestorBurrowed")).toBe("Infestor");
    expect(canonicalizeName("RavagerBurrowed")).toBe("Ravager");
    expect(canonicalizeName("RavagerCocoon")).toBe("Ravager");
    expect(canonicalizeName("QueenBurrowed")).toBe("Queen");
    expect(canonicalizeName("BroodLordCocoon")).toBe("BroodLord");
    expect(canonicalizeName("Broodlord")).toBe("BroodLord");
    expect(canonicalizeName("OverseerSiegeMode")).toBe("Overseer");
    expect(canonicalizeName("OverseerCocoon")).toBe("Overseer");
    expect(canonicalizeName("OverlordTransport")).toBe("Overlord");
    expect(canonicalizeName("OverlordTransportCocoon")).toBe("Overlord");
  });

  it("regression: an 11-Immortal opener can't split into Immortal + ImmortalWarp chips", () => {
    // The reported bug: 11 Immortals built, 1 showing with the correct
    // icon (UnitDoneEvent → name "Immortal") and 10 showing as a text-
    // fallback "Im" chip (UnitInitEvent → name "ImmortalWarp"). After
    // canonicalisation both source names collapse into a single
    // ``Immortal`` bucket so the count chip reads 11 ×.
    const events: BuildEvent[] = [
      { time: 240, name: "Immortal", is_building: false },
      ...Array.from({ length: 10 }, (_, i) => ({
        time: 250 + i * 30,
        name: "ImmortalWarp",
        is_building: false,
      })),
    ];
    const out = buildOrderUnitsAt(events, 9999);
    expect(out.Immortal).toBe(11);
    expect(out.ImmortalWarp).toBeUndefined();
  });

  it("handles empty / falsy input safely", () => {
    expect(canonicalizeName("")).toBe("");
  });
});

describe("countBuildingsAt — Buildings row parity", () => {
  it("counts buildings cumulatively and applies the WarpGate→Gateway morph", () => {
    const events: BuildEvent[] = [
      { time: 30, name: "Gateway", is_building: true },
      { time: 60, name: "Gateway", is_building: true },
      // First Gateway → WarpGate at 4:00.
      { time: 240, name: "WarpGate", is_building: true },
    ];
    const out = countBuildingsAt(events, 9999);
    expect(out.Gateway).toBe(1);
    expect(out.WarpGate).toBe(1);
  });

  it("ignores non-building events", () => {
    const events: BuildEvent[] = [
      { time: 30, name: "Gateway", is_building: true },
      { time: 60, name: "Stalker", is_building: false },
      { time: 90, name: "Probe", is_building: false },
    ];
    const out = countBuildingsAt(events, 9999);
    expect(out.Gateway).toBe(1);
    expect(out.Stalker).toBeUndefined();
    expect(out.Probe).toBeUndefined();
  });
});

describe("countUpgradesAt — Upgrades row", () => {
  it("counts only entries tagged ``category: upgrade``", () => {
    const events: BuildEvent[] = [
      { time: 240, name: "WarpGateResearch", is_building: false, category: "upgrade" },
      { time: 300, name: "Charge", is_building: false, category: "upgrade" },
      { time: 360, name: "Stalker", is_building: false, category: "unit" },
    ];
    const out = countUpgradesAt(events, 9999);
    expect(out.WarpGateResearch).toBe(1);
    expect(out.Charge).toBe(1);
    expect(out.Stalker).toBeUndefined();
  });

  it("tier-collapses weapons/armor families so only the highest tier shows", () => {
    // A player who researched +1 then +2 Ground Weapons should NOT see
    // two chips — the +2 chip is enough because it implies the +1
    // baseline (and matches the in-game vocabulary of "we're on +2").
    // The chip ``count`` is the tier number itself so the user reads
    // "Ground Weapons × 2", not "× 1". Tested across all races and
    // all the upgrade families so the collapse fires universally.
    const events: BuildEvent[] = [
      { time: 240, name: "ProtossGroundWeaponsLevel1", is_building: false, category: "upgrade" },
      { time: 480, name: "ProtossGroundWeaponsLevel2", is_building: false, category: "upgrade" },
      { time: 720, name: "ProtossGroundArmorLevel1", is_building: false, category: "upgrade" },
      { time: 800, name: "TerranInfantryWeaponsLevel1", is_building: false, category: "upgrade" },
      { time: 850, name: "TerranInfantryWeaponsLevel2", is_building: false, category: "upgrade" },
      { time: 880, name: "TerranInfantryWeaponsLevel3", is_building: false, category: "upgrade" },
      { time: 900, name: "ZergMeleeAttacksLevel1", is_building: false, category: "upgrade" },
      { time: 960, name: "ZergMeleeAttacksLevel2", is_building: false, category: "upgrade" },
      { time: 1000, name: "Charge", is_building: false, category: "upgrade" },
    ];
    const out = countUpgradesAt(events, 9999);
    // Highest tier per family, chip count = tier number.
    expect(out.ProtossGroundWeaponsLevel2).toBe(2);
    expect(out.ProtossGroundWeaponsLevel1).toBeUndefined();
    expect(out.ProtossGroundArmorLevel1).toBe(1); // tier 1, displays as 1
    expect(out.TerranInfantryWeaponsLevel3).toBe(3);
    expect(out.TerranInfantryWeaponsLevel1).toBeUndefined();
    expect(out.TerranInfantryWeaponsLevel2).toBeUndefined();
    expect(out.ZergMeleeAttacksLevel2).toBe(2);
    expect(out.ZergMeleeAttacksLevel1).toBeUndefined();
    // Non-tiered upgrade unaffected — Charge fires once per game.
    expect(out.Charge).toBe(1);
  });

  it("collapses across the singular/plural Armor spelling drift", () => {
    // Some replays emit ``ProtossGroundArmorLevel1`` (singular Armor),
    // others emit ``ProtossGroundArmorsLevel2`` (plural Armors) for the
    // same upgrade line. Both must collapse onto a single family so the
    // tier dedup fires correctly across the spelling drift.
    const events: BuildEvent[] = [
      { time: 240, name: "ProtossGroundArmorLevel1", is_building: false, category: "upgrade" },
      { time: 480, name: "ProtossGroundArmorsLevel2", is_building: false, category: "upgrade" },
    ];
    const out = countUpgradesAt(events, 9999);
    expect(out.ProtossGroundArmorsLevel2).toBe(2);
    expect(out.ProtossGroundArmorLevel1).toBeUndefined();
  });

  it("collapses across the Zerg Weapons/Attacks + Armor/Carapace drift", () => {
    const events: BuildEvent[] = [
      { time: 100, name: "ZergMissileWeaponsLevel1", is_building: false, category: "upgrade" },
      { time: 200, name: "ZergMissileAttacksLevel2", is_building: false, category: "upgrade" },
      { time: 300, name: "ZergGroundArmorsLevel1", is_building: false, category: "upgrade" },
      { time: 400, name: "ZergGroundCarapaceLevel2", is_building: false, category: "upgrade" },
    ];
    const out = countUpgradesAt(events, 9999);
    expect(out.ZergMissileAttacksLevel2).toBe(2);
    expect(out.ZergMissileWeaponsLevel1).toBeUndefined();
    expect(out.ZergGroundCarapaceLevel2).toBe(2);
    expect(out.ZergGroundArmorsLevel1).toBeUndefined();
  });

  it("collapses Terran Vehicle/Ship armor variants onto a single family", () => {
    // TerranVehicleArmors / TerranVehicleAndShipArmors /
    // TerranShipArmors / TerranVehicleandShipPlating all name the same
    // in-game research in different patches. A player who got +1 then
    // +2 should see only the +2 chip regardless of which spellings
    // sc2reader emitted.
    const events: BuildEvent[] = [
      { time: 100, name: "TerranVehicleAndShipArmorsLevel1", is_building: false, category: "upgrade" },
      { time: 200, name: "TerranVehicleArmorsLevel2", is_building: false, category: "upgrade" },
      { time: 300, name: "TerranShipArmorsLevel3", is_building: false, category: "upgrade" },
    ];
    const out = countUpgradesAt(events, 9999);
    // All three name the same family; +3 wins, chip count = 3.
    expect(out.TerranShipArmorsLevel3).toBe(3);
    expect(out.TerranVehicleAndShipArmorsLevel1).toBeUndefined();
    expect(out.TerranVehicleArmorsLevel2).toBeUndefined();
  });

  it("respects the time cutoff for tier-collapse", () => {
    // The collapse must only consider events at-or-before t — a future
    // higher tier shouldn't suppress a current lower tier.
    const events: BuildEvent[] = [
      { time: 240, name: "ProtossGroundWeaponsLevel1", is_building: false, category: "upgrade" },
      { time: 480, name: "ProtossGroundWeaponsLevel2", is_building: false, category: "upgrade" },
      { time: 720, name: "ProtossGroundWeaponsLevel3", is_building: false, category: "upgrade" },
    ];
    // At t=400 only +1 has happened — chip count is 1.
    const a = countUpgradesAt(events, 400);
    expect(a.ProtossGroundWeaponsLevel1).toBe(1);
    expect(a.ProtossGroundWeaponsLevel2).toBeUndefined();
    expect(a.ProtossGroundWeaponsLevel3).toBeUndefined();
    // At t=500 +1 and +2 have happened — only +2 shows, count is 2.
    const b = countUpgradesAt(events, 500);
    expect(b.ProtossGroundWeaponsLevel2).toBe(2);
    expect(b.ProtossGroundWeaponsLevel1).toBeUndefined();
  });

  it("keeps families with the same suffix distinct (Weapons ≠ Armor)", () => {
    // Sanity-check: the collapse must not merge across different
    // upgrade lines that happen to share a level number. Every family
    // ends up with chip count = 2 because that's the tier each
    // family reached.
    const events: BuildEvent[] = [
      { time: 240, name: "ProtossGroundWeaponsLevel2", is_building: false, category: "upgrade" },
      { time: 300, name: "ProtossGroundArmorLevel2", is_building: false, category: "upgrade" },
      { time: 360, name: "ProtossShieldsLevel2", is_building: false, category: "upgrade" },
      { time: 420, name: "ProtossAirWeaponsLevel2", is_building: false, category: "upgrade" },
      { time: 480, name: "ProtossAirArmorLevel2", is_building: false, category: "upgrade" },
    ];
    const out = countUpgradesAt(events, 9999);
    expect(Object.keys(out).length).toBe(5);
    expect(out.ProtossGroundWeaponsLevel2).toBe(2);
    expect(out.ProtossGroundArmorLevel2).toBe(2);
    expect(out.ProtossShieldsLevel2).toBe(2);
    expect(out.ProtossAirWeaponsLevel2).toBe(2);
    expect(out.ProtossAirArmorLevel2).toBe(2);
  });

  it("chip count for tiered upgrades is the TIER number, not the build-event count", () => {
    // This is the explicit lock for the UX rule: a +2 upgrade reads
    // as "× 2" on the chip, a +3 as "× 3". Without this the chip
    // showed "× 1" for everything past tier 1 (literal build count
    // after the tier collapse) — confusing because "× 1" reads as
    // "you only got +1" even when the player is on +3.
    const cases: Array<{ tier: number; raw: string }> = [
      { tier: 1, raw: "ProtossShieldsLevel1" },
      { tier: 2, raw: "ProtossShieldsLevel2" },
      { tier: 3, raw: "ProtossShieldsLevel3" },
      { tier: 2, raw: "TerranInfantryArmorsLevel2" },
      { tier: 3, raw: "ZergFlyerCarapaceLevel3" },
    ];
    for (const { tier, raw } of cases) {
      const events: BuildEvent[] = [
        { time: 100 + tier * 100, name: raw, is_building: false, category: "upgrade" },
      ];
      // Also seed with earlier-tier events to confirm the collapse
      // doesn't accidentally aggregate them.
      for (let t = 1; t < tier; t++) {
        const earlier = raw.replace(/Level[1-3]$/, `Level${t}`);
        events.unshift({
          time: t * 100,
          name: earlier,
          is_building: false,
          category: "upgrade",
        });
      }
      const out = countUpgradesAt(events, 9999);
      expect(out[raw]).toBe(tier);
    }
  });

  it("uses complete_time for the cutoff so in-progress research stays off the chip row", () => {
    // Regression: the API rewinds upgrade events to their START time
    // (so the build-order timeline reads as "the moment the player
    // clicked Research"). Pre-fix, the chip row reused that same
    // start-time field for its ``time <= t`` filter, which made every
    // upgrade pop into the macro-breakdown roster the instant the
    // research began — well before the buff actually applied.
    //
    // ``complete_time`` is the original recorded timestamp (i.e. when
    // sc2reader's UpgradeCompleteEvent fired), so filtering on it gives
    // the user the "what's active right now" semantics they expect.
    const events: BuildEvent[] = [
      {
        // +1 Ground Weapons: 128s research, started 4:00, completes 6:08.
        time: 240,
        complete_time: 368,
        name: "ProtossGroundWeaponsLevel1",
        is_building: false,
        category: "upgrade",
      },
    ];
    // At 5:00 the research is in-progress. It must NOT appear yet.
    const midway = countUpgradesAt(events, 300);
    expect(midway.ProtossGroundWeaponsLevel1).toBeUndefined();
    // One second before completion — still in-progress.
    const justBefore = countUpgradesAt(events, 367);
    expect(justBefore.ProtossGroundWeaponsLevel1).toBeUndefined();
    // At the exact completion tick the chip appears.
    const atComplete = countUpgradesAt(events, 368);
    expect(atComplete.ProtossGroundWeaponsLevel1).toBe(1);
    // Long after completion the chip remains.
    const after = countUpgradesAt(events, 600);
    expect(after.ProtossGroundWeaponsLevel1).toBe(1);
  });

  it("falls back to time when complete_time is absent (older API payloads)", () => {
    // Pre-fix payloads omit ``complete_time`` entirely. The chip row
    // must still render those, just with the (legacy, slightly-early)
    // start-time semantics — better to show the upgrade a research-
    // duration early than to drop it from the roster outright.
    const events: BuildEvent[] = [
      { time: 240, name: "Charge", is_building: false, category: "upgrade" },
    ];
    expect(countUpgradesAt(events, 200).Charge).toBeUndefined();
    expect(countUpgradesAt(events, 240).Charge).toBe(1);
  });

  it("scans all events when sorted-by-start order disagrees with completion order", () => {
    // Events come in sorted by START time. A short upgrade started
    // later can complete BEFORE a long upgrade started earlier — so
    // the iteration cannot early-break on the cutoff comparison.
    // Concussive Shells (43s) starting at 0:30 completes at 1:13;
    // +1 Ground Weapons (128s) starting at 0:00 completes at 2:08.
    const events: BuildEvent[] = [
      {
        time: 0,
        complete_time: 128,
        name: "ProtossGroundWeaponsLevel1",
        is_building: false,
        category: "upgrade",
      },
      {
        time: 30,
        complete_time: 73,
        name: "ConcussiveShells",
        is_building: false,
        category: "upgrade",
      },
    ];
    // At t=80, Concussive is done (complete=73) but Weapons isn't
    // (complete=128). The chip row must show Concussive even though
    // Weapons appears first in the iteration and fails the cutoff.
    const out = countUpgradesAt(events, 80);
    expect(out.ConcussiveShells).toBe(1);
    expect(out.ProtossGroundWeaponsLevel1).toBeUndefined();
  });
});

describe("deriveUnitComposition — chart's army-value fallback + roster source", () => {
  /*
   * deriveUnitComposition powers BOTH the chart's army-value line
   * (when sc2reader's ``army_value`` isn't on the wire) AND the unit
   * roster below the chart. It needs alive-aware (timeline-preferred,
   * build-order + deaths hybrid) semantics so the chip count and the
   * chart line agree: a Protoss that built 11 Immortals and lost 10
   * reads as 1 alive on both surfaces, and the chart line correctly
   * dips as the 10 die.
   */
  it("prefers timeline when populated for the side under inspection", () => {
    const timeline: UnitTimelineEntry[] = [
      { time: 0, my: {}, opp: {} },
      { time: 60, my: { Stalker: 3, Immortal: 1 }, opp: {} },
    ];
    const buildEvents: BuildEvent[] = [
      { time: 30, name: "Stalker", is_building: false },
      { time: 40, name: "Stalker", is_building: false },
      { time: 50, name: "Stalker", is_building: false },
      { time: 55, name: "Immortal", is_building: false },
    ];
    const out = deriveUnitComposition({
      timeline,
      buildEvents,
      side: "my",
      t: 60,
    });
    expect(out.source).toBe("timeline");
    expect(out.units).toEqual({ Stalker: 3, Immortal: 1 });
  });

  it("folds variants emitted by older agent versions on the timeline path", () => {
    // Pre-v0.5 agents uploaded unit_timeline before
    // ``_canonical_unit_name`` was applied — so an old payload could
    // carry both ``Infestor: 1`` and ``InfestorBurrowed: 9``. The
    // roster should render a single ``Infestor × 10`` chip with the
    // correct icon, not two chips (one icon, one ``IN`` text fallback).
    const timeline: UnitTimelineEntry[] = [
      { time: 0, my: {}, opp: {} },
      {
        time: 60,
        my: { Infestor: 1, InfestorBurrowed: 9, RoachBurrowed: 5, Roach: 3 },
        opp: {},
      },
    ];
    const out = deriveUnitComposition({
      timeline,
      buildEvents: undefined,
      side: "my",
      t: 60,
    });
    expect(out.source).toBe("timeline");
    expect(out.units).toEqual({ Infestor: 10, Roach: 8 });
  });

  it("falls through to build_order when the timeline side is empty AND build-order has events", () => {
    const timeline: UnitTimelineEntry[] = [
      { time: 0, my: {}, opp: { Drone: 12 } },
      { time: 60, my: {}, opp: { Drone: 14 } },
    ];
    const buildEvents: BuildEvent[] = [
      { time: 30, name: "Stalker", is_building: false },
      { time: 40, name: "Stalker", is_building: false },
    ];
    const out = deriveUnitComposition({
      timeline,
      buildEvents,
      side: "my",
      t: 60,
    });
    // Has timeline but ``my`` side is empty AND opponent isn't empty
    // at the same step — that's not the "both sides empty" gap case,
    // so we fall through to build_order. Source carries that fact.
    expect(out.source).toBe("build_order");
    expect(out.units.Stalker).toBe(2);
  });

  it("returns empty source when nothing's available", () => {
    const out = deriveUnitComposition({
      timeline: undefined,
      buildEvents: undefined,
      side: "my",
      t: 60,
    });
    expect(out.source).toBe("empty");
    expect(out.units).toEqual({});
  });
});

describe("derivedDeathsFromTimeline — death extraction from timeline diffs", () => {
  it("records (prev - cur) deaths anchored to the later sample", () => {
    const timeline: UnitTimelineEntry[] = [
      { time: 0, my: {}, opp: {} },
      { time: 60, my: { Stalker: 10 }, opp: {} },
      { time: 120, my: { Stalker: 6 }, opp: {} },
    ];
    const deaths = derivedDeathsFromTimeline(timeline, "my");
    expect(deaths).toEqual([{ time: 120, name: "Stalker", count: 4 }]);
  });

  it("treats both-sides-empty drop as a data gap (no spurious deaths)", () => {
    const timeline: UnitTimelineEntry[] = [
      { time: 0, my: { Stalker: 5 }, opp: { Roach: 3 } },
      // Extractor produced an empty entry — both sides go to zero
      // simultaneously. Pre-fix this synthesised 5 Stalker deaths +
      // 3 Roach deaths and dropped the chart line to 0.
      { time: 30, my: {}, opp: {} },
    ];
    const deaths = derivedDeathsFromTimeline(timeline, "my");
    expect(deaths).toEqual([]);
  });

  it("returns empty array for null / single-entry input", () => {
    expect(derivedDeathsFromTimeline(undefined, "my")).toEqual([]);
    expect(derivedDeathsFromTimeline([], "my")).toEqual([]);
    expect(
      derivedDeathsFromTimeline(
        [{ time: 0, my: { Stalker: 1 }, opp: {} }],
        "my",
      ),
    ).toEqual([]);
  });
});

describe("nearestTimelineEntry", () => {
  it("returns the entry with the smallest |entry.time - t|", () => {
    const timeline: UnitTimelineEntry[] = [
      { time: 0, my: {}, opp: {} },
      { time: 30, my: {}, opp: {} },
      { time: 60, my: {}, opp: {} },
      { time: 90, my: {}, opp: {} },
    ];
    expect(nearestTimelineEntry(timeline, 14)?.time).toBe(0);
    expect(nearestTimelineEntry(timeline, 16)?.time).toBe(30);
    expect(nearestTimelineEntry(timeline, 9999)?.time).toBe(90);
  });

  it("returns null for empty / null input", () => {
    expect(nearestTimelineEntry(undefined, 0)).toBeNull();
    expect(nearestTimelineEntry([], 0)).toBeNull();
  });
});
