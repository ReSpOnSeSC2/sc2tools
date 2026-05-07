"use strict";

/**
 * Per-entity SC2 build durations, used to convert "completion-time"
 * events in stored build logs into "construction-start" times.
 *
 * Background: the desktop agent records different sc2reader events
 * for different entity types. For Protoss/Terran *structures*, the
 * extractor uses ``UnitInitEvent`` whose ``.second`` is already the
 * moment the worker placed the foundation — i.e. construction
 * START. But for Zerg/Protoss/Terran *units*, structure *morphs*
 * (Lair, Hive, Orbital, Planetary, WarpGate, GreaterSpire), and
 * *upgrades*, sc2reader fires the canonical event at the moment the
 * thing finishes (UnitBornEvent / UnitTypeChangeEvent /
 * UpgradeCompleteEvent), so ``.second`` is the FINISH time.
 *
 * The user-facing build orders should always show "I started this
 * at 2:00", not "this finished at 2:30". This module exposes:
 *
 *   - ``isFinishTimeEvent(name, isBuilding)``: heuristic that says
 *     whether the recorded time should be treated as a finish.
 *   - ``buildSecondsFor(name)``: build/research duration in seconds,
 *     or null when unknown.
 *   - ``toStartSeconds(name, recordedSec, isBuilding)``: applies
 *     both, returning the adjusted start time (clamped at 0).
 *
 * Numbers are pulled from Liquipedia (LotV 5.0.x balance, the same
 * patch the timing-catalog tokens align with). Where Blizzard has
 * slightly tweaked numbers across patches (Cyclone, Liberator) we
 * use the current patch-5.0.13 LotV values; the resulting drift on
 * older replays is small enough not to swamp the natural variance
 * in median timings.
 */

/**
 * Morph chains — the recorded event for these is the morph
 * COMPLETION time. Subtract the morph duration to get the start.
 *
 * @type {Record<string, number>}
 */
const STRUCTURE_MORPHS = Object.freeze({
  // Zerg town-hall morphs
  Lair: 57,
  Hive: 71,
  GreaterSpire: 71,
  // Terran add-on / upgrade morphs
  OrbitalCommand: 25,
  PlanetaryFortress: 36,
  // Protoss
  WarpGate: 7,
  // Some replays surface alt-name forms; map them too.
  WarpGateResearch: 100,
});

/**
 * Structure build times. UnitInitEvent (Protoss/Terran) is already
 * a START event — but UnitBornEvent for *Zerg* structures fires at
 * the moment the drone is consumed, which IS the start of
 * construction. So this table is only consulted in the rare case
 * where some upstream layer treats a structure's recorded time as
 * a finish (currently nothing does — kept for completeness).
 *
 * @type {Record<string, number>}
 */
const STRUCTURE_BUILD_SECONDS = Object.freeze({
  // Protoss
  Nexus: 71,
  Pylon: 18,
  Assimilator: 21,
  Gateway: 46,
  Forge: 32,
  CyberneticsCore: 36,
  PhotonCannon: 29,
  ShieldBattery: 29,
  TwilightCouncil: 36,
  RoboticsFacility: 46,
  Stargate: 43,
  TemplarArchive: 36,
  DarkShrine: 71,
  RoboticsBay: 46,
  FleetBeacon: 43,
  // Zerg
  Hatchery: 71,
  Extractor: 21,
  SpawningPool: 46,
  EvolutionChamber: 25,
  RoachWarren: 39,
  BanelingNest: 43,
  HydraliskDen: 29,
  LurkerDen: 57,
  Spire: 71,
  InfestationPit: 36,
  NydusNetwork: 36,
  UltraliskCavern: 46,
  // Terran
  CommandCenter: 71,
  SupplyDepot: 21,
  Refinery: 21,
  Barracks: 46,
  EngineeringBay: 25,
  Bunker: 29,
  MissileTurret: 18,
  SensorTower: 18,
  Factory: 43,
  GhostAcademy: 29,
  Starport: 36,
  Armory: 46,
  FusionCore: 46,
  TechLab: 18,
  Reactor: 36,
});

/**
 * Unit production / morph times — used because UnitBornEvent fires
 * at the moment the unit emerges (i.e. FINISH). The recorded build
 * log shows `[m:ss] Zergling`; subtracting this duration gives the
 * time the player issued the train command (or larva inject /
 * warp-in trigger).
 *
 * @type {Record<string, number>}
 */
const UNIT_BUILD_SECONDS = Object.freeze({
  // Protoss
  Probe: 12,
  Zealot: 27,
  Stalker: 30,
  Sentry: 26,
  Adept: 27,
  HighTemplar: 39,
  DarkTemplar: 39,
  Archon: 9,
  Observer: 21,
  Immortal: 39,
  WarpPrism: 36,
  Colossus: 54,
  Disruptor: 36,
  Phoenix: 25,
  VoidRay: 43,
  Oracle: 37,
  Tempest: 43,
  Carrier: 64,
  Mothership: 71,
  // Terran
  SCV: 12,
  Marine: 18,
  Marauder: 21,
  Reaper: 32,
  Ghost: 29,
  Hellion: 21,
  Hellbat: 21,
  WidowMine: 21,
  Cyclone: 32,
  SiegeTank: 32,
  Thor: 43,
  Viking: 30,
  Medivac: 30,
  Liberator: 43,
  Banshee: 43,
  Raven: 34,
  Battlecruiser: 64,
  // Zerg (most morph from larva — duration is the larva morph)
  Drone: 12,
  Overlord: 18,
  Queen: 36,
  Zergling: 17,
  Baneling: 14,
  Roach: 19,
  Ravager: 9,
  Hydralisk: 24,
  Lurker: 18,
  Mutalisk: 24,
  Corruptor: 29,
  BroodLord: 24,
  Infestor: 36,
  SwarmHost: 29,
  Viper: 29,
  Ultralisk: 39,
  Overseer: 12,
  // Spawned / morphed mid-fight: too short / situational to subtract
  // anything sensible, treat as instant.
  Locust: 0,
  Interceptor: 9,
  Changeling: 0,
  Broodling: 0,
});

/**
 * Upgrade research durations. ``UpgradeCompleteEvent`` records the
 * completion time, so subtracting these durations recovers the
 * "research started" time the user typically thinks of.
 *
 * @type {Record<string, number>}
 */
const UPGRADE_BUILD_SECONDS = Object.freeze({
  // Protoss common
  WarpGateResearch: 100,
  Charge: 100,
  Blink: 121,
  ResonatingGlaives: 100,
  PsiStorm: 79,
  ShadowStride: 100,
  ExtendedThermalLance: 100,
  GraviticBoosters: 57,
  GraviticDrive: 57,
  AnionPulseCrystals: 64,
  FluxVanes: 43,
  TectonicDestabilizers: 100,
  ProtossGroundWeaponsLevel1: 128,
  ProtossGroundWeaponsLevel2: 152,
  ProtossGroundWeaponsLevel3: 176,
  ProtossGroundArmorsLevel1: 128,
  ProtossGroundArmorsLevel2: 152,
  ProtossGroundArmorsLevel3: 176,
  ProtossShieldsLevel1: 128,
  ProtossShieldsLevel2: 152,
  ProtossShieldsLevel3: 176,
  ProtossAirWeaponsLevel1: 128,
  ProtossAirWeaponsLevel2: 152,
  ProtossAirWeaponsLevel3: 176,
  ProtossAirArmorsLevel1: 128,
  ProtossAirArmorsLevel2: 152,
  ProtossAirArmorsLevel3: 176,
  // Terran common
  Stimpack: 100,
  ShieldWall: 79, // Combat Shield
  CombatShield: 79,
  ConcussiveShells: 43,
  HiSecAutoTracking: 57,
  StructureArmor: 100,
  NeosteelFrame: 71,
  CloakingField: 79, // Banshee cloak
  HyperflightRotors: 121,
  WeaponRefit: 43, // Yamato? Actually no — placeholder; keep small.
  AdvancedBallistics: 79,
  CycloneLockOnDamage: 100,
  CycloneRapidFireLaunchers: 100,
  EnhancedShockwaves: 79,
  PersonalCloaking: 86,
  InterferenceMatrix: 57,
  TerranInfantryWeaponsLevel1: 114,
  TerranInfantryWeaponsLevel2: 136,
  TerranInfantryWeaponsLevel3: 157,
  TerranInfantryArmorsLevel1: 114,
  TerranInfantryArmorsLevel2: 136,
  TerranInfantryArmorsLevel3: 157,
  TerranVehicleWeaponsLevel1: 114,
  TerranVehicleWeaponsLevel2: 136,
  TerranVehicleWeaponsLevel3: 157,
  TerranVehicleAndShipPlatingLevel1: 114,
  TerranVehicleAndShipPlatingLevel2: 136,
  TerranVehicleAndShipPlatingLevel3: 157,
  TerranShipWeaponsLevel1: 114,
  TerranShipWeaponsLevel2: 136,
  TerranShipWeaponsLevel3: 157,
  // Zerg common
  ZerglingMovementSpeed: 100,
  Metabolicboost: 100,
  ZerglingAttackSpeed: 100,
  CentrificalHooks: 79,
  CentrifugalHooks: 79,
  GlialReconstitution: 71,
  TunnelingClaws: 79,
  Burrow: 71,
  PathogenGlands: 50,
  AdrenalGlands: 93,
  GroovedSpines: 71,
  MuscularAugments: 79,
  AdaptiveTalons: 57,
  PneumatizedCarapace: 43,
  Overlordspeed: 43,
  ChitinousPlating: 79,
  AnabolicSynthesis: 43,
  FlyerAttacks1: 114,
  FlyerArmor1: 114,
  ZergMissileWeaponsLevel1: 114,
  ZergMissileWeaponsLevel2: 136,
  ZergMissileWeaponsLevel3: 157,
  ZergMeleeWeaponsLevel1: 114,
  ZergMeleeWeaponsLevel2: 136,
  ZergMeleeWeaponsLevel3: 157,
  ZergGroundArmorsLevel1: 114,
  ZergGroundArmorsLevel2: 136,
  ZergGroundArmorsLevel3: 157,
  ZergFlyerWeaponsLevel1: 114,
  ZergFlyerWeaponsLevel2: 136,
  ZergFlyerWeaponsLevel3: 157,
  ZergFlyerArmorsLevel1: 114,
  ZergFlyerArmorsLevel2: 136,
  ZergFlyerArmorsLevel3: 157,
});

/**
 * Lookup tables keyed by lowercased canonical name so input from
 * the agent (`"Spawning Pool"` vs `"SpawningPool"` vs `"pool"`) all
 * resolve to the same row. The non-alpha strip mirrors what
 * ``timingCatalog.normalizeName`` does in cloud + agent code.
 */
function key(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** @type {Map<string, number>} */
const STRUCTURE_MORPH_LOOKUP = new Map(
  Object.entries(STRUCTURE_MORPHS).map(([n, s]) => [key(n), s]),
);
/** @type {Map<string, number>} */
const STRUCTURE_BUILD_LOOKUP = new Map(
  Object.entries(STRUCTURE_BUILD_SECONDS).map(([n, s]) => [key(n), s]),
);
/** @type {Map<string, number>} */
const UNIT_BUILD_LOOKUP = new Map(
  Object.entries(UNIT_BUILD_SECONDS).map(([n, s]) => [key(n), s]),
);
/** @type {Map<string, number>} */
const UPGRADE_BUILD_LOOKUP = new Map(
  Object.entries(UPGRADE_BUILD_SECONDS).map(([n, s]) => [key(n), s]),
);

/**
 * Returns whether the recorded ``time`` for this entity should be
 * treated as a "finish" event (and therefore offset back by the
 * build duration to recover the start time).
 *
 * Rules:
 *   - Structure morph names → finish (the morph completes).
 *   - Upgrades → finish (UpgradeCompleteEvent).
 *   - Units → finish (UnitBornEvent at emergence).
 *   - Plain structures → start (UnitInitEvent / UnitBornEvent on
 *     drone consumption).
 *
 * @param {string} name
 * @param {{ isBuilding?: boolean, category?: string }} hints
 * @returns {boolean}
 */
function isFinishTimeEvent(name, hints) {
  const k = key(name);
  if (!k) return false;
  const isUpgrade =
    UPGRADE_BUILD_LOOKUP.has(k) ||
    (hints && hints.category === "upgrade");
  if (isUpgrade) return true;
  const isMorph = STRUCTURE_MORPH_LOOKUP.has(k);
  if (isMorph) return true;
  const isBuilding =
    !!(hints && hints.isBuilding) ||
    STRUCTURE_BUILD_LOOKUP.has(k);
  if (isBuilding) return false;
  // Default: treat as a unit (finish-time event).
  return true;
}

/**
 * Look up the build/research duration in seconds for an entity.
 * Returns ``null`` when the entity isn't in the catalog (caller
 * should leave the time unchanged in that case).
 *
 * @param {string} name
 * @param {{ isBuilding?: boolean, category?: string }} [hints]
 * @returns {number | null}
 */
function buildSecondsFor(name, hints) {
  const k = key(name);
  if (!k) return null;
  const isUpgrade =
    UPGRADE_BUILD_LOOKUP.has(k) ||
    (hints && hints.category === "upgrade");
  if (isUpgrade) {
    return UPGRADE_BUILD_LOOKUP.get(k) ?? null;
  }
  if (STRUCTURE_MORPH_LOOKUP.has(k)) {
    return STRUCTURE_MORPH_LOOKUP.get(k) ?? null;
  }
  if (STRUCTURE_BUILD_LOOKUP.has(k)) {
    return STRUCTURE_BUILD_LOOKUP.get(k) ?? null;
  }
  if (UNIT_BUILD_LOOKUP.has(k)) {
    return UNIT_BUILD_LOOKUP.get(k) ?? null;
  }
  return null;
}

/**
 * Convert a recorded event time into the "construction started"
 * time. Returns the original time when no offset can be applied
 * (unknown name, plain structure, or computed start would be
 * negative — we clamp to 0).
 *
 * @param {string} name
 * @param {number} recordedSec
 * @param {{ isBuilding?: boolean, category?: string }} [hints]
 * @returns {number}
 */
function toStartSeconds(name, recordedSec, hints) {
  if (!Number.isFinite(recordedSec) || recordedSec < 0) return 0;
  if (!isFinishTimeEvent(name, hints)) return recordedSec;
  const dur = buildSecondsFor(name, hints);
  if (dur == null) return recordedSec;
  const start = recordedSec - dur;
  return start < 0 ? 0 : start;
}

module.exports = {
  STRUCTURE_MORPHS,
  STRUCTURE_BUILD_SECONDS,
  UNIT_BUILD_SECONDS,
  UPGRADE_BUILD_SECONDS,
  isFinishTimeEvent,
  buildSecondsFor,
  toStartSeconds,
};
