import { describe, expect, it } from "vitest";
import { actionsFromSteps, referenceBuilds } from "../adapt/adapt";
import { resolveProfile } from "../patch/profiles";
import { defaultPolicies, simulate } from "../sim/engine";
import type { SimRace } from "../types";

const baseline = resolveProfile("lotv-base");

function idxOf(steps: string[], name: string, nth = 0): number {
  let seen = -1;
  for (let i = 0; i < steps.length; i += 1) {
    if (steps[i] === name) {
      seen += 1;
      if (seen === nth) return i;
    }
  }
  return -1;
}


interface DefCheck {
  /** [name, nth (0-based), deadlineSec]: nth completion by deadline. */
  doneBy?: [string, number, number][];
  /** [name, nth, deadlineSec]: nth step START by deadline. */
  startBy?: [string, number, number][];
  /** Minimum completed counts at the sim horizon. */
  units?: [string, number][];
  /** [earlier, earlierNth, later, laterNth]: step-list ordering. */
  order?: [string, number, string, number][];
  /** Names that must not appear anywhere in the step list. */
  absent?: string[];
  /** Workers at the horizon ≥ this (droning rules). */
  workersAtLeast?: number;
}

/**
 * Machine-checkable constraints distilled from each definition's
 * detection rule (lib/build-definitions/*). The deadlines are the
 * analyzer's real replay-derived cutoffs; the 12-worker baseline sim
 * of each shipped build must satisfy the rule it claims to cover —
 * this is what keeps the step lists honest production data instead of
 * mock lists that merely name-drop the build.
 */
const DEFINITION_CHECKS: Record<string, DefCheck> = {
  // ---- Protoss, race-generic -------------------------------------
  "protoss-standard-expand": {
    startBy: [["Nexus", 0, 390]],
    order: [["Gateway", 0, "Nexus", 0]],
  },
  "protoss-4-gate-rush": {
    startBy: [["Gateway", 3, 360]],
    absent: ["Nexus"],
  },
  "protoss-blink-all-in": {
    doneBy: [["BlinkTech", 0, 390]],
    units: [["Gateway", 3]],
    absent: ["Nexus"],
  },
  "protoss-cannon-rush": { startBy: [["PhotonCannon", 0, 270]] },
  "protoss-chargelot-all-in": {
    doneBy: [["Charge", 0, 540]],
    units: [["Gateway", 7]],
  },
  "protoss-dt-rush": { startBy: [["DarkShrine", 0, 450]] },
  "protoss-glaive-adept-timing": {
    doneBy: [["ResonatingGlaives", 0, 390]],
    units: [["Adept", 6]],
  },
  "protoss-proxy-4-gate": { startBy: [["Gateway", 2, 270]] },
  "protoss-proxy-robo-opener": { startBy: [["RoboticsFacility", 0, 390]] },
  "protoss-proxy-stargate-opener": { startBy: [["Stargate", 0, 390]] },
  "protoss-robo-opener": {
    startBy: [["RoboticsFacility", 0, 390]],
    order: [
      ["RoboticsFacility", 0, "Gateway", 1],
    ],
    absent: ["TwilightCouncil"],
  },
  "protoss-standard-macro-cia": {
    units: [["Nexus", 2], ["Immortal", 1]],
    doneBy: [["Charge", 0, 660]],
  },
  "protoss-stargate-opener": { startBy: [["Stargate", 0, 390]] },
  // ---- PvP ---------------------------------------------------------
  "pvp-1-gate-expand": {
    startBy: [["Nexus", 0, 300]],
    order: [["Gateway", 0, "Nexus", 0], ["Nexus", 0, "Gateway", 1]],
  },
  "pvp-strange-s-1-gate-expand": {
    startBy: [["Nexus", 0, 300]],
    order: [["Nexus", 0, "Gateway", 1], ["Sentry", 0, "Stalker", 0]],
  },
  "pvp-2-gate-expand": {
    startBy: [["Nexus", 0, 300]],
    order: [
      ["Gateway", 1, "Nexus", 0],
      ["Nexus", 0, "RoboticsFacility", 0],
    ],
  },
  "pvp-1-gate-nexus-into-4-gate": {
    startBy: [["Nexus", 0, 300], ["Gateway", 3, 360], ["WarpGateResearch", 0, 330]],
    order: [["Gateway", 0, "Nexus", 0], ["Nexus", 0, "Gateway", 1]],
    absent: ["Stargate", "RoboticsFacility", "TwilightCouncil", "DarkShrine"],
  },
  "pvp-4-stalker-oracle-into-dt": {
    doneBy: [["Stalker", 2, 390], ["Oracle", 0, 450], ["DarkShrine", 0, 540]],
  },
  "pvp-alphastar-4-adept-oracle": {
    doneBy: [["Adept", 3, 360], ["Oracle", 0, 390]],
  },
  "pvp-blink-stalker-style": {
    doneBy: [["BlinkTech", 0, 540]],
    units: [["Nexus", 1]],
  },
  "pvp-phoenix-style": { doneBy: [["Phoenix", 2, 510]] },
  "pvp-proxy-2-gate": {
    startBy: [["Gateway", 1, 270]],
    units: [["Zealot", 6]],
  },
  "pvp-proxy-robo-opener": { startBy: [["RoboticsFacility", 0, 390]] },
  "pvp-robo-into-glaives": {
    order: [["RoboticsFacility", 0, "TwilightCouncil", 0]],
    doneBy: [["ResonatingGlaives", 0, 660]],
    absent: ["BlinkTech", "Charge"],
  },
  "pvp-adept-glaives": {
    doneBy: [["ResonatingGlaives", 0, 660]],
    absent: ["RoboticsFacility", "Stargate", "BlinkTech", "Charge"],
  },
  "pvp-rail-s-blink-stalker-robo-1st": {
    order: [
      ["RoboticsFacility", 0, "TwilightCouncil", 0],
      ["TwilightCouncil", 0, "Nexus", 0],
    ],
    doneBy: [["BlinkTech", 0, 660]],
    absent: ["ResonatingGlaives", "Charge"],
  },
  "pvp-standard-stargate-opener": { startBy: [["Stargate", 0, 390]] },
  // ---- PvT ---------------------------------------------------------
  "pvt-2-base-templar-reactive-delayed-3rd": {
    order: [
      ["TwilightCouncil", 0, "RoboticsFacility", 0],
      ["TemplarArchives", 0, "Nexus", 1],
      ["TemplarArchives", 0, "PsiStorm", 0],
    ],
    startBy: [["Gateway", 3, 450]],
    doneBy: [["Charge", 0, 660], ["PsiStorm", 0, 660]],
    units: [["HighTemplar", 4], ["Gateway", 6], ["WarpPrism", 1]],
    absent: ["Stargate"],
  },
  "pvt-2-gate-blink-fast-3rd-nexus": {
    order: [["TwilightCouncil", 0, "RoboticsFacility", 0]],
    doneBy: [["BlinkTech", 0, 480]],
    startBy: [["RoboticsFacility", 0, 480], ["Nexus", 1, 480]],
    absent: ["Stargate"],
  },
  "pvt-3-gate-blink-macro": {
    order: [["TwilightCouncil", 0, "RoboticsFacility", 0]],
    doneBy: [["BlinkTech", 0, 540]],
    units: [["Nexus", 2]],
    absent: ["Stargate"],
  },
  "pvt-4-gate-blink": {
    doneBy: [["BlinkTech", 0, 540]],
    units: [["Gateway", 4]],
    absent: ["Stargate", "RoboticsFacility"],
  },
  "pvt-7-gate-blink-all-in": {
    doneBy: [["BlinkTech", 0, 540]],
    units: [["Gateway", 7]],
    absent: ["Stargate", "RoboticsFacility"],
  },
  "pvt-8-gate-charge-all-in": {
    doneBy: [["Charge", 0, 540]],
    startBy: [["Gateway", 6, 450]],
    units: [["Gateway", 8]],
    absent: ["Stargate", "RoboticsFacility"],
  },
  "pvt-dt-drop": {
    // Calibrated vs the Peruano replay (+60s detector buffer):
    // Shrine by 4:15, Robo by 4:30, DT by 5:00, Prism by 5:15.
    startBy: [["DarkShrine", 0, 255], ["RoboticsFacility", 0, 270]],
    doneBy: [["DarkTemplar", 0, 300], ["WarpPrism", 0, 315]],
  },
  "pvt-phoenix-opener": {
    doneBy: [["Phoenix", 0, 420]],
    absent: ["RoboticsFacility", "TwilightCouncil"],
  },
  "pvt-phoenix-into-robo": {
    doneBy: [["Phoenix", 0, 420]],
    startBy: [["RoboticsFacility", 0, 480]],
    order: [["Stargate", 0, "RoboticsFacility", 0]],
  },
  "pvt-proxy-void-ray-stargate": {
    units: [["VoidRay", 1]],
    absent: ["Nexus"],
  },
  "pvt-stargate-into-charge": {
    order: [["Stargate", 0, "TwilightCouncil", 0]],
    doneBy: [["Charge", 0, 540]],
    absent: ["BlinkTech", "ResonatingGlaives", "RoboticsFacility"],
  },
  "pvt-stargate-into-glaives": {
    order: [["Stargate", 0, "TwilightCouncil", 0]],
    doneBy: [["ResonatingGlaives", 0, 540]],
    absent: ["BlinkTech", "Charge", "RoboticsFacility"],
  },
  "pvt-stargate-into-blink": {
    order: [["Stargate", 0, "TwilightCouncil", 0]],
    doneBy: [["BlinkTech", 0, 540]],
    absent: ["ResonatingGlaives", "Charge", "RoboticsFacility"],
  },
  "pvt-stargate-opener": {
    startBy: [["Stargate", 0, 390]],
    absent: ["TwilightCouncil", "RoboticsFacility"],
  },
  "pvt-robo-first": {
    startBy: [["RoboticsFacility", 0, 390]],
    absent: ["TwilightCouncil", "Stargate"],
  },
  "pvt-standard-charge-macro": {
    order: [["TwilightCouncil", 0, "RoboticsFacility", 0]],
    doneBy: [["Charge", 0, 540]],
    units: [["Nexus", 2]],
    absent: ["Stargate"],
  },
  "pvt-3-gate-charge-opener": {
    doneBy: [["Charge", 0, 540]],
    units: [["Gateway", 3]],
    absent: ["Stargate", "RoboticsFacility"],
  },
  // ---- PvZ ---------------------------------------------------------
  "pvz-2-stargate-phoenix": {
    doneBy: [["Phoenix", 3, 600]],
    units: [["Stargate", 2], ["Nexus", 1]],
    absent: ["RoboticsFacility", "ResonatingGlaives"],
  },
  "pvz-3-stargate-phoenix": {
    doneBy: [["Phoenix", 3, 600]],
    units: [["Stargate", 3], ["Nexus", 1]],
    absent: ["RoboticsFacility", "ResonatingGlaives"],
  },
  "pvz-2-stargate-void-ray": {
    doneBy: [["VoidRay", 3, 600]],
    units: [["Stargate", 2], ["Nexus", 1]],
    absent: ["RoboticsFacility", "ResonatingGlaives"],
  },
  "pvz-7-gate-glaive-immortal-all-in": {
    doneBy: [["ResonatingGlaives", 0, 510], ["Sentry", 1, 510], ["Immortal", 0, 510]],
    startBy: [["Gateway", 5, 540]],
    units: [["Gateway", 7]],
  },
  "pvz-alphastar-style-oracle-robo": {
    doneBy: [["Oracle", 1, 510]],
    startBy: [["RoboticsFacility", 0, 510], ["Forge", 0, 510], ["Nexus", 1, 510]],
    order: [["Stargate", 0, "RoboticsFacility", 0]],
  },
  "pvz-archon-drop": {
    order: [["Stargate", 0, "TwilightCouncil", 0]],
    doneBy: [["TemplarArchives", 0, 540]],
    units: [["HighTemplar", 4]],
  },
  "pvz-blink-stalker-all-in-2-base": {
    doneBy: [["BlinkTech", 0, 480]],
    startBy: [["Gateway", 4, 480]],
    absent: ["Stargate", "DarkShrine"],
  },
  "pvz-carrier-rush": {
    doneBy: [["FleetBeacon", 0, 600], ["Carrier", 0, 600]],
    absent: ["TwilightCouncil", "DarkShrine", "RoboticsFacility"],
  },
  "pvz-dt-drop-into-archon-drop": {
    order: [["TwilightCouncil", 0, "DarkShrine", 0]],
    doneBy: [
      ["DarkShrine", 0, 540],
      ["RoboticsFacility", 0, 540],
      ["DarkTemplar", 2, 540],
      ["WarpPrism", 0, 540],
    ],
  },
  "pvz-rail-s-disruptor-drop": {
    doneBy: [["Disruptor", 0, 480], ["WarpPrism", 0, 480]],
  },
  "pvz-robo-opener": {
    units: [["RoboticsFacility", 1]],
    absent: ["Stargate", "TwilightCouncil", "DarkShrine"],
  },
  "pvz-standard-blink-macro": {
    order: [["Stargate", 0, "TwilightCouncil", 0]],
    doneBy: [["BlinkTech", 0, 600]],
    startBy: [["Nexus", 1, 540]],
  },
  "pvz-standard-charge-macro": {
    order: [["Stargate", 0, "TwilightCouncil", 0]],
    doneBy: [["Charge", 0, 540]],
    startBy: [["Nexus", 1, 540]],
  },
  "pvz-stargate-into-glaives": {
    order: [["Stargate", 0, "TwilightCouncil", 0]],
    doneBy: [["ResonatingGlaives", 0, 660]],
    absent: ["BlinkTech", "Charge"],
  },
  "pvz-adept-glaives-no-robo": {
    startBy: [["Gateway", 3, 360]],
    doneBy: [["ResonatingGlaives", 0, 660]],
    absent: ["RoboticsFacility", "Stargate", "DarkShrine", "BlinkTech", "Charge"],
  },
  "pvz-adept-glaives-robo": {
    order: [["TwilightCouncil", 0, "RoboticsFacility", 0]],
    startBy: [["Gateway", 3, 360]],
    doneBy: [["ResonatingGlaives", 0, 660]],
    absent: ["Stargate", "DarkShrine", "BlinkTech", "Charge"],
  },
  "pvz-tempest-rush": {
    order: [["Stargate", 0, "FleetBeacon", 0], ["Oracle", 0, "Tempest", 0]],
    doneBy: [["FleetBeacon", 0, 600], ["Tempest", 0, 600]],
  },
  "pvz-dt-opener": {
    order: [["DarkShrine", 0, "Stargate", 0]],
    doneBy: [["DarkTemplar", 0, 540]],
  },
  "pvz-stargate-into-robo": {
    order: [["Stargate", 0, "RoboticsFacility", 0]],
    startBy: [["RoboticsFacility", 0, 600]],
    doneBy: [["VoidRay", 0, 600]],
  },
  "pvz-stargate-opener": {
    order: [["Stargate", 0, "Gateway", 1]],
    units: [["Oracle", 1]],
    absent: ["TwilightCouncil", "DarkShrine", "RoboticsFacility"],
  },
  // ---- Terran, race-generic ---------------------------------------
  "terran-1-1-1-standard": {
    order: [["CommandCenter", 0, "Factory", 0]],
    startBy: [["Factory", 0, 390], ["Starport", 0, 490]],
  },
  "terran-1-1-1-one-base": {
    startBy: [["Factory", 0, 390], ["Starport", 0, 490]],
    absent: ["CommandCenter"],
  },
  "terran-2-gas-3-reaper-2-hellion": {
    doneBy: [["Reaper", 2, 330], ["Hellion", 1, 330]],
    units: [["Refinery", 2]],
  },
  "terran-2-3-rax-reaper-rush": {
    startBy: [["Barracks", 2, 390]],
    doneBy: [["Reaper", 1, 390]],
    order: [["Barracks", 2, "CommandCenter", 0]],
  },
  "terran-3-rax": {
    order: [["CommandCenter", 0, "Barracks", 1]],
    units: [["Barracks", 3]],
    absent: ["Factory", "Starport"],
  },
  "terran-3-4-rax-marine-rush": {
    startBy: [["Barracks", 2, 390]],
    absent: ["Refinery", "CommandCenter"],
  },
  "terran-bc-rush": {
    startBy: [["FusionCore", 0, 390]],
    units: [["Battlecruiser", 1]],
  },
  "terran-banshee-rush": {
    doneBy: [["CloakingField", 0, 450], ["Banshee", 0, 450]],
  },
  "terran-cyclone-rush": {
    doneBy: [["Cyclone", 0, 330]],
    units: [["FactoryTechLab", 1]],
  },
  "terran-fast-3-cc": {
    startBy: [["CommandCenter", 1, 420]],
  },
  "terran-ghost-rush": {
    startBy: [["GhostAcademy", 0, 390]],
    units: [["Ghost", 2]],
  },
  "terran-hellbat-all-in": {
    startBy: [["Armory", 0, 300]],
    units: [["Hellion", 6], ["Factory", 2]],
  },
  "terran-proxy-1-1-1": {
    startBy: [["Factory", 0, 390], ["Starport", 0, 490]],
  },
  "terran-proxy-starport-hellion-drop": {
    doneBy: [["Hellion", 1, 360]],
    units: [["CommandCenter", 1], ["Medivac", 2]],
    absent: ["Viking", "Liberator", "Banshee", "Raven", "Battlecruiser"],
  },
  "terran-proxy-rax": { startBy: [["Barracks", 1, 270]] },
  "terran-standard-bio-tank": {
    units: [
      ["CommandCenter", 2],
      ["EngineeringBay", 1],
      ["SiegeTank", 2],
      ["Medivac", 1],
    ],
  },
  "terran-widow-mine-drop": {
    order: [["CommandCenter", 0, "WidowMine", 0]],
    doneBy: [["WidowMine", 1, 390], ["Medivac", 0, 390]],
  },
  "terran-widow-mine-drop-into-thor-rush": {
    order: [["CommandCenter", 0, "WidowMine", 0]],
    doneBy: [["WidowMine", 1, 390], ["Medivac", 0, 390], ["Thor", 0, 490]],
  },
  "terran-widow-upgraded-mine-cheese": {
    doneBy: [["DrillingClaws", 0, 660]],
    units: [["WidowMine", 4], ["Medivac", 1]],
    absent: ["CommandCenter"],
  },
  // ---- TvP ---------------------------------------------------------
  "tvp-proxy-4-rax-reaper": {
    units: [["Barracks", 4], ["Reaper", 6]],
  },
  "tvp-proxy-marauder": {
    doneBy: [["ConcussiveShells", 0, 660]],
    units: [["Marauder", 4]],
  },
  "tvp-cyclone-push": {
    doneBy: [["Cyclone", 0, 330]],
    units: [["Cyclone", 4]],
  },
  "tvp-1-1-1-cloak-banshee": {
    doneBy: [["CloakingField", 0, 450], ["Banshee", 0, 450]],
    absent: ["CommandCenter"],
  },
  "tvp-3-rax-marine": {
    units: [["Barracks", 3], ["Marine", 8]],
    absent: ["Factory", "CommandCenter"],
  },
  "tvp-battlecruiser-rush": {
    startBy: [["FusionCore", 0, 390]],
    units: [["Battlecruiser", 1]],
  },
  "tvp-tank-thor-mech": {
    units: [["Armory", 1], ["Thor", 1], ["SiegeTank", 2]],
  },
  "tvp-widow-mine-drop": {
    doneBy: [["WidowMine", 1, 390], ["Medivac", 0, 390]],
  },
  "tvp-2-1-1-reaper-expand": {
    order: [["Reaper", 0, "Marine", 0]],
    units: [["Barracks", 2], ["Medivac", 2]],
    doneBy: [["Stimpack", 0, 540]],
  },
  "tvp-2-base-tank-push": {
    units: [["SiegeTank", 3], ["CommandCenter", 1]],
  },
  "tvp-fast-3-cc-bio": {
    startBy: [["CommandCenter", 1, 360]],
    units: [["Barracks", 3]],
    absent: ["Factory", "Armory", "FusionCore"],
  },
  // ---- TvT ---------------------------------------------------------
  "tvt-proxy-4-rax-reaper": {
    units: [["Barracks", 4], ["Reaper", 6]],
  },
  "tvt-proxy-marauder": {
    doneBy: [["ConcussiveShells", 0, 660]],
    units: [["Marauder", 4]],
  },
  "tvt-cyclone-push": {
    doneBy: [["Cyclone", 0, 330]],
    units: [["Cyclone", 4]],
  },
  "tvt-1-1-1-cloak-banshee": {
    doneBy: [["CloakingField", 0, 450], ["Banshee", 0, 450]],
    absent: ["CommandCenter"],
  },
  "tvt-banshee-into-raven": {
    doneBy: [["CloakingField", 0, 450]],
    units: [["Banshee", 2], ["Raven", 1]],
  },
  "tvt-battlecruiser-rush": {
    startBy: [["FusionCore", 0, 390]],
    units: [["Battlecruiser", 1]],
  },
  "tvt-tank-thor-mech": {
    units: [["Armory", 1], ["Thor", 1], ["SiegeTank", 2]],
  },
  "tvt-reaper-expand-into-tank-viking": {
    order: [["Reaper", 0, "Marine", 0]],
    units: [["SiegeTank", 3], ["Viking", 2], ["CommandCenter", 1]],
  },
  "tvt-2-1-1-marine-tank": {
    units: [["SiegeTank", 2], ["Medivac", 1], ["CommandCenter", 1]],
    absent: ["Viking"],
  },
  "tvt-3-rax-marine": {
    units: [["Barracks", 3], ["Marine", 8]],
    absent: ["Factory", "CommandCenter"],
  },
  "tvt-mass-viking-air": {
    units: [["Starport", 2], ["Viking", 6]],
  },
  // ---- TvZ ---------------------------------------------------------
  "tvz-proxy-4-rax-reaper": {
    units: [["Barracks", 4], ["Reaper", 6]],
  },
  "tvz-1-1-1-banshee": {
    doneBy: [["CloakingField", 0, 450], ["Banshee", 0, 450]],
    absent: ["CommandCenter"],
  },
  "tvz-3-rax-marine": {
    units: [["Barracks", 3], ["Marine", 8]],
    absent: ["Factory", "CommandCenter"],
  },
  "tvz-reaper-hellion-expand": {
    order: [["Reaper", 0, "Hellion", 0]],
    units: [["Hellion", 4], ["CommandCenter", 1]],
    absent: ["Armory", "FusionCore"],
  },
  "tvz-2-base-hellbat-thor": {
    units: [["Factory", 2], ["Armory", 1], ["Thor", 2], ["Hellion", 5], ["CommandCenter", 1]],
  },
  "tvz-2-1-1-marine-hellbat-timing": {
    units: [["Armory", 1], ["Hellion", 2], ["Medivac", 1]],
    absent: ["Thor"],
  },
  "tvz-battlecruiser-mech": {
    units: [["FusionCore", 1], ["Battlecruiser", 2], ["Hellion", 2]],
  },
  "tvz-hellion-liberator": {
    units: [["Hellion", 4], ["Liberator", 2], ["CommandCenter", 1]],
  },
  "tvz-2-1-1-marine-drop": {
    doneBy: [["Stimpack", 0, 540]],
    units: [["Medivac", 2], ["Marine", 8]],
  },
  "tvz-widow-mine-marine": {
    doneBy: [["WidowMine", 1, 390], ["Medivac", 0, 390]],
  },
  "tvz-3-cc-bio": {
    startBy: [["CommandCenter", 1, 360]],
    units: [["Barracks", 3]],
    absent: ["Factory", "Armory", "FusionCore"],
  },
  // ---- Zerg, race-generic ------------------------------------------
  "zerg-17-hatch-18-gas-17-pool": {
    startBy: [["Hatchery", 0, 85], ["Extractor", 0, 95], ["SpawningPool", 0, 105]],
  },
  "zerg-3-base-macro-hatch-first": {
    order: [["Hatchery", 0, "SpawningPool", 0]],
    startBy: [["Hatchery", 1, 390]],
  },
  "zerg-3-base-macro-pool-first": {
    order: [["SpawningPool", 0, "Hatchery", 0]],
    startBy: [["Hatchery", 1, 390]],
  },
  "zerg-pool-first-opener": {
    order: [["SpawningPool", 0, "Hatchery", 0]],
    units: [["Queen", 2]],
  },
  "zerg-8-pool": { startBy: [["SpawningPool", 0, 50]] },
  "zerg-early-pool-14-14-or-15-pool": {
    startBy: [["SpawningPool", 0, 70]],
    order: [["SpawningPool", 0, "Hatchery", 0]],
  },
  "zerg-13-12-baneling-bust": {
    startBy: [["SpawningPool", 0, 70], ["Extractor", 0, 70], ["BanelingNest", 0, 200]],
    units: [["Baneling", 4]],
  },
  "zerg-13-12-speedling-aggression": {
    startBy: [["SpawningPool", 0, 70], ["Extractor", 0, 70]],
    units: [["Zergling", 14]],
  },
  "zerg-1-base-roach-rush": {
    startBy: [["RoachWarren", 0, 220]],
    units: [["Roach", 5]],
    absent: ["Hatchery"],
  },
  "zerg-2-base-roach-ravager-all-in": {
    units: [["Roach", 4], ["Ravager", 3], ["Lair", 1]],
  },
  "zerg-roach-ravager-comp": {
    units: [["Roach", 5], ["Ravager", 2], ["Hatchery", 2]],
  },
  "zerg-2-base-muta-rush": {
    startBy: [["Spire", 0, 420]],
    units: [["Mutalisk", 4]],
  },
  "zerg-2-base-nydus": { startBy: [["NydusNetwork", 0, 420]] },
  "zerg-3-hatch-before-pool": {
    order: [["Hatchery", 1, "SpawningPool", 0]],
  },
  "zerg-3-hatch-ling-flood": {
    doneBy: [["Zergling", 19, 300]],
    units: [["Hatchery", 2]],
  },
  "zerg-proxy-hatch": {
    startBy: [["Hatchery", 0, 270]],
    units: [["SpineCrawler", 3]],
  },
  "zerg-hydra-comp": {
    doneBy: [["GroovedSpines", 0, 660]],
    units: [["Hydralisk", 5]],
  },
  // ---- ZvP ---------------------------------------------------------
  "zvp-8-pool-rush": {
    startBy: [["SpawningPool", 0, 55]],
    units: [["Zergling", 10]],
  },
  "zvp-ling-bane-bust": {
    units: [["Baneling", 4], ["Zergling", 6]],
  },
  "zvp-2-base-roach-ravager-all-in": {
    units: [["Roach", 4], ["Ravager", 3]],
  },
  "zvp-2-base-nydus": { startBy: [["NydusNetwork", 0, 420]] },
  "zvp-hydra-timing-3-base": {
    doneBy: [["GroovedSpines", 0, 660]],
    units: [["Hydralisk", 5], ["Hatchery", 2]],
  },
  "zvp-lurker-contain": {
    units: [["LurkerDen", 1], ["Lurker", 3]],
  },
  "zvp-ling-bane-muta": {
    units: [["BanelingNest", 1], ["Spire", 1], ["Baneling", 2], ["Mutalisk", 3]],
  },
  "zvp-mutalisk-harass": {
    units: [["Mutalisk", 6]],
    absent: ["BanelingNest"],
  },
  "zvp-speedling-flood": {
    doneBy: [["Zergling", 19, 300]],
    units: [["Hatchery", 2]],
  },
  "zvp-hatch-first-macro": {
    order: [["Hatchery", 0, "SpawningPool", 0]],
    units: [["Hatchery", 2]],
    workersAtLeast: 40,
  },
  // ---- ZvT ---------------------------------------------------------
  "zvt-ling-bane-bust": {
    units: [["Baneling", 4], ["Zergling", 6]],
  },
  "zvt-2-base-roach-ravager-timing": {
    units: [["Roach", 4], ["Ravager", 3]],
  },
  "zvt-2-base-nydus": { startBy: [["NydusNetwork", 0, 420]] },
  "zvt-mass-queen-defensive": {
    units: [["Queen", 6], ["SporeCrawler", 2]],
    absent: ["RoachWarren", "BanelingNest", "Spire"],
  },
  "zvt-lurker-contain": {
    units: [["LurkerDen", 1], ["Lurker", 3]],
  },
  "zvt-3-hatch-ling-bane-muta": {
    units: [["Hatchery", 2], ["BanelingNest", 1], ["Spire", 1], ["Mutalisk", 3], ["Baneling", 2]],
  },
  "zvt-mass-muta-harass": {
    units: [["Mutalisk", 6]],
    absent: ["BanelingNest"],
  },
  "zvt-roach-hydra": {
    units: [["Roach", 3], ["Hydralisk", 4], ["Hatchery", 2]],
  },
  "zvt-3-base-ling-flood": {
    doneBy: [["Zergling", 19, 300]],
    units: [["Hatchery", 2]],
  },
  "zvt-hatch-first-macro": {
    order: [["Hatchery", 0, "SpawningPool", 0]],
    units: [["Hatchery", 2]],
    workersAtLeast: 40,
  },
  // ---- ZvZ ---------------------------------------------------------
  "zvz-8-pool-into-baneling": {
    startBy: [["SpawningPool", 0, 55]],
    units: [["BanelingNest", 1], ["Baneling", 4]],
  },
  "zvz-8-pool-speedling": {
    startBy: [["SpawningPool", 0, 55]],
    units: [["Zergling", 12]],
  },
  "zvz-ling-bane-all-in": {
    units: [["Baneling", 4], ["Zergling", 6]],
  },
  "zvz-roach-ravager": {
    units: [["Roach", 4], ["Ravager", 3]],
  },
  "zvz-roach-aggression": {
    units: [["Roach", 5], ["Hatchery", 1]],
  },
  "zvz-2-base-nydus": { startBy: [["NydusNetwork", 0, 420]] },
  "zvz-mutalisk-vs-mutalisk": {
    units: [["Mutalisk", 6]],
  },
  "zvz-hatch-first-muta": {
    order: [["Hatchery", 0, "SpawningPool", 0]],
    units: [["Spire", 1], ["Mutalisk", 5]],
  },
  "zvz-zergling-flood": {
    units: [["Zergling", 18]],
  },
  "zvz-drone-macro-hatch-first": {
    order: [["Hatchery", 0, "SpawningPool", 0]],
    workersAtLeast: 30,
  },
};

describe("each build satisfies its definition's detection rule", () => {
  const VALIDATION_HORIZON_SEC = 660;

  it("every definition-backed build has a validation entry", () => {
    const checked = new Set(Object.keys(DEFINITION_CHECKS));
    for (const build of referenceBuilds()) {
      for (const defId of build.definitionIds ?? []) {
        expect(checked.has(defId), `${defId} has no validation entry`).toBe(
          true,
        );
      }
    }
  });

  const buildsByDefinition = new Map(
    referenceBuilds()
      .filter((b) => (b.definitionIds ?? []).length === 1)
      .map((b) => [b.definitionIds![0], b]),
  );

  for (const [defId, check] of Object.entries(DEFINITION_CHECKS)) {
    it(`${defId} build matches its detection thresholds`, () => {
      const build = buildsByDefinition.get(defId);
      expect(build, `no build covers ${defId}`).toBeDefined();
      const steps = build!.steps;
      for (const name of check.absent ?? []) {
        expect(steps, `${build!.id}: ${name} must not appear`).not.toContain(
          name,
        );
      }
      for (const [earlier, eNth, later, lNth] of check.order ?? []) {
        const e = idxOf(steps, earlier, eNth);
        const l = idxOf(steps, later, lNth);
        expect(e, `${build!.id}: ${earlier} #${eNth + 1} missing`).toBeGreaterThanOrEqual(0);
        expect(l, `${build!.id}: ${later} #${lNth + 1} missing`).toBeGreaterThanOrEqual(0);
        expect(
          e,
          `${build!.id}: ${earlier} #${eNth + 1} must be listed before ${later} #${lNth + 1}`,
        ).toBeLessThan(l);
      }
      const needsSim =
        (check.doneBy?.length ?? 0) > 0 ||
        (check.startBy?.length ?? 0) > 0 ||
        (check.units?.length ?? 0) > 0 ||
        check.workersAtLeast !== undefined;
      if (!needsSim) return;
      const { actions, unknownNames } = actionsFromSteps(baseline, steps);
      expect(unknownNames).toEqual([]);
      const sim = simulate(actions, baseline, build!.race as SimRace, {
        horizonSec: VALIDATION_HORIZON_SEC,
        policies: defaultPolicies(),
      });
      expect(sim.unexecutedActions, build!.id).toBe(0);
      for (const [name, nth, deadline] of check.startBy ?? []) {
        const starts = sim.steps
          .filter((s) => s.name === name)
          .map((s) => s.startSec);
        expect(
          starts.length,
          `${build!.id}: ${name} #${nth + 1} never started`,
        ).toBeGreaterThan(nth);
        expect(
          starts[nth],
          `${build!.id}: ${name} #${nth + 1} starts at ${starts[nth]}, rule cutoff ${deadline}`,
        ).toBeLessThanOrEqual(deadline);
      }
      for (const [name, nth, deadline] of check.doneBy ?? []) {
        const times = sim.completionTimes[name] ?? [];
        expect(
          times.length,
          `${build!.id}: ${name} #${nth + 1} never completed`,
        ).toBeGreaterThan(nth);
        expect(
          times[nth],
          `${build!.id}: ${name} #${nth + 1} completes at ${times[nth]}, rule cutoff ${deadline}`,
        ).toBeLessThanOrEqual(deadline);
      }
      for (const [name, count] of check.units ?? []) {
        expect(
          sim.unitsAtEnd[name] ?? 0,
          `${build!.id}: needs ${count}+ ${name}`,
        ).toBeGreaterThanOrEqual(count);
      }
      if (check.workersAtLeast !== undefined) {
        expect(
          sim.finalWorkers,
          `${build!.id}: drone count below the rule's economy bar`,
        ).toBeGreaterThanOrEqual(check.workersAtLeast);
      }
    });
  }
});
