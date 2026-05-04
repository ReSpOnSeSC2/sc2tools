"use strict";

/**
 * Canonical catalog of key-timing buildings — Node port of
 * `reveal-sc2-opponent-main/stream-overlay-backend/public/analyzer/timing_catalog.js`.
 *
 * Used by `dnaTimings.js` to compute matchup-aware median first-occurrence
 * timings for opponent build_log lines. Kept in lockstep with the legacy
 * source-of-truth so the cloud profile view shows the exact same tokens
 * the SPA / desktop app shows.
 */

function tok(token, displayName, internalName, iconFile, tier, category) {
  return Object.freeze({
    token,
    displayName,
    internalName,
    iconFile,
    tier,
    category,
  });
}

const ZERG = Object.freeze([
  tok("Hatchery", "Hatchery", "Hatchery", "hatchery.png", 1, "expansion"),
  tok("Pool", "Spawning Pool", "SpawningPool", "spawningpool.png", 1, "tech"),
  tok("Extractor", "Extractor", "Extractor", "extractor.png", 1, "production"),
  tok("Evolution", "Evolution Chamber", "EvolutionChamber", "evolutionchamber.png", 1, "tech"),
  tok("RoachWarren", "Roach Warren", "RoachWarren", "roachwarren.png", 1, "production"),
  tok("BanelingNest", "Baneling Nest", "BanelingNest", "banelingnest.png", 2, "production"),
  tok("Lair", "Lair", "Lair", "lair.png", 2, "expansion"),
  tok("HydraliskDen", "Hydralisk Den", "HydraliskDen", "hydraliskden.png", 2, "production"),
  tok("LurkerDen", "Lurker Den", "LurkerDen", "lurkerden.png", 2, "production"),
  tok("Spire", "Spire", "Spire", "spire.png", 2, "production"),
  tok("InfestationPit", "Infestation Pit", "InfestationPit", "infestationpit.png", 2, "tech"),
  tok("Nydus", "Nydus Network", "NydusNetwork", "nydusnetwork.png", 2, "tech"),
  tok("Hive", "Hive", "Hive", "hive.png", 3, "expansion"),
  tok("UltraliskCavern", "Ultralisk Cavern", "UltraliskCavern", "ultraliskcavern.png", 3, "production"),
  tok("GreaterSpire", "Greater Spire", "GreaterSpire", "greaterspire.png", 3, "production"),
]);

const PROTOSS = Object.freeze([
  tok("Nexus", "Nexus", "Nexus", "nexus.png", 1, "expansion"),
  tok("Pylon", "Pylon", "Pylon", "pylon.png", 1, "production"),
  tok("Assimilator", "Assimilator", "Assimilator", "assimilator.png", 1, "production"),
  tok("Gateway", "Gateway", "Gateway", "gateway.png", 1, "production"),
  tok("WarpGate", "Warp Gate", "WarpGate", "warpgate.png", 1, "production"),
  tok("Forge", "Forge", "Forge", "forge.png", 1, "tech"),
  tok("Cybernetics", "Cybernetics Core", "CyberneticsCore", "cyberneticscore.png", 1, "tech"),
  tok("PhotonCannon", "Photon Cannon", "PhotonCannon", "photoncannon.png", 1, "defense"),
  tok("ShieldBattery", "Shield Battery", "ShieldBattery", "shieldbattery.png", 1, "defense"),
  tok("Twilight", "Twilight Council", "TwilightCouncil", "twilightcouncil.png", 2, "tech"),
  tok("RoboticsFacility", "Robotics Facility", "RoboticsFacility", "roboticsfacility.png", 2, "production"),
  tok("Stargate", "Stargate", "Stargate", "stargate.png", 2, "production"),
  tok("TemplarArchive", "Templar Archives", "TemplarArchive", "templararchive.png", 3, "tech"),
  tok("DarkShrine", "Dark Shrine", "DarkShrine", "darkshrine.png", 3, "tech"),
  tok("RoboticsBay", "Robotics Bay", "RoboticsBay", "roboticsbay.png", 3, "tech"),
  tok("FleetBeacon", "Fleet Beacon", "FleetBeacon", "fleetbeacon.png", 3, "tech"),
]);

const TERRAN = Object.freeze([
  tok("CommandCenter", "Command Center", "CommandCenter", "commandcenter.png", 1, "expansion"),
  tok("OrbitalCommand", "Orbital Command", "OrbitalCommand", "orbitalcommand.png", 1, "expansion"),
  tok("SupplyDepot", "Supply Depot", "SupplyDepot", "supplydepot.png", 1, "production"),
  tok("Refinery", "Refinery", "Refinery", "refinery.png", 1, "production"),
  tok("Barracks", "Barracks", "Barracks", "barracks.png", 1, "production"),
  tok("EngineeringBay", "Engineering Bay", "EngineeringBay", "engineeringbay.png", 1, "tech"),
  tok("Bunker", "Bunker", "Bunker", "bunker.png", 1, "defense"),
  tok("MissileTurret", "Missile Turret", "MissileTurret", "missileturret.png", 1, "defense"),
  tok("Factory", "Factory", "Factory", "factory.png", 2, "production"),
  tok("GhostAcademy", "Ghost Academy", "GhostAcademy", "ghostacademy.png", 2, "tech"),
  tok("Starport", "Starport", "Starport", "starport.png", 2, "production"),
  tok("Armory", "Armory", "Armory", "armory.png", 2, "tech"),
  tok("FusionCore", "Fusion Core", "FusionCore", "fusioncore.png", 3, "tech"),
  tok("PlanetaryFortress", "Planetary Fortress", "PlanetaryFortress", "planetaryfortress.png", 3, "expansion"),
]);

const RACE_BUILDINGS = Object.freeze({ Z: ZERG, P: PROTOSS, T: TERRAN });

const BY_INTERNAL = (function () {
  const m = Object.create(null);
  for (const race of Object.keys(RACE_BUILDINGS)) {
    for (const t of RACE_BUILDINGS[race]) {
      m[t.internalName] = t;
    }
  }
  return Object.freeze(m);
})();

const RACE_ALIASES = {
  z: "Z",
  zerg: "Z",
  p: "P",
  protoss: "P",
  toss: "P",
  t: "T",
  terran: "T",
};

function normalizeRace(race) {
  if (race == null) return "";
  const s = String(race).trim().toLowerCase();
  if (!s) return "";
  return RACE_ALIASES[s] || "";
}

function matchupLabel(myRace, oppRace) {
  const my = normalizeRace(myRace);
  const opp = normalizeRace(oppRace);
  if (!my || !opp) return "";
  return my + "v" + opp;
}

const _relevantCache = Object.create(null);

function relevantTokens(myRace, oppRace) {
  const my = normalizeRace(myRace);
  const opp = normalizeRace(oppRace);
  if (!my || !opp) return [];
  const key = my + "|" + opp;
  const cached = _relevantCache[key];
  if (cached) return cached.slice();
  const seen = Object.create(null);
  const out = [];
  for (const race of [my, opp]) {
    for (const t of RACE_BUILDINGS[race]) {
      if (seen[t.internalName]) continue;
      seen[t.internalName] = true;
      out.push(t);
    }
  }
  _relevantCache[key] = out;
  return out.slice();
}

function tokenByInternalName(internalName) {
  return BY_INTERNAL[internalName] || null;
}

module.exports = {
  RACE_BUILDINGS,
  ZERG,
  PROTOSS,
  TERRAN,
  normalizeRace,
  matchupLabel,
  relevantTokens,
  tokenByInternalName,
};
