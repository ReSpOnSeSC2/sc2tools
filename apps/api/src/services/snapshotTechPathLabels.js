"use strict";

/**
 * snapshotTechPathLabels — alias table that maps a sorted frozenset
 * of decision-point buildings to a human-readable path label.
 *
 * The set is normalised by sorting + joining with "|" so the lookup
 * is a plain string-keyed dictionary access. Anything not in the
 * table falls back to comma-joining the building names with a
 * race prefix.
 *
 * Decision-point buildings (subset of the analyzer's tech-tier
 * table — drop universal prereqs like Forge / CyberneticsCore /
 * SpawningPool / EngineeringBay since every game has them):
 *
 *   Protoss:  TwilightCouncil, RoboticsFacility, Stargate,
 *             TemplarArchive, RoboticsBay, DarkShrine, FleetBeacon
 *   Terran:   Factory, Starport, Armory, GhostAcademy, FusionCore,
 *             BarracksTechLab, FactoryTechLab, StarportTechLab
 *   Zerg:     HydraliskDen, LurkerDen, InfestationPit, Spire,
 *             NydusNetwork, UltraliskCavern, GreaterSpire
 */

const DECISION_BUILDINGS = Object.freeze({
  P: new Set([
    "TwilightCouncil",
    "RoboticsFacility",
    "Stargate",
    "TemplarArchive",
    "RoboticsBay",
    "DarkShrine",
    "FleetBeacon",
  ]),
  T: new Set([
    "Factory",
    "Starport",
    "Armory",
    "GhostAcademy",
    "FusionCore",
    "BarracksTechLab",
    "FactoryTechLab",
    "StarportTechLab",
  ]),
  Z: new Set([
    "HydraliskDen",
    "LurkerDen",
    "InfestationPit",
    "Spire",
    "NydusNetwork",
    "UltraliskCavern",
    "GreaterSpire",
  ]),
});

const PATH_ALIASES = Object.freeze({
  // Protoss
  "TwilightCouncil": "Blink / Twilight only",
  "RoboticsFacility": "Robo only",
  "Stargate": "Stargate only",
  "RoboticsFacility|TwilightCouncil": "Twilight + Robo",
  "FleetBeacon|Stargate": "Skytoss",
  "RoboticsFacility|Stargate": "Stargate + Robo",
  "Stargate|TwilightCouncil": "Stargate + Twilight",
  "DarkShrine|TwilightCouncil": "DT drop / Twilight",
  "RoboticsBay|RoboticsFacility": "Robo + Bay (Colossus/Disruptor)",
  "TemplarArchive|TwilightCouncil": "HT / Templar tech",
  "RoboticsFacility|Stargate|TwilightCouncil": "Triple-tech (Pro all-three)",
  "FleetBeacon|RoboticsFacility|Stargate": "Skytoss + Robo",
  // Terran
  "BarracksTechLab": "Bio (Stim / CS)",
  "Factory": "Mech opening",
  "Starport": "Starport tech",
  "BarracksTechLab|Factory": "Bio-mech",
  "Factory|FactoryTechLab": "Pure mech",
  "Starport|StarportTechLab": "Raven / Banshee",
  "Factory|Starport": "Mech + Air",
  "Armory|Factory|FactoryTechLab": "Mech + upgrades",
  "GhostAcademy": "Ghost / EMP play",
  "BarracksTechLab|GhostAcademy": "Bio + Ghost",
  "FusionCore|Starport|StarportTechLab": "Battlecruiser tech",
  // Zerg
  "HydraliskDen": "Hydra opening",
  "LurkerDen": "Lurker tech",
  "Spire": "Mutalisk tech",
  "InfestationPit": "Infestor tech",
  "HydraliskDen|LurkerDen": "Hydra / Lurker",
  "HydraliskDen|Spire": "Hydra / Muta",
  "Spire|UltraliskCavern": "Ultra / Muta",
  "InfestationPit|UltraliskCavern": "Ultra + Infestor",
  "GreaterSpire|Spire": "Brood Lord tech",
  "NydusNetwork": "Nydus play",
});

/**
 * Build the canonical, stable signature for a path. Sort the
 * building names, join with "|". Same set of buildings → same
 * string, regardless of insertion order.
 *
 * @param {Iterable<string>} buildings
 */
function pathSignature(buildings) {
  const arr = Array.from(buildings).filter(
    (b) => typeof b === "string" && b.length > 0,
  );
  arr.sort();
  return arr.join("|");
}

/**
 * Stable short id derived from the signature — same shape but
 * snake_cased so it's URL-safe. Empty signature → "no_tech".
 *
 * @param {string} signature
 */
function pathIdFromSignature(signature) {
  if (!signature) return "no_tech";
  return signature
    .split("|")
    .map((s) => s.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase())
    .join("__");
}

/**
 * Map a building set to a human label. Looks up the alias first;
 * falls back to a comma-joined list when no alias matches so brand
 * new paths still read sensibly. The fallback prefixes the race
 * if known so "Stargate, Robotics, Twilight" doesn't get confused
 * with a Terran loadout.
 *
 * @param {Iterable<string>} buildings
 * @param {string|null} race  single-letter race ('P'|'T'|'Z')
 */
function pathLabel(buildings, race) {
  const arr = Array.from(buildings);
  if (arr.length === 0) return "No tech (T1 only)";
  const sig = pathSignature(arr);
  const alias = PATH_ALIASES[sig];
  if (alias) return alias;
  const prefix = race ? `${raceFull(race)}: ` : "";
  return prefix + arr.sort().join(", ");
}

/**
 * Filter an arbitrary set of building names down to the
 * decision-point subset for a race. Used by the path-extraction
 * pipeline before computing the signature.
 *
 * @param {Iterable<string>} buildings
 * @param {string|null} race
 */
function filterToDecisionBuildings(buildings, race) {
  const set = race ? DECISION_BUILDINGS[/** @type {'P'|'T'|'Z'} */ (race)] : null;
  if (!set) return [];
  /** @type {string[]} */
  const out = [];
  for (const b of buildings) {
    if (set.has(String(b))) out.push(String(b));
  }
  return out;
}

/** @param {string} letter */
function raceFull(letter) {
  if (letter === "P") return "Protoss";
  if (letter === "T") return "Terran";
  if (letter === "Z") return "Zerg";
  return "Unknown";
}

module.exports = {
  DECISION_BUILDINGS,
  PATH_ALIASES,
  pathSignature,
  pathIdFromSignature,
  pathLabel,
  filterToDecisionBuildings,
};
