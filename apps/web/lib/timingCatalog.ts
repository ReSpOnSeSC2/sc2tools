// Display-name + icon resolution for key-timing buildings.
//
// Mirrors `apps/api/src/services/timingCatalog.js` (which itself is the
// JS port of the desktop analyzer's Python source-of-truth catalog).
// The grid renders icons / display names for tokens reported in the
// API's `medianTimingsLegacy` / `matchupTimingsLegacy` payloads.

export type Token = {
  token: string;
  displayName: string;
  internalName: string;
  iconFile: string;
  tier: 1 | 2 | 3;
  category: "opener" | "production" | "tech" | "expansion" | "defense";
};

const ZERG: Token[] = [
  t("Hatchery", "Hatchery", "Hatchery", "hatchery.png", 1, "expansion"),
  t("Pool", "Spawning Pool", "SpawningPool", "spawningpool.png", 1, "tech"),
  t("Extractor", "Extractor", "Extractor", "extractor.png", 1, "production"),
  t("Evolution", "Evolution Chamber", "EvolutionChamber", "evolutionchamber.png", 1, "tech"),
  t("RoachWarren", "Roach Warren", "RoachWarren", "roachwarren.png", 1, "production"),
  t("BanelingNest", "Baneling Nest", "BanelingNest", "banelingnest.png", 2, "production"),
  t("Lair", "Lair", "Lair", "lair.png", 2, "expansion"),
  t("HydraliskDen", "Hydralisk Den", "HydraliskDen", "hydraliskden.png", 2, "production"),
  t("LurkerDen", "Lurker Den", "LurkerDen", "lurkerden.png", 2, "production"),
  t("Spire", "Spire", "Spire", "spire.png", 2, "production"),
  t("InfestationPit", "Infestation Pit", "InfestationPit", "infestationpit.png", 2, "tech"),
  t("Nydus", "Nydus Network", "NydusNetwork", "nydusnetwork.png", 2, "tech"),
  t("Hive", "Hive", "Hive", "hive.png", 3, "expansion"),
  t("UltraliskCavern", "Ultralisk Cavern", "UltraliskCavern", "ultraliskcavern.png", 3, "production"),
  t("GreaterSpire", "Greater Spire", "GreaterSpire", "greaterspire.png", 3, "production"),
];

const PROTOSS: Token[] = [
  t("Nexus", "Nexus", "Nexus", "nexus.png", 1, "expansion"),
  t("Pylon", "Pylon", "Pylon", "pylon.png", 1, "production"),
  t("Assimilator", "Assimilator", "Assimilator", "assimilator.png", 1, "production"),
  t("Gateway", "Gateway", "Gateway", "gateway.png", 1, "production"),
  t("WarpGate", "Warp Gate", "WarpGate", "warpgate.png", 1, "production"),
  t("Forge", "Forge", "Forge", "forge.png", 1, "tech"),
  t("Cybernetics", "Cybernetics Core", "CyberneticsCore", "cyberneticscore.png", 1, "tech"),
  t("PhotonCannon", "Photon Cannon", "PhotonCannon", "photoncannon.png", 1, "defense"),
  t("ShieldBattery", "Shield Battery", "ShieldBattery", "shieldbattery.png", 1, "defense"),
  t("Twilight", "Twilight Council", "TwilightCouncil", "twilightcouncil.png", 2, "tech"),
  t("RoboticsFacility", "Robotics Facility", "RoboticsFacility", "roboticsfacility.png", 2, "production"),
  t("Stargate", "Stargate", "Stargate", "stargate.png", 2, "production"),
  t("TemplarArchive", "Templar Archives", "TemplarArchive", "templararchive.png", 3, "tech"),
  t("DarkShrine", "Dark Shrine", "DarkShrine", "darkshrine.png", 3, "tech"),
  t("RoboticsBay", "Robotics Bay", "RoboticsBay", "roboticsbay.png", 3, "tech"),
  t("FleetBeacon", "Fleet Beacon", "FleetBeacon", "fleetbeacon.png", 3, "tech"),
];

const TERRAN: Token[] = [
  t("CommandCenter", "Command Center", "CommandCenter", "commandcenter.png", 1, "expansion"),
  t("OrbitalCommand", "Orbital Command", "OrbitalCommand", "orbitalcommand.png", 1, "expansion"),
  t("SupplyDepot", "Supply Depot", "SupplyDepot", "supplydepot.png", 1, "production"),
  t("Refinery", "Refinery", "Refinery", "refinery.png", 1, "production"),
  t("Barracks", "Barracks", "Barracks", "barracks.png", 1, "production"),
  t("EngineeringBay", "Engineering Bay", "EngineeringBay", "engineeringbay.png", 1, "tech"),
  t("Bunker", "Bunker", "Bunker", "bunker.png", 1, "defense"),
  t("MissileTurret", "Missile Turret", "MissileTurret", "missileturret.png", 1, "defense"),
  t("Factory", "Factory", "Factory", "factory.png", 2, "production"),
  t("GhostAcademy", "Ghost Academy", "GhostAcademy", "ghostacademy.png", 2, "tech"),
  t("Starport", "Starport", "Starport", "starport.png", 2, "production"),
  t("Armory", "Armory", "Armory", "armory.png", 2, "tech"),
  t("FusionCore", "Fusion Core", "FusionCore", "fusioncore.png", 3, "tech"),
  t("PlanetaryFortress", "Planetary Fortress", "PlanetaryFortress", "planetaryfortress.png", 3, "expansion"),
];

function t(
  token: string,
  displayName: string,
  internalName: string,
  iconFile: string,
  tier: 1 | 2 | 3,
  category: Token["category"],
): Token {
  return Object.freeze({ token, displayName, internalName, iconFile, tier, category });
}

const BY_INTERNAL: Record<string, Token> = (() => {
  const m: Record<string, Token> = {};
  for (const list of [ZERG, PROTOSS, TERRAN]) {
    for (const tk of list) m[tk.internalName] = tk;
  }
  return m;
})();

export function tokenByInternalName(internalName: string): Token | null {
  return BY_INTERNAL[internalName] || null;
}

export function buildingDisplayName(internalName: string, fallback = ""): string {
  const tk = BY_INTERNAL[internalName];
  return tk ? tk.displayName : fallback || internalName;
}

export function buildingIconFile(internalName: string): string | null {
  const tk = BY_INTERNAL[internalName];
  return tk ? tk.iconFile : null;
}

export function buildingTier(internalName: string): 1 | 2 | 3 | null {
  const tk = BY_INTERNAL[internalName];
  return tk ? tk.tier : null;
}
