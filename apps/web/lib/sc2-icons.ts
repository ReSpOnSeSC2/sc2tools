/**
 * SC2 icon registry for the web app — port of the overlay's
 * icon-registry.js, surfaced through a typed API.
 *
 * Public surface:
 *   - getIconPath(name, kind?) → "/icons/sc2/<dir>/<file>" or null
 *   - normalizeIconName(name)  → kebab-case-no-space lowercase key
 *   - resolveStrategyIcons(strategyName, max=3) → string[]
 *   - resolveRaceIcon(letterOrName) → string | null
 *   - resolveLeagueIcon(name) → string | null
 *   - AVAILABLE_ICONS — Set<string> ("buildings/nexus", etc.)
 */

export type IconKind = "building" | "unit" | "upgrade" | "race" | "league";

export const ICON_BASE = "/icons/sc2";

/** Files actually present on disk (keep in sync with public/icons/sc2). */
const BUILDINGS = [
  "armory", "assimilator", "banelingnest", "barracks", "bunker",
  "commandcenter", "cyberneticscore", "darkshrine", "engineeringbay",
  "evolutionchamber", "extractor", "factory", "fleetbeacon", "forge",
  "fusioncore", "gateway", "ghostacademy", "greaterspire", "hatchery",
  "hive", "hydraliskden", "infestationpit", "lair", "lurkerden",
  "missileturret", "nexus", "nydusnetwork", "orbitalcommand",
  "photoncannon", "planetaryfortress", "pylon", "refinery",
  "roachwarren", "roboticsbay", "roboticsfacility", "shieldbattery",
  "spawningpool", "spire", "stargate", "starport", "supplydepot",
  "templararchive", "twilightcouncil", "ultraliskcavern", "warpgate",
] as const;

const UNITS = [
  "adept", "archon", "baneling", "banshee", "battlecruiser", "broodlord",
  "carrier", "colossus", "corruptor", "cyclone", "darktemplar", "disruptor",
  "drone", "ghost", "hellbat", "hellion", "hightemplar", "hydralisk",
  "immortal", "infestor", "liberator", "lurker", "marauder", "marine",
  "medivac", "mothership", "mule", "mutalisk", "observer", "oracle",
  "overlord", "overseer", "phoenix", "probe", "queen", "ravager", "raven",
  "reaper", "roach", "scv", "sentry", "siegetank", "stalker", "swarmhost",
  "tempest", "thor", "ultralisk", "viking", "viper", "voidray",
  "warpprism", "widowmine", "zealot", "zergling",
] as const;

const UPGRADES = [
  // Legacy short aliases — kept for backwards compat with existing
  // strategy overrides and KEYWORDS entries. These resolve to the
  // same PNG as their canonical long-form counterparts (e.g. `blink`
  // and `blinktech` both render the Protoss Blink icon).
  "blink", "charge", "cloak", "combatshield", "concussive", "glaive",
  "speed", "stim",
  // Protoss multiplayer upgrades (sc2reader canonical names where
  // possible, display-derived short names otherwise).
  "warpgateresearch", "resonatingglaives", "psistorm", "shadowstride",
  "extendedthermallance", "graviticdrive", "graviticboosters",
  "anionpulsecrystals", "fluxvanes", "tectonicdestabilizers",
  "protossgroundweapons1", "protossgroundweapons2", "protossgroundweapons3",
  "protossgroundarmor1", "protossgroundarmor2", "protossgroundarmor3",
  "protossshields1", "protossshields2", "protossshields3",
  "protossairweapons1", "protossairweapons2", "protossairweapons3",
  "protossairarmor1", "protossairarmor2", "protossairarmor3",
  // Terran multiplayer upgrades.
  "hisecautotracking", "neosteelarmor", "drillingclaws",
  "magfieldaccelerator", "infernalpreigniter", "smartservos",
  "hyperflightrotors", "corvidreactor", "enhancedshockwaves",
  "caduceusreactor", "rapidreignition", "advancedballistics",
  "yamatocannon", "weaponrefit", "personalcloak",
  "terraninfantryweapons1", "terraninfantryweapons2", "terraninfantryweapons3",
  "terraninfantryarmor1", "terraninfantryarmor2", "terraninfantryarmor3",
  "terranvehicleweapons1", "terranvehicleweapons2", "terranvehicleweapons3",
  "terranvehiclearmor1", "terranvehiclearmor2", "terranvehiclearmor3",
  "terranshipweapons1", "terranshipweapons2", "terranshipweapons3",
  // Zerg multiplayer upgrades.
  "burrow", "pneumatizedcarapace", "metabolicboost", "adrenalglands",
  "centrifugalhooks", "glialreconstitution", "tunnelingclaws",
  "muscularaugments", "groovedspines", "seismicspines", "adaptivetalons",
  "anabolicsynthesis", "chitinousplating", "pathogenglands", "neuralparasite",
  "frenzy", "microbialshroud",
  "zergmissileattacks1", "zergmissileattacks2", "zergmissileattacks3",
  "zergmeleeattacks1", "zergmeleeattacks2", "zergmeleeattacks3",
  "zerggroundcarapace1", "zerggroundcarapace2", "zerggroundcarapace3",
  "zergflyerattacks1", "zergflyerattacks2", "zergflyerattacks3",
  "zergflyercarapace1", "zergflyercarapace2", "zergflyercarapace3",
] as const;

const RACES_SVG = ["protoss", "random", "terran", "zerg"] as const;

const LEAGUES_SVG = [
  "bronze", "silver", "gold", "platinum", "diamond", "master",
  "grandmaster", "tier-1", "tier-2", "tier-3",
] as const;

/** Build the on-disk-presence set used by missing-icon fallback. */
export const AVAILABLE_ICONS: ReadonlySet<string> = new Set([
  ...BUILDINGS.map((n) => `buildings/${n}.png`),
  ...UNITS.map((n) => `units/${n}.png`),
  ...UPGRADES.map((n) => `upgrades/${n}.png`),
  ...RACES_SVG.map((n) => `races/${n}.svg`),
  ...LEAGUES_SVG.map((n) => `leagues/${n}.svg`),
]);

/**
 * Normalize a free-form name to the icon key shape.
 * "High Templar" → "hightemplar"
 * "Warp Prism"   → "warpprism"
 * "Void Ray"     → "voidray"
 * "spawning-pool"→ "spawningpool"
 */
export function normalizeIconName(input: string): string {
  return String(input)
    .toLowerCase()
    .replace(/[\s_\-./]+/g, "")
    .replace(/[^a-z0-9]/g, "");
}

const BUILDING_SET = new Set(BUILDINGS as readonly string[]);
const UNIT_SET = new Set(UNITS as readonly string[]);
const UPGRADE_SET = new Set(UPGRADES as readonly string[]);
const RACE_SET = new Set(RACES_SVG as readonly string[]);
const LEAGUE_SET = new Set(LEAGUES_SVG as readonly string[]);

/** Synonym map — normalized name → canonical icon key.
 *
 * Upgrade entries cover the sc2reader ``upgrade_type_name`` form (key
 * after ``normalizeIconName``) AND the human-readable display form
 * agents sometimes emit. So all of "BlinkTech", "Blink Tech", and
 * "Blink" resolve to the same PNG. Display names that contain a
 * non-alpha character (e.g. "+1", "Anion Pulse-Crystals") still
 * normalise cleanly because ``normalizeIconName`` strips them.
 */
const SYNONYMS: Record<string, { kind: IconKind; key: string }> = {
  // race shorthand
  z: { kind: "race", key: "zerg" },
  p: { kind: "race", key: "protoss" },
  t: { kind: "race", key: "terran" },
  r: { kind: "race", key: "random" },
  // unit shorthand
  ling: { kind: "unit", key: "zergling" },
  speedling: { kind: "unit", key: "zergling" },
  bane: { kind: "unit", key: "baneling" },
  hydra: { kind: "unit", key: "hydralisk" },
  muta: { kind: "unit", key: "mutalisk" },
  ultra: { kind: "unit", key: "ultralisk" },
  dt: { kind: "unit", key: "darktemplar" },
  ht: { kind: "unit", key: "hightemplar" },
  chargelot: { kind: "unit", key: "zealot" },
  void: { kind: "unit", key: "voidray" },
  bc: { kind: "unit", key: "battlecruiser" },
  tank: { kind: "unit", key: "siegetank" },
  mine: { kind: "unit", key: "widowmine" },
  // building shorthand
  rax: { kind: "building", key: "barracks" },
  pool: { kind: "building", key: "spawningpool" },
  hatch: { kind: "building", key: "hatchery" },
  cannon: { kind: "building", key: "photoncannon" },
  turret: { kind: "building", key: "missileturret" },
  twilight: { kind: "building", key: "twilightcouncil" },
  robo: { kind: "building", key: "roboticsfacility" },
  orbital: { kind: "building", key: "orbitalcommand" },
  planetary: { kind: "building", key: "planetaryfortress" },
  nydus: { kind: "building", key: "nydusnetwork" },
  // ---- Protoss upgrades ----
  blinktech: { kind: "upgrade", key: "blink" },
  psistormtech: { kind: "upgrade", key: "psistorm" },
  psionicstorm: { kind: "upgrade", key: "psistorm" },
  adeptpiercingattack: { kind: "upgrade", key: "resonatingglaives" },
  darktemplarblinkupgrade: { kind: "upgrade", key: "shadowstride" },
  observergraviticbooster: { kind: "upgrade", key: "graviticboosters" },
  phoenixrangeupgrade: { kind: "upgrade", key: "anionpulsecrystals" },
  voidrayspeedupgrade: { kind: "upgrade", key: "fluxvanes" },
  tempestgroundattackupgrade: { kind: "upgrade", key: "tectonicdestabilizers" },
  // Protoss ground/air/shield arrays (sc2reader keys → file keys).
  protossgroundweaponslevel1: { kind: "upgrade", key: "protossgroundweapons1" },
  protossgroundweaponslevel2: { kind: "upgrade", key: "protossgroundweapons2" },
  protossgroundweaponslevel3: { kind: "upgrade", key: "protossgroundweapons3" },
  protossgroundarmorslevel1: { kind: "upgrade", key: "protossgroundarmor1" },
  protossgroundarmorslevel2: { kind: "upgrade", key: "protossgroundarmor2" },
  protossgroundarmorslevel3: { kind: "upgrade", key: "protossgroundarmor3" },
  protossshieldslevel1: { kind: "upgrade", key: "protossshields1" },
  protossshieldslevel2: { kind: "upgrade", key: "protossshields2" },
  protossshieldslevel3: { kind: "upgrade", key: "protossshields3" },
  protossairweaponslevel1: { kind: "upgrade", key: "protossairweapons1" },
  protossairweaponslevel2: { kind: "upgrade", key: "protossairweapons2" },
  protossairweaponslevel3: { kind: "upgrade", key: "protossairweapons3" },
  protossairarmorslevel1: { kind: "upgrade", key: "protossairarmor1" },
  protossairarmorslevel2: { kind: "upgrade", key: "protossairarmor2" },
  protossairarmorslevel3: { kind: "upgrade", key: "protossairarmor3" },
  // ---- Terran upgrades ----
  stimpack: { kind: "upgrade", key: "stim" },
  shieldwall: { kind: "upgrade", key: "combatshield" },
  punishergrenades: { kind: "upgrade", key: "concussive" },
  concussiveshells: { kind: "upgrade", key: "concussive" },
  terranbuildingarmor: { kind: "upgrade", key: "neosteelarmor" },
  drillclaws: { kind: "upgrade", key: "drillingclaws" },
  cyclonelockondamageupgrade: { kind: "upgrade", key: "magfieldaccelerator" },
  highcapacitybarrels: { kind: "upgrade", key: "infernalpreigniter" },
  bansheecloak: { kind: "upgrade", key: "cloak" },
  cloakingfield: { kind: "upgrade", key: "cloak" },
  bansheespeed: { kind: "upgrade", key: "hyperflightrotors" },
  ravencorvidreactor: { kind: "upgrade", key: "corvidreactor" },
  medivaccaduceusreactor: { kind: "upgrade", key: "caduceusreactor" },
  medivacincreasespeedboost: { kind: "upgrade", key: "rapidreignition" },
  liberatoragrangeupgrade: { kind: "upgrade", key: "advancedballistics" },
  battlecruiserenablespecializations: { kind: "upgrade", key: "weaponrefit" },
  personalcloaking: { kind: "upgrade", key: "personalcloak" },
  // Terran ground/air arrays
  terraninfantryweaponslevel1: { kind: "upgrade", key: "terraninfantryweapons1" },
  terraninfantryweaponslevel2: { kind: "upgrade", key: "terraninfantryweapons2" },
  terraninfantryweaponslevel3: { kind: "upgrade", key: "terraninfantryweapons3" },
  terraninfantryarmorslevel1: { kind: "upgrade", key: "terraninfantryarmor1" },
  terraninfantryarmorslevel2: { kind: "upgrade", key: "terraninfantryarmor2" },
  terraninfantryarmorslevel3: { kind: "upgrade", key: "terraninfantryarmor3" },
  terranvehicleweaponslevel1: { kind: "upgrade", key: "terranvehicleweapons1" },
  terranvehicleweaponslevel2: { kind: "upgrade", key: "terranvehicleweapons2" },
  terranvehicleweaponslevel3: { kind: "upgrade", key: "terranvehicleweapons3" },
  terranvehicleandshiparmorslevel1: { kind: "upgrade", key: "terranvehiclearmor1" },
  terranvehicleandshiparmorslevel2: { kind: "upgrade", key: "terranvehiclearmor2" },
  terranvehicleandshiparmorslevel3: { kind: "upgrade", key: "terranvehiclearmor3" },
  terranshipweaponslevel1: { kind: "upgrade", key: "terranshipweapons1" },
  terranshipweaponslevel2: { kind: "upgrade", key: "terranshipweapons2" },
  terranshipweaponslevel3: { kind: "upgrade", key: "terranshipweapons3" },
  // ---- Zerg upgrades ----
  overlordspeed: { kind: "upgrade", key: "pneumatizedcarapace" },
  zerglingmetabolicboost: { kind: "upgrade", key: "metabolicboost" },
  zerglingmovementspeed: { kind: "upgrade", key: "metabolicboost" },
  zerglingadrenalglands: { kind: "upgrade", key: "adrenalglands" },
  zerglingattackspeed: { kind: "upgrade", key: "adrenalglands" },
  centrificalhooks: { kind: "upgrade", key: "centrifugalhooks" },
  evolvemuscularaugments: { kind: "upgrade", key: "muscularaugments" },
  evolvegroovedspines: { kind: "upgrade", key: "groovedspines" },
  lurkerrange: { kind: "upgrade", key: "seismicspines" },
  diggingclaws: { kind: "upgrade", key: "adaptivetalons" },
  infestorenergyupgrade: { kind: "upgrade", key: "pathogenglands" },
  zergmissileweaponslevel1: { kind: "upgrade", key: "zergmissileattacks1" },
  zergmissileweaponslevel2: { kind: "upgrade", key: "zergmissileattacks2" },
  zergmissileweaponslevel3: { kind: "upgrade", key: "zergmissileattacks3" },
  zergmeleeweaponslevel1: { kind: "upgrade", key: "zergmeleeattacks1" },
  zergmeleeweaponslevel2: { kind: "upgrade", key: "zergmeleeattacks2" },
  zergmeleeweaponslevel3: { kind: "upgrade", key: "zergmeleeattacks3" },
  zerggroundarmorslevel1: { kind: "upgrade", key: "zerggroundcarapace1" },
  zerggroundarmorslevel2: { kind: "upgrade", key: "zerggroundcarapace2" },
  zerggroundarmorslevel3: { kind: "upgrade", key: "zerggroundcarapace3" },
  zergflyerweaponslevel1: { kind: "upgrade", key: "zergflyerattacks1" },
  zergflyerweaponslevel2: { kind: "upgrade", key: "zergflyerattacks2" },
  zergflyerweaponslevel3: { kind: "upgrade", key: "zergflyerattacks3" },
  zergflyerarmorslevel1: { kind: "upgrade", key: "zergflyercarapace1" },
  zergflyerarmorslevel2: { kind: "upgrade", key: "zergflyercarapace2" },
  zergflyerarmorslevel3: { kind: "upgrade", key: "zergflyercarapace3" },
};

function lookupKind(normalized: string, hint?: IconKind):
  | { kind: IconKind; key: string }
  | null {
  if (hint) {
    const set = setForKind(hint);
    if (set.has(normalized)) return { kind: hint, key: normalized };
  }
  if (SYNONYMS[normalized]) return SYNONYMS[normalized];
  if (BUILDING_SET.has(normalized)) return { kind: "building", key: normalized };
  if (UNIT_SET.has(normalized)) return { kind: "unit", key: normalized };
  if (UPGRADE_SET.has(normalized)) return { kind: "upgrade", key: normalized };
  if (RACE_SET.has(normalized)) return { kind: "race", key: normalized };
  if (LEAGUE_SET.has(normalized)) return { kind: "league", key: normalized };
  return null;
}

function setForKind(kind: IconKind): Set<string> {
  switch (kind) {
    case "building": return BUILDING_SET;
    case "unit": return UNIT_SET;
    case "upgrade": return UPGRADE_SET;
    case "race": return RACE_SET;
    case "league": return LEAGUE_SET;
  }
}

function dirAndExtForKind(kind: IconKind): { dir: string; ext: string } {
  switch (kind) {
    case "building": return { dir: "buildings", ext: "png" };
    case "unit": return { dir: "units", ext: "png" };
    case "upgrade": return { dir: "upgrades", ext: "png" };
    case "race": return { dir: "races", ext: "svg" };
    case "league": return { dir: "leagues", ext: "svg" };
  }
}

/**
 * Resolve a name (free-form, with or without spaces) to an icon URL.
 * Returns null if the name doesn't match any known icon.
 */
export function getIconPath(name: string, kind?: IconKind): string | null {
  if (!name) return null;
  const hit = lookupKind(normalizeIconName(name), kind);
  if (!hit) return null;
  const { dir, ext } = dirAndExtForKind(hit.kind);
  const rel = `${dir}/${hit.key}.${ext}`;
  if (!AVAILABLE_ICONS.has(rel)) return null;
  return `${ICON_BASE}/${rel}`;
}

export function resolveRaceIcon(input: string): string | null {
  if (!input) return null;
  const trimmed = String(input).trim();
  if (trimmed.length === 1) return getIconPath(trimmed, "race");
  return getIconPath(trimmed, "race");
}

export function resolveLeagueIcon(input: string): string | null {
  if (!input) return null;
  return getIconPath(input, "league");
}

/* ============================================================
 * Strategy → icon resolution (mirrors overlay/icon-registry.js)
 *
 * 1. Explicit STRATEGY_OVERRIDES table wins.
 * 2. Otherwise scan KEYWORDS in order, collecting up to N icons.
 *    Building → unit → upgrade priority is preserved.
 * ============================================================ */

const STRATEGY_OVERRIDES: Record<string, string[]> = {
  "Zerg - 12 Pool": ["buildings/spawningpool.png", "units/zergling.png"],
  "Zerg - 13/12 Baneling Bust": ["buildings/banelingnest.png", "units/baneling.png"],
  "Zerg - 13/12 Speedling Aggression": ["units/zergling.png", "upgrades/speed.png"],
  "Zerg - 17 Hatch 18 Gas 17 Pool": ["buildings/hatchery.png", "buildings/spawningpool.png"],
  "Zerg - 1 Base Roach Rush": ["buildings/roachwarren.png", "units/roach.png"],
  "Zerg - 2 Base Roach/Ravager All-in": ["units/roach.png", "units/ravager.png"],
  "Zerg - 2 Base Muta Rush": ["buildings/spire.png", "units/mutalisk.png"],
  "Zerg - 2 Base Nydus": ["buildings/nydusnetwork.png"],
  "Zerg - Muta/Ling/Bane Comp": ["units/mutalisk.png", "units/baneling.png", "units/zergling.png"],
  "Zerg - Roach/Ravager Comp": ["units/roach.png", "units/ravager.png"],
  "Zerg - Hydra Comp": ["units/hydralisk.png"],

  "Protoss - Cannon Rush": ["buildings/photoncannon.png"],
  "Protoss - Proxy 4 Gate": ["buildings/gateway.png", "units/zealot.png"],
  "Protoss - DT Rush": ["buildings/darkshrine.png", "units/darktemplar.png"],
  "Protoss - 4 Gate Rush": ["buildings/gateway.png", "units/stalker.png"],
  "Protoss - Glaive Adept Timing": ["units/adept.png", "upgrades/glaive.png"],
  "Protoss - Chargelot All-in": ["units/zealot.png", "upgrades/charge.png"],
  "Protoss - Stargate Opener": ["buildings/stargate.png", "units/voidray.png"],
  "Protoss - Robo Opener": ["buildings/roboticsfacility.png", "units/immortal.png"],
  "Protoss - Blink All-In": ["units/stalker.png", "upgrades/blink.png"],
  "Protoss - Skytoss Transition": ["units/carrier.png"],
  "Protoss - Robo Comp": ["units/colossus.png", "units/disruptor.png"],
  "Protoss - Chargelot/Archon Comp": ["units/zealot.png", "units/archon.png"],

  "Terran - 2 Gas 3 Reaper 2 Hellion": ["units/reaper.png", "units/hellion.png"],
  "Terran - Proxy Rax": ["buildings/barracks.png", "units/marine.png"],
  "Terran - Ghost Rush": ["buildings/ghostacademy.png", "units/ghost.png"],
  "Terran - Cyclone Rush": ["units/cyclone.png", "buildings/factory.png"],
  "Terran - Hellbat All-in": ["units/hellion.png", "buildings/armory.png"],
  "Terran - Widow Mine Drop": ["units/widowmine.png", "units/medivac.png"],
  "Terran - BC Rush": ["buildings/fusioncore.png", "units/battlecruiser.png"],
  "Terran - Banshee Rush": ["units/banshee.png"],
  "Terran - Fast 3 CC": ["buildings/commandcenter.png"],
  "Terran - 1-1-1 Standard": ["buildings/factory.png", "buildings/starport.png", "buildings/barracks.png"],
  "Terran - Standard Bio Tank": ["units/marine.png", "units/medivac.png", "units/siegetank.png"],
  "Terran - Mech Comp": ["units/siegetank.png", "units/thor.png"],
  "Terran - Bio Comp": ["units/marine.png", "units/marauder.png", "units/medivac.png"],
  "Terran - SkyTerran": ["units/battlecruiser.png", "units/liberator.png"],
};

const KEYWORDS: ReadonlyArray<{ kw: string; rel: string }> = [
  // Buildings
  { kw: "spawningpool", rel: "buildings/spawningpool.png" },
  { kw: "spawning pool", rel: "buildings/spawningpool.png" },
  { kw: "pool", rel: "buildings/spawningpool.png" },
  { kw: "banelingnest", rel: "buildings/banelingnest.png" },
  { kw: "baneling nest", rel: "buildings/banelingnest.png" },
  { kw: "roachwarren", rel: "buildings/roachwarren.png" },
  { kw: "roach warren", rel: "buildings/roachwarren.png" },
  { kw: "hydraliskden", rel: "buildings/hydraliskden.png" },
  { kw: "hydralisk den", rel: "buildings/hydraliskden.png" },
  { kw: "lurkerden", rel: "buildings/lurkerden.png" },
  { kw: "spire", rel: "buildings/spire.png" },
  { kw: "nydus", rel: "buildings/nydusnetwork.png" },
  { kw: "hatchery", rel: "buildings/hatchery.png" },
  { kw: "hatch", rel: "buildings/hatchery.png" },
  { kw: "lair", rel: "buildings/lair.png" },
  { kw: "hive", rel: "buildings/hive.png" },
  { kw: "evolutionchamber", rel: "buildings/evolutionchamber.png" },
  { kw: "extractor", rel: "buildings/extractor.png" },
  { kw: "infestationpit", rel: "buildings/infestationpit.png" },
  { kw: "ultraliskcavern", rel: "buildings/ultraliskcavern.png" },
  { kw: "gateway", rel: "buildings/gateway.png" },
  { kw: "warpgate", rel: "buildings/warpgate.png" },
  { kw: "photoncannon", rel: "buildings/photoncannon.png" },
  { kw: "cannon", rel: "buildings/photoncannon.png" },
  { kw: "forge", rel: "buildings/forge.png" },
  { kw: "cyberneticscore", rel: "buildings/cyberneticscore.png" },
  { kw: "twilightcouncil", rel: "buildings/twilightcouncil.png" },
  { kw: "twilight", rel: "buildings/twilightcouncil.png" },
  { kw: "roboticsfacility", rel: "buildings/roboticsfacility.png" },
  { kw: "robo", rel: "buildings/roboticsfacility.png" },
  { kw: "roboticsbay", rel: "buildings/roboticsbay.png" },
  { kw: "stargate", rel: "buildings/stargate.png" },
  { kw: "fleetbeacon", rel: "buildings/fleetbeacon.png" },
  { kw: "darkshrine", rel: "buildings/darkshrine.png" },
  { kw: "templararchive", rel: "buildings/templararchive.png" },
  { kw: "nexus", rel: "buildings/nexus.png" },
  { kw: "assimilator", rel: "buildings/assimilator.png" },
  { kw: "shieldbattery", rel: "buildings/shieldbattery.png" },
  { kw: "pylon", rel: "buildings/pylon.png" },
  { kw: "commandcenter", rel: "buildings/commandcenter.png" },
  { kw: "orbitalcommand", rel: "buildings/orbitalcommand.png" },
  { kw: "orbital", rel: "buildings/orbitalcommand.png" },
  { kw: "planetary", rel: "buildings/planetaryfortress.png" },
  { kw: "barracks", rel: "buildings/barracks.png" },
  { kw: "rax", rel: "buildings/barracks.png" },
  { kw: "factory", rel: "buildings/factory.png" },
  { kw: "starport", rel: "buildings/starport.png" },
  { kw: "engineeringbay", rel: "buildings/engineeringbay.png" },
  { kw: "armory", rel: "buildings/armory.png" },
  { kw: "fusioncore", rel: "buildings/fusioncore.png" },
  { kw: "ghostacademy", rel: "buildings/ghostacademy.png" },
  { kw: "missileturret", rel: "buildings/missileturret.png" },
  { kw: "turret", rel: "buildings/missileturret.png" },
  { kw: "bunker", rel: "buildings/bunker.png" },
  { kw: "refinery", rel: "buildings/refinery.png" },
  { kw: "supplydepot", rel: "buildings/supplydepot.png" },
  // Units — Zerg
  { kw: "zergling", rel: "units/zergling.png" },
  { kw: "speedling", rel: "units/zergling.png" },
  { kw: "ling", rel: "units/zergling.png" },
  { kw: "baneling", rel: "units/baneling.png" },
  { kw: "bane", rel: "units/baneling.png" },
  { kw: "queen", rel: "units/queen.png" },
  { kw: "roach", rel: "units/roach.png" },
  { kw: "ravager", rel: "units/ravager.png" },
  { kw: "overseer", rel: "units/overseer.png" },
  { kw: "hydralisk", rel: "units/hydralisk.png" },
  { kw: "hydra", rel: "units/hydralisk.png" },
  { kw: "lurker", rel: "units/lurker.png" },
  { kw: "mutalisk", rel: "units/mutalisk.png" },
  { kw: "muta", rel: "units/mutalisk.png" },
  { kw: "corruptor", rel: "units/corruptor.png" },
  { kw: "broodlord", rel: "units/broodlord.png" },
  { kw: "infestor", rel: "units/infestor.png" },
  { kw: "swarmhost", rel: "units/swarmhost.png" },
  { kw: "viper", rel: "units/viper.png" },
  { kw: "ultralisk", rel: "units/ultralisk.png" },
  { kw: "ultra", rel: "units/ultralisk.png" },
  // Units — Protoss
  { kw: "zealot", rel: "units/zealot.png" },
  { kw: "chargelot", rel: "units/zealot.png" },
  { kw: "stalker", rel: "units/stalker.png" },
  { kw: "sentry", rel: "units/sentry.png" },
  { kw: "adept", rel: "units/adept.png" },
  { kw: "hightemplar", rel: "units/hightemplar.png" },
  { kw: "high templar", rel: "units/hightemplar.png" },
  { kw: "darktemplar", rel: "units/darktemplar.png" },
  { kw: "dark templar", rel: "units/darktemplar.png" },
  { kw: "dt ", rel: "units/darktemplar.png" },
  { kw: "archon", rel: "units/archon.png" },
  { kw: "observer", rel: "units/observer.png" },
  { kw: "immortal", rel: "units/immortal.png" },
  { kw: "colossus", rel: "units/colossus.png" },
  { kw: "disruptor", rel: "units/disruptor.png" },
  { kw: "warpprism", rel: "units/warpprism.png" },
  { kw: "warp prism", rel: "units/warpprism.png" },
  { kw: "phoenix", rel: "units/phoenix.png" },
  { kw: "oracle", rel: "units/oracle.png" },
  { kw: "voidray", rel: "units/voidray.png" },
  { kw: "void ray", rel: "units/voidray.png" },
  { kw: "void", rel: "units/voidray.png" },
  { kw: "tempest", rel: "units/tempest.png" },
  { kw: "carrier", rel: "units/carrier.png" },
  { kw: "mothership", rel: "units/mothership.png" },
  // Units — Terran
  { kw: "marine", rel: "units/marine.png" },
  { kw: "marauder", rel: "units/marauder.png" },
  { kw: "reaper", rel: "units/reaper.png" },
  { kw: "ghost", rel: "units/ghost.png" },
  { kw: "hellion", rel: "units/hellion.png" },
  { kw: "hellbat", rel: "units/hellbat.png" },
  { kw: "widowmine", rel: "units/widowmine.png" },
  { kw: "widow mine", rel: "units/widowmine.png" },
  { kw: "mine", rel: "units/widowmine.png" },
  { kw: "siegetank", rel: "units/siegetank.png" },
  { kw: "siege tank", rel: "units/siegetank.png" },
  { kw: "tank", rel: "units/siegetank.png" },
  { kw: "cyclone", rel: "units/cyclone.png" },
  { kw: "thor", rel: "units/thor.png" },
  { kw: "viking", rel: "units/viking.png" },
  { kw: "medivac", rel: "units/medivac.png" },
  { kw: "liberator", rel: "units/liberator.png" },
  { kw: "banshee", rel: "units/banshee.png" },
  { kw: "raven", rel: "units/raven.png" },
  { kw: "battlecruiser", rel: "units/battlecruiser.png" },
  { kw: "bc ", rel: "units/battlecruiser.png" },
  // Upgrades
  { kw: "blink", rel: "upgrades/blink.png" },
  { kw: "charge", rel: "upgrades/charge.png" },
  { kw: "glaive", rel: "upgrades/glaive.png" },
  { kw: "speed", rel: "upgrades/speed.png" },
  { kw: "cloak", rel: "upgrades/cloak.png" },
  { kw: "stim", rel: "upgrades/stim.png" },
  { kw: "concussive", rel: "upgrades/concussive.png" },
  { kw: "combat shield", rel: "upgrades/combatshield.png" },
];

/** Up to `max` icon URLs for a strategy or build name. */
export function resolveStrategyIcons(strategyName: string, max = 3): string[] {
  if (!strategyName) return [];
  const explicit = STRATEGY_OVERRIDES[strategyName];
  if (explicit) {
    return explicit
      .filter((rel) => AVAILABLE_ICONS.has(rel))
      .slice(0, max)
      .map((rel) => `${ICON_BASE}/${rel}`);
  }
  const haystack = strategyName.toLowerCase();
  const seen = new Set<string>();
  const picked: string[] = [];
  for (const { kw, rel } of KEYWORDS) {
    if (haystack.indexOf(kw) === -1) continue;
    if (seen.has(rel)) continue;
    if (!AVAILABLE_ICONS.has(rel)) continue;
    seen.add(rel);
    picked.push(`${ICON_BASE}/${rel}`);
    if (picked.length >= max) break;
  }
  return picked;
}
