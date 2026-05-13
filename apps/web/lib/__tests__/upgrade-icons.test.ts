import { describe, expect, it } from "vitest";
import {
  AVAILABLE_ICONS,
  getIconPath,
  normalizeIconName,
} from "@/lib/sc2-icons";
import {
  normalizeBuildEvent,
  normalizeBuildEvents,
  type BuildOrderEvent,
} from "@/lib/build-events";
import { spaEventToWhat, eventsToSourceRows } from "@/lib/build-rules";

/**
 * End-to-end coverage for the upgrade icon rollout:
 *   - The sc2reader ``upgrade_type_name`` form (canonical agent key)
 *     resolves to an existing PNG on disk via either a direct match
 *     in the UPGRADES set or a SYNONYM entry.
 *   - Build-order events whose API ``category`` is ``"upgrade"`` flow
 *     through ``normalizeBuildEvent`` with ``category === "upgrade"``
 *     and a non-null ``iconPath`` pointing at the right PNG.
 *   - The Save-as-Build pipeline (``spaEventToWhat`` →
 *     ``eventsToSourceRows``) emits ``Research<Name>`` tokens for each
 *     upgrade and flags every one as a tech-defining event, so the
 *     custom build editor surfaces them with the cyan accent + star.
 */

const AGENT_UPGRADE_NAMES = [
  // Protoss
  "WarpGateResearch", "Charge", "BlinkTech", "AdeptPiercingAttack",
  "PsiStormTech", "DarkTemplarBlinkUpgrade", "ExtendedThermalLance",
  "GraviticDrive", "ObserverGraviticBooster", "PhoenixRangeUpgrade",
  "VoidRaySpeedUpgrade", "TempestGroundAttackUpgrade",
  "ProtossGroundWeaponsLevel1", "ProtossGroundWeaponsLevel2",
  "ProtossGroundWeaponsLevel3",
  "ProtossGroundArmorsLevel1", "ProtossGroundArmorsLevel2",
  "ProtossGroundArmorsLevel3",
  "ProtossShieldsLevel1", "ProtossShieldsLevel2", "ProtossShieldsLevel3",
  "ProtossAirWeaponsLevel1", "ProtossAirWeaponsLevel2",
  "ProtossAirWeaponsLevel3",
  "ProtossAirArmorsLevel1", "ProtossAirArmorsLevel2",
  "ProtossAirArmorsLevel3",
  // Terran
  "Stimpack", "ShieldWall", "PunisherGrenades", "HiSecAutoTracking",
  "TerranBuildingArmor", "DrillClaws", "CycloneLockOnDamageUpgrade",
  "HighCapacityBarrels", "SmartServos", "BansheeCloak", "BansheeSpeed",
  "RavenCorvidReactor", "EnhancedShockwaves", "MedivacCaduceusReactor",
  "MedivacIncreaseSpeedBoost", "LiberatorAGRangeUpgrade",
  "BattlecruiserEnableSpecializations", "PersonalCloaking",
  "TerranInfantryWeaponsLevel1", "TerranInfantryWeaponsLevel2",
  "TerranInfantryWeaponsLevel3",
  "TerranInfantryArmorsLevel1", "TerranInfantryArmorsLevel2",
  "TerranInfantryArmorsLevel3",
  "TerranVehicleWeaponsLevel1", "TerranVehicleWeaponsLevel2",
  "TerranVehicleWeaponsLevel3",
  "TerranVehicleAndShipArmorsLevel1", "TerranVehicleAndShipArmorsLevel2",
  "TerranVehicleAndShipArmorsLevel3",
  "TerranShipWeaponsLevel1", "TerranShipWeaponsLevel2",
  "TerranShipWeaponsLevel3",
  "YamatoCannon",
  // Zerg
  "Burrow", "PneumatizedCarapace", "OverlordSpeed",
  "ZerglingMetabolicBoost", "ZerglingMovementSpeed",
  "ZerglingAdrenalGlands", "CentrifugalHooks", "CentrificalHooks",
  "GlialReconstitution", "TunnelingClaws", "EvolveMuscularAugments",
  "EvolveGroovedSpines", "LurkerRange", "DiggingClaws",
  "AnabolicSynthesis", "ChitinousPlating", "InfestorEnergyUpgrade",
  "NeuralParasite",
  "ZergMissileWeaponsLevel1", "ZergMissileWeaponsLevel2",
  "ZergMissileWeaponsLevel3",
  "ZergMeleeWeaponsLevel1", "ZergMeleeWeaponsLevel2",
  "ZergMeleeWeaponsLevel3",
  "ZergGroundArmorsLevel1", "ZergGroundArmorsLevel2",
  "ZergGroundArmorsLevel3",
  "ZergFlyerWeaponsLevel1", "ZergFlyerWeaponsLevel2",
  "ZergFlyerWeaponsLevel3",
  "ZergFlyerArmorsLevel1", "ZergFlyerArmorsLevel2",
  "ZergFlyerArmorsLevel3",
];

describe("sc2-icons — upgrade icon coverage", () => {
  it("resolves every sc2reader upgrade name to a known PNG on disk", () => {
    const misses: string[] = [];
    for (const name of AGENT_UPGRADE_NAMES) {
      const path = getIconPath(name, "upgrade");
      if (!path) {
        misses.push(name);
        continue;
      }
      // Path is always rooted at "/icons/sc2/upgrades/...".
      expect(path.startsWith("/icons/sc2/upgrades/")).toBe(true);
      const rel = path.replace(/^\/icons\/sc2\//, "");
      expect(AVAILABLE_ICONS.has(rel)).toBe(true);
    }
    expect(misses).toEqual([]);
  });

  it("normalizes display-form names too (humans typing 'Combat Shield')", () => {
    expect(getIconPath("Combat Shield", "upgrade")).toBe(
      "/icons/sc2/upgrades/combatshield.png",
    );
    expect(getIconPath("Resonating Glaives", "upgrade")).toBe(
      "/icons/sc2/upgrades/resonatingglaives.png",
    );
    expect(getIconPath("Adrenal Glands", "upgrade")).toBe(
      "/icons/sc2/upgrades/adrenalglands.png",
    );
    expect(getIconPath("Pneumatized Carapace", "upgrade")).toBe(
      "/icons/sc2/upgrades/pneumatizedcarapace.png",
    );
  });

  it("collapses sc2reader variants onto the same canonical PNG", () => {
    // OverlordSpeed and PneumatizedCarapace are two sc2reader names for
    // the same in-game upgrade — both should hit the same file.
    const a = getIconPath("OverlordSpeed", "upgrade");
    const b = getIconPath("PneumatizedCarapace", "upgrade");
    expect(a).toBe(b);
    expect(a).toBe("/icons/sc2/upgrades/pneumatizedcarapace.png");

    // BlinkTech and the legacy "Blink" alias resolve to one file.
    expect(getIconPath("BlinkTech", "upgrade")).toBe(
      "/icons/sc2/upgrades/blink.png",
    );
    expect(getIconPath("Blink", "upgrade")).toBe(
      "/icons/sc2/upgrades/blink.png",
    );

    // CentrificalHooks (sc2reader typo) and CentrifugalHooks fold.
    expect(getIconPath("CentrificalHooks", "upgrade")).toBe(
      "/icons/sc2/upgrades/centrifugalhooks.png",
    );
    expect(getIconPath("CentrifugalHooks", "upgrade")).toBe(
      "/icons/sc2/upgrades/centrifugalhooks.png",
    );
  });

  it("normalizeIconName strips levels suffix consistently", () => {
    expect(normalizeIconName("ProtossGroundWeaponsLevel2")).toBe(
      "protossgroundweaponslevel2",
    );
    expect(getIconPath("ProtossGroundWeaponsLevel2", "upgrade")).toBe(
      "/icons/sc2/upgrades/protossgroundweapons2.png",
    );
  });
});

describe("build-events — upgrade rows flow through normalizeBuildEvent", () => {
  it("preserves category=upgrade from the API and resolves the icon", () => {
    const ev: BuildOrderEvent = {
      time: 180,
      time_display: "3:00",
      name: "WarpGateResearch",
      category: "upgrade",
      is_building: false,
    };
    const row = normalizeBuildEvent(ev, 0);
    expect(row.category).toBe("upgrade");
    expect(row.iconKind).toBe("upgrade");
    expect(row.iconName).toBe("warpgateresearch");
    expect(row.iconPath).toBe("/icons/sc2/upgrades/warpgateresearch.png");
  });

  it("uses the SYNONYM-resolved key as iconName, not the raw input", () => {
    // Pre-fix bug: ``BlinkTech`` matched via SYNONYM but iconName was
    // ``blinktech`` (the input) — downstream callers reconstructed the
    // path as ``/icons/sc2/upgrades/blinktech.png``, which 404s. The
    // fixed matchName extracts the resolved key from the icon URL.
    const ev: BuildOrderEvent = {
      time: 240,
      name: "BlinkTech",
      category: "upgrade",
      is_building: false,
    };
    const row = normalizeBuildEvent(ev, 0);
    expect(row.iconName).toBe("blink");
    expect(row.iconPath).toBe("/icons/sc2/upgrades/blink.png");
  });

  it("falls back to 'upgrade' category when API hint says so", () => {
    // Even if the icon match would think this is a unit (unlikely for
    // research names), the API's category=upgrade hint wins.
    const ev: BuildOrderEvent = {
      time: 300,
      name: "Stimpack",
      category: "upgrade",
      is_building: false,
    };
    const row = normalizeBuildEvent(ev, 0);
    expect(row.category).toBe("upgrade");
    expect(row.iconPath).toBe("/icons/sc2/upgrades/stim.png");
  });

  it("retains upgrade rows alongside unit + building rows", () => {
    const events: BuildOrderEvent[] = [
      { time: 30, name: "SpawningPool", category: "building", is_building: true },
      { time: 60, name: "Zergling", category: "unit", is_building: false },
      { time: 180, name: "ZerglingMovementSpeed", category: "upgrade", is_building: false },
      { time: 240, name: "BanelingNest", category: "building", is_building: true },
      { time: 360, name: "CentrifugalHooks", category: "upgrade", is_building: false },
    ];
    const rows = normalizeBuildEvents(events);
    expect(rows.length).toBe(5);
    expect(rows.filter((r) => r.category === "upgrade").length).toBe(2);
    expect(rows[2].iconPath).toBe("/icons/sc2/upgrades/metabolicboost.png");
    expect(rows[4].iconPath).toBe("/icons/sc2/upgrades/centrifugalhooks.png");
  });
});

describe("sc2-icons — tiered upgrade variant resolver", () => {
  // Every spelling variant of the same in-game upgrade should resolve
  // to the same PNG, regardless of which sc2reader name happens to be
  // emitted by the player's replay version.
  const VARIANT_FAMILIES: Array<{ label: string; variants: string[]; expectedFile: string }> = [
    {
      label: "Protoss Ground Armor +2 — singular vs plural Armor",
      variants: ["ProtossGroundArmorLevel2", "ProtossGroundArmorsLevel2"],
      expectedFile: "/icons/sc2/upgrades/protossgroundarmor2.png",
    },
    {
      label: "Protoss Air Armor +1",
      variants: ["ProtossAirArmorLevel1", "ProtossAirArmorsLevel1"],
      expectedFile: "/icons/sc2/upgrades/protossairarmor1.png",
    },
    {
      label: "Terran Infantry Armor +3 — including the Mengsk co-op suffix",
      variants: [
        "TerranInfantryArmorLevel3",
        "TerranInfantryArmorsLevel3",
        "TerranInfantryArmorsVanadiumPlatingLevel3",
      ],
      expectedFile: "/icons/sc2/upgrades/terraninfantryarmor3.png",
    },
    {
      label: "Terran Infantry Weapons +2 — including UltraCapacitors variant",
      variants: [
        "TerranInfantryWeaponsLevel2",
        "TerranInfantryWeaponsUltraCapacitorsLevel2",
      ],
      expectedFile: "/icons/sc2/upgrades/terraninfantryweapons2.png",
    },
    {
      label: "Terran Vehicle+Ship Armor +1 — every legacy and current spelling",
      variants: [
        "TerranVehicleArmorsLevel1",
        "TerranVehicleAndShipArmorsLevel1",
        "TerranVehicleandShipPlatingLevel1",
        "TerranShipArmorsLevel1",
        "TerranVehicleArmorsVanadiumPlatingLevel1",
      ],
      expectedFile: "/icons/sc2/upgrades/terranvehiclearmor1.png",
    },
    {
      label: "Zerg Melee Attacks +2 — Weapons vs Attacks variants",
      variants: ["ZergMeleeAttacksLevel2", "ZergMeleeWeaponsLevel2"],
      expectedFile: "/icons/sc2/upgrades/zergmeleeattacks2.png",
    },
    {
      label: "Zerg Missile Attacks +3",
      variants: ["ZergMissileAttacksLevel3", "ZergMissileWeaponsLevel3"],
      expectedFile: "/icons/sc2/upgrades/zergmissileattacks3.png",
    },
    {
      label: "Zerg Ground Carapace +1 — Armor / Armors / Carapace drift",
      variants: [
        "ZergGroundArmorsLevel1",
        "ZergGroundCarapaceLevel1",
      ],
      expectedFile: "/icons/sc2/upgrades/zerggroundcarapace1.png",
    },
    {
      label: "Zerg Flyer Carapace +2",
      variants: [
        "ZergFlyerArmorsLevel2",
        "ZergFlyerCarapaceLevel2",
      ],
      expectedFile: "/icons/sc2/upgrades/zergflyercarapace2.png",
    },
    {
      label: "Zerg Flyer Attacks +3 — Weapons vs Attacks variants",
      variants: ["ZergFlyerAttacksLevel3", "ZergFlyerWeaponsLevel3"],
      expectedFile: "/icons/sc2/upgrades/zergflyerattacks3.png",
    },
  ];

  for (const { label, variants, expectedFile } of VARIANT_FAMILIES) {
    it(label, () => {
      for (const v of variants) {
        expect(getIconPath(v, "upgrade")).toBe(expectedFile);
      }
    });
  }
});

describe("build-rules — Save as Build / Custom Build editor pipeline", () => {
  it("spaEventToWhat emits Research<Name> for category=upgrade events", () => {
    expect(
      spaEventToWhat({
        time: 180,
        name: "WarpGateResearch",
        category: "upgrade",
        is_building: false,
      }),
    ).toBe("ResearchWarpGateResearch");
    expect(
      spaEventToWhat({
        time: 200,
        name: "BlinkTech",
        category: "upgrade",
        is_building: false,
      }),
    ).toBe("ResearchBlinkTech");
  });

  it("eventsToSourceRows includes upgrades and flags them as tech", () => {
    const events: BuildOrderEvent[] = [
      { time: 0, name: "Probe", category: "unit", is_building: false },
      { time: 60, name: "Pylon", category: "building", is_building: true },
      { time: 180, name: "WarpGateResearch", category: "upgrade", is_building: false },
    ];
    const rows = eventsToSourceRows(events);
    expect(rows.length).toBe(3);
    const upgrade = rows.find((r) => r.what.startsWith("Research"));
    expect(upgrade).toBeDefined();
    expect(upgrade!.what).toBe("ResearchWarpGateResearch");
    expect(upgrade!.isTech).toBe(true);
    expect(upgrade!.category).toBe("upgrade");
  });
});
