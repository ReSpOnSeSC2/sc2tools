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

/**
 * Canonical set of upgrade names emitted by sc2reader's
 * ``upgrade_type_name`` field. Mirrors
 * ``reveal-sc2-opponent-main/core/sc2_catalog.py`` (the agent's
 * source-of-truth). Used as the deterministic fallback for
 * ``parseBuildLogLines`` when the JSON catalog isn't loaded — without
 * it, every upgrade event was tagged ``category: "unknown"`` and the
 * downstream UI (Upgrades chip row, BuildOrderTimeline, Save as Build,
 * Custom Build Editor) all silently dropped upgrade events from their
 * filters keyed on ``category === "upgrade"``.
 */
const KNOWN_UPGRADE_NAMES = new Set([
  // Protoss
  "WarpGateResearch", "Charge", "BlinkTech",
  "AdeptPiercingAttack", "PsiStormTech", "DarkTemplarBlinkUpgrade",
  "ExtendedThermalLance", "GraviticDrive", "ObserverGraviticBooster",
  "PhoenixRangeUpgrade", "VoidRaySpeedUpgrade",
  "TempestGroundAttackUpgrade", "InterceptorGravitonCatapult",
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
  "Stimpack", "ShieldWall", "PunisherGrenades",
  "HiSecAutoTracking", "TerranBuildingArmor", "DrillClaws",
  "CycloneLockOnDamageUpgrade", "HighCapacityBarrels", "SmartServos",
  "BansheeCloak", "BansheeSpeed", "RavenCorvidReactor",
  "EnhancedShockwaves", "MedivacCaduceusReactor",
  "MedivacIncreaseSpeedBoost", "LiberatorAGRangeUpgrade",
  "YamatoCannon", "BattlecruiserEnableSpecializations",
  "PersonalCloaking", "MoebiusReactor",
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
  // Zerg
  "Burrow", "PneumatizedCarapace", "OverlordSpeed",
  "ZerglingMetabolicBoost", "ZerglingMovementSpeed",
  "ZerglingAdrenalGlands", "Zerglingattackspeed",
  "CentrifugalHooks", "CentrificalHooks",
  "GlialReconstitution", "TunnelingClaws",
  "EvolveMuscularAugments", "EvolveGroovedSpines",
  "LurkerRange", "DiggingClaws",
  "AnabolicSynthesis", "ChitinousPlating",
  "InfestorEnergyUpgrade", "NeuralParasite",
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
]);

/**
 * Patterns for the tiered weapons/armor/shields/carapace upgrades.
 * sc2reader emits multiple variants for the same in-game upgrade
 * depending on the replay's expansion / data version:
 *
 *   - Protoss armor: ``ProtossGroundArmorLevel1`` (LotV) AND
 *     ``ProtossGroundArmorsLevel1`` (HotS) — plural-s drifts in/out.
 *   - Terran armor: ``TerranInfantryArmorLevel1`` /
 *     ``TerranInfantryArmorsLevel1`` /
 *     ``TerranInfantryArmorsVanadiumPlatingLevel1`` (Mengsk co-op
 *     variant) and the equivalent ``UltraCapacitors`` weapons names.
 *   - Terran ship/vehicle armor: ``TerranVehicleArmorsLevel1``,
 *     ``TerranShipArmorsLevel1``, ``TerranVehicleAndShipArmorsLevel1``
 *     (HotS combined research), and the lowercase-and variant
 *     ``TerranVehicleandShipPlatingLevel1``. All four name the same
 *     in-game research in different patches.
 *   - Zerg attacks: ``ZergMeleeAttacksLevel1`` /
 *     ``ZergMeleeWeaponsLevel1`` for the same Hatchery research.
 *     Carapace likewise drifts: ``ZergGroundArmorsLevel1`` /
 *     ``ZergGroundCarapaceLevel1`` / ``ZergFlyerArmorsLevel1`` /
 *     ``ZergFlyerCarapaceLevel1``.
 *
 * The regex catches every variant the production replay corpus has
 * ever produced. Keep it broad: a future sc2reader naming tweak should
 * still tag through this fallback rather than slipping back into
 * ``category: "unknown"``.
 */
const UPGRADE_VARIANT_PATTERNS = [
  // Protoss ground / air / shields, Armor[s] variant.
  /^Protoss(Ground|Air)Armors?Level[1-3]$/,
  /^Protoss(Ground|Air)WeaponsLevel[1-3]$/,
  /^ProtossShieldsLevel[1-3]$/,
  // Terran infantry / vehicle / ship, with optional commander-mode
  // suffixes (VanadiumPlating, UltraCapacitors).
  /^Terran(Infantry|Vehicle|Ship)Armors?(?:VanadiumPlating)?Level[1-3]$/,
  /^Terran(Infantry|Vehicle|Ship)Weapons(?:UltraCapacitors)?Level[1-3]$/,
  // HotS combined Vehicle+Ship armor (two spellings — the older
  // "and" form uses a lowercase 'a' in some replay versions).
  /^TerranVehicle(And|and)ShipArmorsLevel[1-3]$/,
  /^TerranVehicle(And|and)ShipPlatingLevel[1-3]$/,
  // Zerg melee / missile attacks (or weapons), and the
  // armor/carapace variants for ground + flyer.
  /^Zerg(Melee|Missile|Flyer)(Attacks|Weapons)Level[1-3]$/,
  /^Zerg(Ground|Flyer)(Armors?|Carapace)Level[1-3]$/,
];

/**
 * @param {string | null | undefined} name
 * @returns {boolean}
 */
function isKnownUpgrade(name) {
  if (!name) return false;
  if (KNOWN_UPGRADE_NAMES.has(name)) return true;
  // Some replay versions emit the leading-cap form ("Zerglingattackspeed");
  // try a Pascal-Case fold of the first character for those edge cases.
  const recase = name.charAt(0).toUpperCase() + name.slice(1);
  if (recase !== name && KNOWN_UPGRADE_NAMES.has(recase)) return true;
  // Last resort: tiered weapons/armor/carapace patterns — these have
  // too many variants per upgrade (singular/plural Armor[s], LotV vs
  // HotS combined names, commander-mode suffixes) to enumerate
  // explicitly. The regex set catches every form the production
  // corpus has ever emitted and any near-future sc2reader naming
  // drift on the same families.
  for (const pat of UPGRADE_VARIANT_PATTERNS) {
    if (pat.test(name)) return true;
  }
  return false;
}

module.exports = {
  KNOWN_BUILDING_NAMES,
  isKnownBuilding,
  KNOWN_UPGRADE_NAMES,
  isKnownUpgrade,
};
