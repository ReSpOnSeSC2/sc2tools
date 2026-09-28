"use strict";

/**
 * Guide milestone catalog — the build-order steps whose community timing
 * a guide page shows ("median Twilight Council 4:31").
 *
 * Times are the RECORDED build-log times, exactly as the replay engine
 * logs them (house rule, services/trendsExplorerDetail.js: never subtract
 * a balance duration — that would invent historical precision). What a
 * recorded time means depends on the kind of step, and ``event`` names it:
 *
 *   - "start"  — structures, logged when construction begins
 *                (UnitInitEvent / the drone being consumed);
 *   - "finish" — morphs (Lair, OrbitalCommand) and upgrades, logged on
 *                completion (UnitTypeChangeEvent / UpgradeCompleteEvent).
 * The web renders "started" / "done" from ``event``; labels stay plain.
 *
 * ``names`` are wire names from ``buildLog`` lines ("[m:ss] <Name>"),
 * matched case-insensitively (sc2reader emits the ling-speed upgrade as
 * lowercase "zerglingmovementspeed"). ``names[0]`` is the canonical wire
 * name (Ghost Build targets use it). ``occurrence`` N means the Nth logged
 * line of any of the names: every game logs its starting town hall at
 * 0:00, so "Nexus" occurrence 2 is the natural expansion.
 *
 * Keys are stable storage identifiers (``guide_samples.milestones.<key>``,
 * ``guide_stats`` timings) — never rename one; add a new key instead.
 *
 * Deliberately absent: SupplyDepot and ShieldBattery. The replay engine
 * lists them in SKIP_BUILDINGS (apps/replay-engine/core/event_extractor.py)
 * so they never reach ``buildLog``; a milestone for them could never be
 * present. guideMilestones.test.js pins names/events to the API parser.
 */

/** @typedef {"start" | "finish"} GuideMilestoneEvent */

/**
 * @typedef {object} GuideMilestone
 * @property {string} key                 stable storage key
 * @property {string} label               human text
 * @property {ReadonlyArray<string>} names wire names (case-insensitive)
 * @property {1 | 2 | 3} occurrence        Nth logged line
 * @property {GuideMilestoneEvent} event  what the recorded time marks
 */

const START = "start";
const FINISH = "finish";
const FIRST = 1;
const SECOND = 2;
const THIRD = 3;

/**
 * @param {string} key
 * @param {string} label
 * @param {ReadonlyArray<string>} names
 * @param {GuideMilestoneEvent} event
 * @param {1 | 2 | 3} [occurrence]
 * @returns {Readonly<GuideMilestone>}
 */
function milestone(key, label, names, event, occurrence = FIRST) {
  return Object.freeze({ key, label, names: Object.freeze([...names]), occurrence, event });
}

const PROTOSS_MILESTONES = Object.freeze([
  milestone("Pylon", "Pylon", ["Pylon"], START),
  milestone("Gateway", "Gateway", ["Gateway"], START),
  milestone("Assimilator", "Assimilator", ["Assimilator", "AssimilatorRich"], START),
  milestone("Nexus#2", "2nd Nexus", ["Nexus"], START, SECOND),
  milestone("CyberneticsCore", "Cybernetics Core", ["CyberneticsCore"], START),
  milestone("WarpGateResearch", "Warpgate", ["WarpGateResearch"], FINISH),
  milestone("TwilightCouncil", "Twilight Council", ["TwilightCouncil"], START),
  milestone("Stargate", "Stargate", ["Stargate"], START),
  milestone("RoboticsFacility", "Robotics Facility", ["RoboticsFacility"], START),
  milestone("Forge", "Forge", ["Forge"], START),
  milestone("BlinkTech", "Blink", ["BlinkTech"], FINISH),
  milestone("Charge", "Charge", ["Charge"], FINISH),
  milestone("AdeptPiercingAttack", "Resonating Glaives", ["AdeptPiercingAttack"], FINISH),
  milestone("Nexus#3", "3rd Nexus", ["Nexus"], START, THIRD),
  // Tech the channel's build-order guides hinge on (Colossus pushes, DT
  // drops, Carrier/Tempest rushes). Shown only where most games of a build
  // actually reach them (GUIDE_MILESTONE_MIN_PRESENCE).
  milestone("RoboticsBay", "Robotics Bay", ["RoboticsBay"], START),
  milestone("DarkShrine", "Dark Shrine", ["DarkShrine"], START),
  milestone("TemplarArchive", "Templar Archives", ["TemplarArchive"], START),
  milestone("FleetBeacon", "Fleet Beacon", ["FleetBeacon"], START),
]);

const TERRAN_MILESTONES = Object.freeze([
  milestone("Barracks", "Barracks", ["Barracks"], START),
  milestone("Refinery", "Refinery", ["Refinery", "RefineryRich"], START),
  milestone("CommandCenter#2", "2nd Command Center", ["CommandCenter"], START, SECOND),
  milestone("OrbitalCommand", "Orbital Command", ["OrbitalCommand"], FINISH),
  milestone("Factory", "Factory", ["Factory"], START),
  milestone("Starport", "Starport", ["Starport"], START),
  milestone("CommandCenter#3", "3rd Command Center", ["CommandCenter"], START, THIRD),
  milestone("EngineeringBay", "Engineering Bay", ["EngineeringBay"], START),
  milestone("Stimpack", "Stimpack", ["Stimpack"], FINISH),
  milestone("ShieldWall", "Combat Shield", ["ShieldWall"], FINISH),
  milestone("PunisherGrenades", "Concussive Shells", ["PunisherGrenades"], FINISH),
  milestone("TerranInfantryWeaponsLevel1", "Infantry Weapons 1", ["TerranInfantryWeaponsLevel1"], FINISH),
  milestone("Armory", "Armory", ["Armory"], START),
  milestone("FusionCore", "Fusion Core", ["FusionCore"], START),
]);

const ZERG_MILESTONES = Object.freeze([
  milestone("SpawningPool", "Spawning Pool", ["SpawningPool"], START),
  milestone("Hatchery#2", "2nd Hatchery", ["Hatchery"], START, SECOND),
  milestone("Extractor", "Extractor", ["Extractor", "ExtractorRich"], START),
  milestone("Hatchery#3", "3rd Hatchery", ["Hatchery"], START, THIRD),
  milestone(
    "ZerglingMovementSpeed",
    "Metabolic Boost",
    ["zerglingmovementspeed", "ZerglingMetabolicBoost"],
    FINISH,
  ),
  milestone("RoachWarren", "Roach Warren", ["RoachWarren"], START),
  milestone("BanelingNest", "Baneling Nest", ["BanelingNest"], START),
  milestone("Lair", "Lair", ["Lair"], FINISH),
  milestone("EvolutionChamber", "Evolution Chamber", ["EvolutionChamber"], START),
  milestone("HydraliskDen", "Hydralisk Den", ["HydraliskDen"], START),
  milestone("Spire", "Spire", ["Spire"], START),
  milestone("GlialReconstitution", "Glial Reconstitution", ["GlialReconstitution"], FINISH),
  milestone("NydusNetwork", "Nydus Network", ["NydusNetwork"], START),
  milestone("LurkerDenMP", "Lurker Den", ["LurkerDenMP", "LurkerDen"], START),
]);

/** Race letter → ordered milestone list (display order). */
const GUIDE_MILESTONES = Object.freeze(
  /** @type {Readonly<Record<"P" | "T" | "Z", ReadonlyArray<Readonly<GuideMilestone>>>>} */ ({
    P: PROTOSS_MILESTONES,
    T: TERRAN_MILESTONES,
    Z: ZERG_MILESTONES,
  }),
);

/** @type {ReadonlyArray<Readonly<GuideMilestone>>} */
const NO_MILESTONES = Object.freeze([]);

/**
 * Milestones for a race letter or race word.
 *
 * Example: `milestonesForRace("Protoss")[0].key` → "Pylon".
 *
 * @param {unknown} race "P" | "Protoss" | … (first letter decides, case-insensitive)
 * @returns {ReadonlyArray<Readonly<GuideMilestone>>} empty for unknown races
 */
function milestonesForRace(race) {
  if (typeof race !== "string" || race.length === 0) return NO_MILESTONES;
  const letter = race[0].toUpperCase();
  if (letter !== "P" && letter !== "T" && letter !== "Z") return NO_MILESTONES;
  return GUIDE_MILESTONES[letter];
}

/**
 * One milestone by race and key.
 *
 * Example: `milestoneByKey("Z", "Lair").event` → "finish".
 *
 * @param {unknown} race
 * @param {unknown} key
 * @returns {Readonly<GuideMilestone>|null}
 */
function milestoneByKey(race, key) {
  return milestonesForRace(race).find((m) => m.key === key) || null;
}

module.exports = {
  GUIDE_MILESTONES,
  milestonesForRace,
  milestoneByKey,
};
