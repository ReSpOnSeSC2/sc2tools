"use strict";

/**
 * Canonical set of structure names recognised as buildings.
 *
 * Used as the deterministic fallback for ``parseBuildLogLines`` when
 * the JSON catalog isn't loaded (cold start, missing
 * ``data/sc2_catalog.json`` file in the deployment image, or an
 * unknown name the catalog hasn't enumerated).
 *
 * Without this fallback, every build-log entry was previously classified
 * as a unit and the macro-breakdown panel's Buildings roster rendered
 * empty — the symptom the production-quality fix targets.
 *
 * Names match the canonical sc2reader form (PascalCase, no spaces). The
 * agent's build_log emits in the same form so direct set membership
 * suffices — no normalisation needed beyond optional race-prefix strip.
 */
const KNOWN_BUILDING_NAMES = new Set([
  // Zerg
  "Hatchery", "Lair", "Hive", "Extractor", "ExtractorRich",
  "SpawningPool", "EvolutionChamber", "RoachWarren", "BanelingNest",
  "HydraliskDen", "LurkerDen", "LurkerDenMP", "InfestationPit",
  "Spire", "GreaterSpire", "UltraliskCavern",
  "NydusNetwork", "NydusCanal", "NydusWorm",
  "SpineCrawler", "SporeCrawler",
  "SpineCrawlerUprooted", "SporeCrawlerUprooted",
  "CreepTumor", "CreepTumorBurrowed", "CreepTumorQueen",
  // Protoss
  "Nexus", "Pylon", "Assimilator", "AssimilatorRich",
  "Gateway", "WarpGate", "Forge", "CyberneticsCore",
  "TwilightCouncil", "RoboticsFacility", "RoboticsBay",
  "Stargate", "FleetBeacon",
  "TemplarArchives", "TemplarArchive", "DarkShrine",
  "PhotonCannon", "ShieldBattery",
  "StasisTrap",
  // Terran
  "CommandCenter", "OrbitalCommand", "PlanetaryFortress",
  "CommandCenterFlying", "OrbitalCommandFlying",
  "SupplyDepot", "SupplyDepotLowered",
  "Refinery", "RefineryRich",
  "Barracks", "BarracksFlying",
  "EngineeringBay",
  "Factory", "FactoryFlying",
  "Starport", "StarportFlying",
  "Armory", "Bunker", "GhostAcademy", "FusionCore",
  "MissileTurret", "SensorTower",
  "TechLab", "Reactor",
  "BarracksTechLab", "BarracksReactor",
  "FactoryTechLab", "FactoryReactor",
  "StarportTechLab", "StarportReactor",
  "AutoTurret",
]);

/**
 * @param {string | null | undefined} name
 * @returns {boolean}
 */
function isKnownBuilding(name) {
  if (!name) return false;
  if (KNOWN_BUILDING_NAMES.has(name)) return true;
  // Names occasionally arrive with race prefixes the catalog scrubbed
  // (e.g. ``ProtossPylon``) — strip a leading race prefix and re-check.
  const stripped = name.replace(/^(Protoss|Terran|Zerg)/, "");
  return stripped !== name && KNOWN_BUILDING_NAMES.has(stripped);
}

module.exports = { KNOWN_BUILDING_NAMES, isKnownBuilding };
