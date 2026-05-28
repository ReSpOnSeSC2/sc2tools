"""Comprehensive SC2 unit / building / upgrade catalog.

This module is the single source of truth for every entity the analyzer
knows about. It's used by:

  * `core.event_extractor` - to whitelist real units/buildings (already had
    a partial list; this catalog supersedes it).
  * `detectors.opponent` - to derive composition-based fallback strategy
    names so games never show "Unclassified".
  * `ui.visualizer` - to render the build-order timeline with consistent
    display names + race + category badges.
  * The browser app - via a JS twin (`stream-overlay-backend/sc2_catalog.js`)
    that mirrors this file by hand. Keep them in sync when adding entities.

Each entry is keyed by the *canonical sc2reader name* (matched against
`event.unit_type_name` after `_clean_building_name` strips the race prefix
and Lower/Upper suffix). The value is a `CatalogEntry` with display name,
race, category, tier (for sort), and optional production-source.

Coverage target: every army unit, building, ability spawn, and meaningful
upgrade in Legacy of the Void as of 2025-2026 (including Hellbat, Liberator,
Cyclone, Disruptor, Adept, Lurker, Ravager, etc.).
"""

from dataclasses import dataclass
from typing import Dict, List, Optional, Set


# Categories control how the timeline UI groups + colors the entry.
CATEGORY_TOWNHALL = "townhall"
CATEGORY_BUILDER = "builder"          # production / tech-enabling structure
CATEGORY_DEFENSE = "defense"          # static defense
CATEGORY_SUPPLY = "supply"            # supply / overlord-generating
CATEGORY_TECH = "tech"                # tech lab / armory / etc.
CATEGORY_WORKER = "worker"
CATEGORY_ARMY = "army"
CATEGORY_CASTER = "caster"
CATEGORY_AIR = "air"
CATEGORY_DETECTOR = "detector"
CATEGORY_TRANSPORT = "transport"
CATEGORY_HERO = "hero"                # mothership, etc.
CATEGORY_SPAWN = "spawn"              # locust / interceptor / changeling
CATEGORY_UPGRADE = "upgrade"


@dataclass(frozen=True)
class CatalogEntry:
    name: str           # canonical key (sc2reader-cleaned name)
    display: str        # human-readable label
    race: str           # 'Protoss' | 'Terran' | 'Zerg' | 'Neutral'
    category: str       # one of CATEGORY_*
    tier: int           # 1 = T1 (gateway tech), 2 = T2, 3 = T3 (capital ships)
    is_building: bool   # True for structures
    composition_tag: Optional[str] = None  # e.g. 'bio', 'mech', 'sky', 'roach'


# -----------------------------------------------------------------------------
# PROTOSS
# -----------------------------------------------------------------------------
PROTOSS_ENTRIES: List[CatalogEntry] = [
    # Buildings
    CatalogEntry("Nexus", "Nexus", "Protoss", CATEGORY_TOWNHALL, 1, True),
    CatalogEntry("Pylon", "Pylon", "Protoss", CATEGORY_SUPPLY, 1, True),
    CatalogEntry("Assimilator", "Assimilator", "Protoss", CATEGORY_BUILDER, 1, True),
    CatalogEntry("Gateway", "Gateway", "Protoss", CATEGORY_BUILDER, 1, True),
    CatalogEntry("WarpGate", "Warp Gate", "Protoss", CATEGORY_BUILDER, 1, True),
    CatalogEntry("Forge", "Forge", "Protoss", CATEGORY_TECH, 1, True),
    CatalogEntry("PhotonCannon", "Photon Cannon", "Protoss", CATEGORY_DEFENSE, 1, True),
    CatalogEntry("ShieldBattery", "Shield Battery", "Protoss", CATEGORY_DEFENSE, 1, True),
    CatalogEntry("CyberneticsCore", "Cybernetics Core", "Protoss", CATEGORY_TECH, 1, True),
    CatalogEntry("TwilightCouncil", "Twilight Council", "Protoss", CATEGORY_TECH, 2, True),
    CatalogEntry("RoboticsFacility", "Robotics Facility", "Protoss", CATEGORY_BUILDER, 2, True),
    CatalogEntry("RoboticsBay", "Robotics Bay", "Protoss", CATEGORY_TECH, 3, True),
    CatalogEntry("Stargate", "Stargate", "Protoss", CATEGORY_BUILDER, 2, True),
    CatalogEntry("FleetBeacon", "Fleet Beacon", "Protoss", CATEGORY_TECH, 3, True),
    CatalogEntry("TemplarArchive", "Templar Archives", "Protoss", CATEGORY_TECH, 2, True),
    CatalogEntry("DarkShrine", "Dark Shrine", "Protoss", CATEGORY_TECH, 2, True),
    # Units
    CatalogEntry("Probe", "Probe", "Protoss", CATEGORY_WORKER, 1, False),
    CatalogEntry("Zealot", "Zealot", "Protoss", CATEGORY_ARMY, 1, False, "gateway"),
    CatalogEntry("Stalker", "Stalker", "Protoss", CATEGORY_ARMY, 1, False, "gateway"),
    CatalogEntry("Sentry", "Sentry", "Protoss", CATEGORY_CASTER, 1, False, "gateway"),
    CatalogEntry("Adept", "Adept", "Protoss", CATEGORY_ARMY, 1, False, "gateway"),
    CatalogEntry("HighTemplar", "High Templar", "Protoss", CATEGORY_CASTER, 2, False, "templar"),
    CatalogEntry("DarkTemplar", "Dark Templar", "Protoss", CATEGORY_ARMY, 2, False, "dt"),
    CatalogEntry("Archon", "Archon", "Protoss", CATEGORY_ARMY, 2, False, "templar"),
    CatalogEntry("Observer", "Observer", "Protoss", CATEGORY_DETECTOR, 1, False, "robo"),
    CatalogEntry("ObserverSiegeMode", "Surveillance Mode", "Protoss", CATEGORY_DETECTOR, 1, False, "robo"),
    CatalogEntry("WarpPrism", "Warp Prism", "Protoss", CATEGORY_TRANSPORT, 1, False, "robo"),
    CatalogEntry("WarpPrismPhasing", "Warp Prism (Phasing)", "Protoss", CATEGORY_TRANSPORT, 1, False, "robo"),
    CatalogEntry("Immortal", "Immortal", "Protoss", CATEGORY_ARMY, 2, False, "robo"),
    CatalogEntry("Colossus", "Colossus", "Protoss", CATEGORY_ARMY, 3, False, "robo"),
    CatalogEntry("Disruptor", "Disruptor", "Protoss", CATEGORY_ARMY, 3, False, "robo"),
    CatalogEntry("Phoenix", "Phoenix", "Protoss", CATEGORY_AIR, 1, False, "sky"),
    CatalogEntry("VoidRay", "Void Ray", "Protoss", CATEGORY_AIR, 2, False, "sky"),
    CatalogEntry("Oracle", "Oracle", "Protoss", CATEGORY_CASTER, 1, False, "sky"),
    CatalogEntry("Tempest", "Tempest", "Protoss", CATEGORY_AIR, 3, False, "sky"),
    CatalogEntry("Carrier", "Carrier", "Protoss", CATEGORY_AIR, 3, False, "sky"),
    CatalogEntry("Mothership", "Mothership", "Protoss", CATEGORY_HERO, 3, False, "sky"),
    CatalogEntry("MothershipCore", "Mothership Core", "Protoss", CATEGORY_HERO, 1, False, "sky"),
    # Ability-spawned / tracked separately
    CatalogEntry("Interceptor", "Interceptor", "Protoss", CATEGORY_SPAWN, 3, False, "sky"),
    CatalogEntry("AdeptPhaseShift", "Adept Phase Shift", "Protoss", CATEGORY_SPAWN, 1, False, "gateway"),
]

PROTOSS_UPGRADES: List[CatalogEntry] = [
    CatalogEntry("WarpGateResearch", "Warp Gate Research", "Protoss", CATEGORY_UPGRADE, 1, False),
    CatalogEntry("Charge", "Charge", "Protoss", CATEGORY_UPGRADE, 2, False, "gateway"),
    CatalogEntry("BlinkTech", "Blink", "Protoss", CATEGORY_UPGRADE, 2, False, "gateway"),
    CatalogEntry("AdeptPiercingAttack", "Resonating Glaives", "Protoss", CATEGORY_UPGRADE, 2, False, "gateway"),
    CatalogEntry("PsiStormTech", "Psionic Storm", "Protoss", CATEGORY_UPGRADE, 2, False, "templar"),
    CatalogEntry("DarkTemplarBlinkUpgrade", "Shadow Stride", "Protoss", CATEGORY_UPGRADE, 2, False, "dt"),
    CatalogEntry("ExtendedThermalLance", "Extended Thermal Lance", "Protoss", CATEGORY_UPGRADE, 3, False, "robo"),
    CatalogEntry("GraviticDrive", "Gravitic Drive", "Protoss", CATEGORY_UPGRADE, 2, False, "robo"),
    CatalogEntry("ObserverGraviticBooster", "Gravitic Boosters", "Protoss", CATEGORY_UPGRADE, 1, False, "robo"),
    CatalogEntry("PhoenixRangeUpgrade", "Anion Pulse-Crystals", "Protoss", CATEGORY_UPGRADE, 2, False, "sky"),
    CatalogEntry("VoidRaySpeedUpgrade", "Flux Vanes", "Protoss", CATEGORY_UPGRADE, 2, False, "sky"),
    CatalogEntry("TempestGroundAttackUpgrade", "Tectonic Destabilizers", "Protoss", CATEGORY_UPGRADE, 3, False, "sky"),
    CatalogEntry("InterceptorGravitonCatapult", "Graviton Catapult", "Protoss", CATEGORY_UPGRADE, 3, False, "sky"),
    CatalogEntry("ProtossGroundWeaponsLevel1", "Ground Weapons +1", "Protoss", CATEGORY_UPGRADE, 1, False),
    CatalogEntry("ProtossGroundWeaponsLevel2", "Ground Weapons +2", "Protoss", CATEGORY_UPGRADE, 2, False),
    CatalogEntry("ProtossGroundWeaponsLevel3", "Ground Weapons +3", "Protoss", CATEGORY_UPGRADE, 3, False),
    CatalogEntry("ProtossGroundArmorsLevel1", "Ground Armor +1", "Protoss", CATEGORY_UPGRADE, 1, False),
    CatalogEntry("ProtossGroundArmorsLevel2", "Ground Armor +2", "Protoss", CATEGORY_UPGRADE, 2, False),
    CatalogEntry("ProtossGroundArmorsLevel3", "Ground Armor +3", "Protoss", CATEGORY_UPGRADE, 3, False),
    CatalogEntry("ProtossShieldsLevel1", "Shields +1", "Protoss", CATEGORY_UPGRADE, 1, False),
    CatalogEntry("ProtossShieldsLevel2", "Shields +2", "Protoss", CATEGORY_UPGRADE, 2, False),
    CatalogEntry("ProtossShieldsLevel3", "Shields +3", "Protoss", CATEGORY_UPGRADE, 3, False),
    CatalogEntry("ProtossAirWeaponsLevel1", "Air Weapons +1", "Protoss", CATEGORY_UPGRADE, 1, False),
    CatalogEntry("ProtossAirWeaponsLevel2", "Air Weapons +2", "Protoss", CATEGORY_UPGRADE, 2, False),
    CatalogEntry("ProtossAirWeaponsLevel3", "Air Weapons +3", "Protoss", CATEGORY_UPGRADE, 3, False),
    CatalogEntry("ProtossAirArmorsLevel1", "Air Armor +1", "Protoss", CATEGORY_UPGRADE, 1, False),
    CatalogEntry("ProtossAirArmorsLevel2", "Air Armor +2", "Protoss", CATEGORY_UPGRADE, 2, False),
    CatalogEntry("ProtossAirArmorsLevel3", "Air Armor +3", "Protoss", CATEGORY_UPGRADE, 3, False),
]

# -----------------------------------------------------------------------------
# TERRAN
# -----------------------------------------------------------------------------
TERRAN_ENTRIES: List[CatalogEntry] = [
    # Buildings
    CatalogEntry("CommandCenter", "Command Center", "Terran", CATEGORY_TOWNHALL, 1, True),
    CatalogEntry("OrbitalCommand", "Orbital Command", "Terran", CATEGORY_TOWNHALL, 1, True),
    CatalogEntry("PlanetaryFortress", "Planetary Fortress", "Terran", CATEGORY_TOWNHALL, 2, True),
    CatalogEntry("CommandCenterFlying", "Command Center (Lifted)", "Terran", CATEGORY_TOWNHALL, 1, True),
    CatalogEntry("OrbitalCommandFlying", "Orbital Command (Lifted)", "Terran", CATEGORY_TOWNHALL, 1, True),
    CatalogEntry("SupplyDepot", "Supply Depot", "Terran", CATEGORY_SUPPLY, 1, True),
    CatalogEntry("SupplyDepotLowered", "Supply Depot (Lowered)", "Terran", CATEGORY_SUPPLY, 1, True),
    CatalogEntry("Refinery", "Refinery", "Terran", CATEGORY_BUILDER, 1, True),
    CatalogEntry("Barracks", "Barracks", "Terran", CATEGORY_BUILDER, 1, True),
    CatalogEntry("BarracksFlying", "Barracks (Lifted)", "Terran", CATEGORY_BUILDER, 1, True),
    CatalogEntry("BarracksTechLab", "Barracks Tech Lab", "Terran", CATEGORY_TECH, 1, True),
    CatalogEntry("BarracksReactor", "Barracks Reactor", "Terran", CATEGORY_TECH, 1, True),
    CatalogEntry("EngineeringBay", "Engineering Bay", "Terran", CATEGORY_TECH, 1, True),
    CatalogEntry("Bunker", "Bunker", "Terran", CATEGORY_DEFENSE, 1, True),
    CatalogEntry("MissileTurret", "Missile Turret", "Terran", CATEGORY_DEFENSE, 1, True),
    CatalogEntry("SensorTower", "Sensor Tower", "Terran", CATEGORY_DETECTOR, 2, True),
    CatalogEntry("GhostAcademy", "Ghost Academy", "Terran", CATEGORY_TECH, 2, True),
    CatalogEntry("Factory", "Factory", "Terran", CATEGORY_BUILDER, 2, True),
    CatalogEntry("FactoryFlying", "Factory (Lifted)", "Terran", CATEGORY_BUILDER, 2, True),
    CatalogEntry("FactoryTechLab", "Factory Tech Lab", "Terran", CATEGORY_TECH, 2, True),
    CatalogEntry("FactoryReactor", "Factory Reactor", "Terran", CATEGORY_TECH, 2, True),
    CatalogEntry("Armory", "Armory", "Terran", CATEGORY_TECH, 2, True),
    CatalogEntry("Starport", "Starport", "Terran", CATEGORY_BUILDER, 2, True),
    CatalogEntry("StarportFlying", "Starport (Lifted)", "Terran", CATEGORY_BUILDER, 2, True),
    CatalogEntry("StarportTechLab", "Starport Tech Lab", "Terran", CATEGORY_TECH, 2, True),
    CatalogEntry("StarportReactor", "Starport Reactor", "Terran", CATEGORY_TECH, 2, True),
    CatalogEntry("FusionCore", "Fusion Core", "Terran", CATEGORY_TECH, 3, True),
    CatalogEntry("TechLab", "Tech Lab", "Terran", CATEGORY_TECH, 1, True),
    CatalogEntry("Reactor", "Reactor", "Terran", CATEGORY_TECH, 1, True),
    # Units
    CatalogEntry("SCV", "SCV", "Terran", CATEGORY_WORKER, 1, False),
    CatalogEntry("MULE", "MULE", "Terran", CATEGORY_SPAWN, 1, False),
    CatalogEntry("Marine", "Marine", "Terran", CATEGORY_ARMY, 1, False, "bio"),
    CatalogEntry("Marauder", "Marauder", "Terran", CATEGORY_ARMY, 1, False, "bio"),
    CatalogEntry("Reaper", "Reaper", "Terran", CATEGORY_ARMY, 1, False, "bio"),
    CatalogEntry("Ghost", "Ghost", "Terran", CATEGORY_CASTER, 2, False, "bio"),
    CatalogEntry("Hellion", "Hellion", "Terran", CATEGORY_ARMY, 2, False, "mech"),
    CatalogEntry("HellionTank", "Hellbat", "Terran", CATEGORY_ARMY, 2, False, "mech"),
    CatalogEntry("Hellbat", "Hellbat", "Terran", CATEGORY_ARMY, 2, False, "mech"),
    CatalogEntry("WidowMine", "Widow Mine", "Terran", CATEGORY_ARMY, 2, False, "mech"),
    CatalogEntry("WidowMineBurrowed", "Widow Mine (Burrowed)", "Terran", CATEGORY_ARMY, 2, False, "mech"),
    CatalogEntry("SiegeTank", "Siege Tank", "Terran", CATEGORY_ARMY, 2, False, "mech"),
    CatalogEntry("SiegeTankSieged", "Siege Tank (Sieged)", "Terran", CATEGORY_ARMY, 2, False, "mech"),
    CatalogEntry("Cyclone", "Cyclone", "Terran", CATEGORY_ARMY, 2, False, "mech"),
    CatalogEntry("Thor", "Thor", "Terran", CATEGORY_ARMY, 3, False, "mech"),
    CatalogEntry("ThorAP", "Thor (High Impact)", "Terran", CATEGORY_ARMY, 3, False, "mech"),
    CatalogEntry("VikingFighter", "Viking", "Terran", CATEGORY_AIR, 2, False, "sky"),
    CatalogEntry("VikingAssault", "Viking (Landed)", "Terran", CATEGORY_AIR, 2, False, "sky"),
    CatalogEntry("Medivac", "Medivac", "Terran", CATEGORY_TRANSPORT, 2, False, "bio"),
    CatalogEntry("Liberator", "Liberator", "Terran", CATEGORY_AIR, 2, False, "sky"),
    CatalogEntry("LiberatorAG", "Liberator (Defender)", "Terran", CATEGORY_AIR, 2, False, "sky"),
    CatalogEntry("Banshee", "Banshee", "Terran", CATEGORY_AIR, 2, False, "sky"),
    CatalogEntry("Raven", "Raven", "Terran", CATEGORY_DETECTOR, 2, False, "sky"),
    CatalogEntry("Battlecruiser", "Battlecruiser", "Terran", CATEGORY_AIR, 3, False, "sky"),
    CatalogEntry("AutoTurret", "Auto Turret", "Terran", CATEGORY_SPAWN, 2, False, "sky"),
    CatalogEntry("PointDefenseDrone", "Point Defense Drone", "Terran", CATEGORY_SPAWN, 2, False, "sky"),
]

TERRAN_UPGRADES: List[CatalogEntry] = [
    CatalogEntry("Stimpack", "Stimpack", "Terran", CATEGORY_UPGRADE, 1, False, "bio"),
    CatalogEntry("ShieldWall", "Combat Shield", "Terran", CATEGORY_UPGRADE, 1, False, "bio"),
    CatalogEntry("PunisherGrenades", "Concussive Shells", "Terran", CATEGORY_UPGRADE, 1, False, "bio"),
    CatalogEntry("HiSecAutoTracking", "Hi-Sec Auto Tracking", "Terran", CATEGORY_UPGRADE, 1, False),
    CatalogEntry("TerranBuildingArmor", "Neosteel Armor", "Terran", CATEGORY_UPGRADE, 1, False),
    CatalogEntry("DrillClaws", "Drilling Claws", "Terran", CATEGORY_UPGRADE, 2, False, "mech"),
    CatalogEntry("CycloneLockOnDamageUpgrade", "Mag-Field Accelerator", "Terran", CATEGORY_UPGRADE, 2, False, "mech"),
    CatalogEntry("HighCapacityBarrels", "Infernal Pre-Igniter", "Terran", CATEGORY_UPGRADE, 2, False, "mech"),
    CatalogEntry("SmartServos", "Smart Servos", "Terran", CATEGORY_UPGRADE, 2, False, "mech"),
    CatalogEntry("BansheeCloak", "Cloaking Field", "Terran", CATEGORY_UPGRADE, 2, False, "sky"),
    CatalogEntry("BansheeSpeed", "Hyperflight Rotors", "Terran", CATEGORY_UPGRADE, 2, False, "sky"),
    CatalogEntry("RavenCorvidReactor", "Corvid Reactor", "Terran", CATEGORY_UPGRADE, 2, False, "sky"),
    CatalogEntry("EnhancedShockwaves", "Enhanced Shockwaves", "Terran", CATEGORY_UPGRADE, 2, False, "bio"),
    CatalogEntry("MedivacCaduceusReactor", "Caduceus Reactor", "Terran", CATEGORY_UPGRADE, 2, False, "bio"),
    CatalogEntry("MedivacIncreaseSpeedBoost", "Rapid Reignition", "Terran", CATEGORY_UPGRADE, 2, False, "bio"),
    CatalogEntry("LiberatorAGRangeUpgrade", "Advanced Ballistics", "Terran", CATEGORY_UPGRADE, 2, False, "sky"),
    CatalogEntry("YamatoCannon", "Yamato Cannon", "Terran", CATEGORY_UPGRADE, 3, False, "sky"),
    CatalogEntry("BattlecruiserEnableSpecializations", "Weapon Refit", "Terran", CATEGORY_UPGRADE, 3, False, "sky"),
    CatalogEntry("PersonalCloaking", "Personal Cloaking", "Terran", CATEGORY_UPGRADE, 2, False, "bio"),
    CatalogEntry("MoebiusReactor", "Moebius Reactor", "Terran", CATEGORY_UPGRADE, 2, False, "bio"),
    CatalogEntry("TerranInfantryWeaponsLevel1", "Infantry Weapons +1", "Terran", CATEGORY_UPGRADE, 1, False, "bio"),
    CatalogEntry("TerranInfantryWeaponsLevel2", "Infantry Weapons +2", "Terran", CATEGORY_UPGRADE, 2, False, "bio"),
    CatalogEntry("TerranInfantryWeaponsLevel3", "Infantry Weapons +3", "Terran", CATEGORY_UPGRADE, 3, False, "bio"),
    CatalogEntry("TerranInfantryArmorsLevel1", "Infantry Armor +1", "Terran", CATEGORY_UPGRADE, 1, False, "bio"),
    CatalogEntry("TerranInfantryArmorsLevel2", "Infantry Armor +2", "Terran", CATEGORY_UPGRADE, 2, False, "bio"),
    CatalogEntry("TerranInfantryArmorsLevel3", "Infantry Armor +3", "Terran", CATEGORY_UPGRADE, 3, False, "bio"),
    CatalogEntry("TerranVehicleWeaponsLevel1", "Vehicle Weapons +1", "Terran", CATEGORY_UPGRADE, 1, False, "mech"),
    CatalogEntry("TerranVehicleWeaponsLevel2", "Vehicle Weapons +2", "Terran", CATEGORY_UPGRADE, 2, False, "mech"),
    CatalogEntry("TerranVehicleWeaponsLevel3", "Vehicle Weapons +3", "Terran", CATEGORY_UPGRADE, 3, False, "mech"),
    CatalogEntry("TerranVehicleAndShipArmorsLevel1", "Vehicle/Ship Armor +1", "Terran", CATEGORY_UPGRADE, 1, False, "mech"),
    CatalogEntry("TerranVehicleAndShipArmorsLevel2", "Vehicle/Ship Armor +2", "Terran", CATEGORY_UPGRADE, 2, False, "mech"),
    CatalogEntry("TerranVehicleAndShipArmorsLevel3", "Vehicle/Ship Armor +3", "Terran", CATEGORY_UPGRADE, 3, False, "mech"),
    CatalogEntry("TerranShipWeaponsLevel1", "Ship Weapons +1", "Terran", CATEGORY_UPGRADE, 1, False, "sky"),
    CatalogEntry("TerranShipWeaponsLevel2", "Ship Weapons +2", "Terran", CATEGORY_UPGRADE, 2, False, "sky"),
    CatalogEntry("TerranShipWeaponsLevel3", "Ship Weapons +3", "Terran", CATEGORY_UPGRADE, 3, False, "sky"),
]

# -----------------------------------------------------------------------------
# ZERG
# -----------------------------------------------------------------------------
ZERG_ENTRIES: List[CatalogEntry] = [
    # Buildings
    CatalogEntry("Hatchery", "Hatchery", "Zerg", CATEGORY_TOWNHALL, 1, True),
    CatalogEntry("Lair", "Lair", "Zerg", CATEGORY_TOWNHALL, 2, True),
    CatalogEntry("Hive", "Hive", "Zerg", CATEGORY_TOWNHALL, 3, True),
    CatalogEntry("Extractor", "Extractor", "Zerg", CATEGORY_BUILDER, 1, True),
    CatalogEntry("SpawningPool", "Spawning Pool", "Zerg", CATEGORY_TECH, 1, True),
    CatalogEntry("EvolutionChamber", "Evolution Chamber", "Zerg", CATEGORY_TECH, 1, True),
    CatalogEntry("RoachWarren", "Roach Warren", "Zerg", CATEGORY_TECH, 1, True),
    CatalogEntry("BanelingNest", "Baneling Nest", "Zerg", CATEGORY_TECH, 1, True),
    CatalogEntry("SpineCrawler", "Spine Crawler", "Zerg", CATEGORY_DEFENSE, 1, True),
    CatalogEntry("SporeCrawler", "Spore Crawler", "Zerg", CATEGORY_DEFENSE, 1, True),
    CatalogEntry("SpineCrawlerUprooted", "Spine Crawler (Uprooted)", "Zerg", CATEGORY_DEFENSE, 1, True),
    CatalogEntry("SporeCrawlerUprooted", "Spore Crawler (Uprooted)", "Zerg", CATEGORY_DEFENSE, 1, True),
    CatalogEntry("HydraliskDen", "Hydralisk Den", "Zerg", CATEGORY_TECH, 2, True),
    CatalogEntry("LurkerDen", "Lurker Den", "Zerg", CATEGORY_TECH, 2, True),
    CatalogEntry("LurkerDenMP", "Lurker Den", "Zerg", CATEGORY_TECH, 2, True),
    CatalogEntry("InfestationPit", "Infestation Pit", "Zerg", CATEGORY_TECH, 2, True),
    CatalogEntry("Spire", "Spire", "Zerg", CATEGORY_TECH, 2, True),
    CatalogEntry("GreaterSpire", "Greater Spire", "Zerg", CATEGORY_TECH, 3, True),
    CatalogEntry("NydusNetwork", "Nydus Network", "Zerg", CATEGORY_BUILDER, 2, True),
    CatalogEntry("NydusCanal", "Nydus Worm", "Zerg", CATEGORY_BUILDER, 2, True),
    CatalogEntry("UltraliskCavern", "Ultralisk Cavern", "Zerg", CATEGORY_TECH, 3, True),
    CatalogEntry("CreepTumor", "Creep Tumor", "Zerg", CATEGORY_BUILDER, 1, True),
    CatalogEntry("CreepTumorBurrowed", "Creep Tumor (Burrowed)", "Zerg", CATEGORY_BUILDER, 1, True),
    CatalogEntry("CreepTumorQueen", "Creep Tumor (Queen)", "Zerg", CATEGORY_BUILDER, 1, True),
    # Units
    CatalogEntry("Drone", "Drone", "Zerg", CATEGORY_WORKER, 1, False),
    CatalogEntry("Larva", "Larva", "Zerg", CATEGORY_SPAWN, 1, False),
    CatalogEntry("Egg", "Egg", "Zerg", CATEGORY_SPAWN, 1, False),
    CatalogEntry("Overlord", "Overlord", "Zerg", CATEGORY_SUPPLY, 1, False),
    CatalogEntry("OverlordTransport", "Overlord (Transport)", "Zerg", CATEGORY_TRANSPORT, 2, False),
    CatalogEntry("Overseer", "Overseer", "Zerg", CATEGORY_DETECTOR, 2, False),
    CatalogEntry("OverseerSiegeMode", "Oversight Mode", "Zerg", CATEGORY_DETECTOR, 2, False),
    CatalogEntry("OverlordCocoon", "Overlord Cocoon", "Zerg", CATEGORY_SPAWN, 2, False),
    CatalogEntry("OverseerCocoon", "Overseer Cocoon", "Zerg", CATEGORY_SPAWN, 2, False),
    CatalogEntry("Queen", "Queen", "Zerg", CATEGORY_CASTER, 1, False),
    CatalogEntry("Zergling", "Zergling", "Zerg", CATEGORY_ARMY, 1, False, "ling"),
    CatalogEntry("Baneling", "Baneling", "Zerg", CATEGORY_ARMY, 1, False, "bane"),
    CatalogEntry("BanelingCocoon", "Baneling Cocoon", "Zerg", CATEGORY_SPAWN, 1, False, "bane"),
    CatalogEntry("Roach", "Roach", "Zerg", CATEGORY_ARMY, 1, False, "roach"),
    CatalogEntry("Ravager", "Ravager", "Zerg", CATEGORY_ARMY, 2, False, "roach"),
    CatalogEntry("RavagerCocoon", "Ravager Cocoon", "Zerg", CATEGORY_SPAWN, 2, False, "roach"),
    CatalogEntry("Hydralisk", "Hydralisk", "Zerg", CATEGORY_ARMY, 2, False, "hydra"),
    CatalogEntry("Lurker", "Lurker", "Zerg", CATEGORY_ARMY, 2, False, "lurker"),
    CatalogEntry("LurkerMP", "Lurker", "Zerg", CATEGORY_ARMY, 2, False, "lurker"),
    CatalogEntry("LurkerCocoon", "Lurker Cocoon", "Zerg", CATEGORY_SPAWN, 2, False, "lurker"),
    CatalogEntry("LurkerMPBurrowed", "Lurker (Burrowed)", "Zerg", CATEGORY_ARMY, 2, False, "lurker"),
    CatalogEntry("Infestor", "Infestor", "Zerg", CATEGORY_CASTER, 2, False, "caster"),
    CatalogEntry("InfestedTerran", "Infested Terran", "Zerg", CATEGORY_SPAWN, 2, False, "caster"),
    CatalogEntry("SwarmHost", "Swarm Host", "Zerg", CATEGORY_ARMY, 2, False, "swarm"),
    CatalogEntry("SwarmHostMP", "Swarm Host", "Zerg", CATEGORY_ARMY, 2, False, "swarm"),
    CatalogEntry("LocustMP", "Locust", "Zerg", CATEGORY_SPAWN, 2, False, "swarm"),
    CatalogEntry("LocustMPFlying", "Locust (Flying)", "Zerg", CATEGORY_SPAWN, 2, False, "swarm"),
    CatalogEntry("Mutalisk", "Mutalisk", "Zerg", CATEGORY_AIR, 2, False, "muta"),
    CatalogEntry("Corruptor", "Corruptor", "Zerg", CATEGORY_AIR, 2, False, "corruptor"),
    CatalogEntry("BroodLord", "Brood Lord", "Zerg", CATEGORY_AIR, 3, False, "broodlord"),
    CatalogEntry("BroodLordCocoon", "Brood Lord Cocoon", "Zerg", CATEGORY_SPAWN, 3, False, "broodlord"),
    CatalogEntry("BroodlingEscort", "Broodling", "Zerg", CATEGORY_SPAWN, 3, False, "broodlord"),
    CatalogEntry("Broodling", "Broodling", "Zerg", CATEGORY_SPAWN, 1, False, "broodlord"),
    CatalogEntry("Viper", "Viper", "Zerg", CATEGORY_CASTER, 3, False, "caster"),
    CatalogEntry("Ultralisk", "Ultralisk", "Zerg", CATEGORY_ARMY, 3, False, "ultra"),
    CatalogEntry("Changeling", "Changeling", "Zerg", CATEGORY_SPAWN, 1, False),
    CatalogEntry("ChangelingMarine", "Changeling (Marine)", "Zerg", CATEGORY_SPAWN, 1, False),
    CatalogEntry("ChangelingMarineShield", "Changeling (Marine Shield)", "Zerg", CATEGORY_SPAWN, 1, False),
    CatalogEntry("ChangelingZergling", "Changeling (Zergling)", "Zerg", CATEGORY_SPAWN, 1, False),
    CatalogEntry("ChangelingZealot", "Changeling (Zealot)", "Zerg", CATEGORY_SPAWN, 1, False),
    CatalogEntry("TransportOverlordCocoon", "Overlord Transport Cocoon", "Zerg", CATEGORY_SPAWN, 2, False),
]

ZERG_UPGRADES: List[CatalogEntry] = [
    CatalogEntry("Burrow", "Burrow", "Zerg", CATEGORY_UPGRADE, 1, False),
    CatalogEntry("Pneumatized Carapace", "Pneumatized Carapace", "Zerg", CATEGORY_UPGRADE, 1, False),
    CatalogEntry("PneumatizedCarapace", "Pneumatized Carapace", "Zerg", CATEGORY_UPGRADE, 1, False),
    CatalogEntry("Overlordspeed", "Pneumatized Carapace", "Zerg", CATEGORY_UPGRADE, 1, False),
    CatalogEntry("Zerglingmovementspeed", "Metabolic Boost", "Zerg", CATEGORY_UPGRADE, 1, False, "ling"),
    CatalogEntry("ZerglingMetabolicBoost", "Metabolic Boost", "Zerg", CATEGORY_UPGRADE, 1, False, "ling"),
    CatalogEntry("Zerglingattackspeed", "Adrenal Glands", "Zerg", CATEGORY_UPGRADE, 3, False, "ling"),
    CatalogEntry("ZerglingAdrenalGlands", "Adrenal Glands", "Zerg", CATEGORY_UPGRADE, 3, False, "ling"),
    CatalogEntry("CentrificalHooks", "Centrifugal Hooks", "Zerg", CATEGORY_UPGRADE, 2, False, "bane"),
    CatalogEntry("CentrifugalHooks", "Centrifugal Hooks", "Zerg", CATEGORY_UPGRADE, 2, False, "bane"),
    CatalogEntry("GlialReconstitution", "Glial Reconstitution", "Zerg", CATEGORY_UPGRADE, 2, False, "roach"),
    CatalogEntry("TunnelingClaws", "Tunneling Claws", "Zerg", CATEGORY_UPGRADE, 2, False, "roach"),
    CatalogEntry("EvolveMuscularAugments", "Muscular Augments", "Zerg", CATEGORY_UPGRADE, 2, False, "hydra"),
    CatalogEntry("EvolveGroovedSpines", "Grooved Spines", "Zerg", CATEGORY_UPGRADE, 2, False, "hydra"),
    CatalogEntry("LurkerRange", "Seismic Spines", "Zerg", CATEGORY_UPGRADE, 2, False, "lurker"),
    CatalogEntry("DiggingClaws", "Adaptive Talons", "Zerg", CATEGORY_UPGRADE, 2, False, "lurker"),
    CatalogEntry("AnabolicSynthesis", "Anabolic Synthesis", "Zerg", CATEGORY_UPGRADE, 3, False, "ultra"),
    CatalogEntry("ChitinousPlating", "Chitinous Plating", "Zerg", CATEGORY_UPGRADE, 3, False, "ultra"),
    CatalogEntry("InfestorEnergyUpgrade", "Pathogen Glands", "Zerg", CATEGORY_UPGRADE, 2, False, "caster"),
    CatalogEntry("NeuralParasite", "Neural Parasite", "Zerg", CATEGORY_UPGRADE, 2, False, "caster"),
    CatalogEntry("ZergMissileWeaponsLevel1", "Missile Attacks +1", "Zerg", CATEGORY_UPGRADE, 1, False),
    CatalogEntry("ZergMissileWeaponsLevel2", "Missile Attacks +2", "Zerg", CATEGORY_UPGRADE, 2, False),
    CatalogEntry("ZergMissileWeaponsLevel3", "Missile Attacks +3", "Zerg", CATEGORY_UPGRADE, 3, False),
    CatalogEntry("ZergMeleeWeaponsLevel1", "Melee Attacks +1", "Zerg", CATEGORY_UPGRADE, 1, False),
    CatalogEntry("ZergMeleeWeaponsLevel2", "Melee Attacks +2", "Zerg", CATEGORY_UPGRADE, 2, False),
    CatalogEntry("ZergMeleeWeaponsLevel3", "Melee Attacks +3", "Zerg", CATEGORY_UPGRADE, 3, False),
    CatalogEntry("ZergGroundArmorsLevel1", "Ground Carapace +1", "Zerg", CATEGORY_UPGRADE, 1, False),
    CatalogEntry("ZergGroundArmorsLevel2", "Ground Carapace +2", "Zerg", CATEGORY_UPGRADE, 2, False),
    CatalogEntry("ZergGroundArmorsLevel3", "Ground Carapace +3", "Zerg", CATEGORY_UPGRADE, 3, False),
    CatalogEntry("ZergFlyerWeaponsLevel1", "Flyer Attacks +1", "Zerg", CATEGORY_UPGRADE, 1, False),
    CatalogEntry("ZergFlyerWeaponsLevel2", "Flyer Attacks +2", "Zerg", CATEGORY_UPGRADE, 2, False),
    CatalogEntry("ZergFlyerWeaponsLevel3", "Flyer Attacks +3", "Zerg", CATEGORY_UPGRADE, 3, False),
    CatalogEntry("ZergFlyerArmorsLevel1", "Flyer Carapace +1", "Zerg", CATEGORY_UPGRADE, 1, False),
    CatalogEntry("ZergFlyerArmorsLevel2", "Flyer Carapace +2", "Zerg", CATEGORY_UPGRADE, 2, False),
    CatalogEntry("ZergFlyerArmorsLevel3", "Flyer Carapace +3", "Zerg", CATEGORY_UPGRADE, 3, False),
]


# -----------------------------------------------------------------------------
# Aggregated lookup tables.
# -----------------------------------------------------------------------------
_ALL_ENTRIES: List[CatalogEntry] = (
    PROTOSS_ENTRIES + PROTOSS_UPGRADES
    + TERRAN_ENTRIES + TERRAN_UPGRADES
    + ZERG_ENTRIES + ZERG_UPGRADES
)

CATALOG: Dict[str, CatalogEntry] = {e.name: e for e in _ALL_ENTRIES}


def lookup(name: str) -> Optional[CatalogEntry]:
    """Return the catalog entry for a sc2reader-cleaned name, or None."""
    if not name:
        return None
    entry = CATALOG.get(name)
    if entry is not None:
        return entry
    # Some sc2reader builds prepend the race; the cleaner usually strips it
    # but we double-belt-and-suspenders here.
    for prefix in ("Protoss", "Terran", "Zerg"):
        if name.startswith(prefix):
            stripped = name[len(prefix):]
            if stripped in CATALOG:
                return CATALOG[stripped]
    return None


def display_name(name: str) -> str:
    """Pretty-printed name, falling back to the raw name when unknown."""
    e = lookup(name)
    return e.display if e else name


def race_for(name: str) -> str:
    e = lookup(name)
    return e.race if e else "Neutral"


def category_for(name: str) -> str:
    e = lookup(name)
    return e.category if e else "unknown"


def composition_tag(name: str) -> Optional[str]:
    e = lookup(name)
    return e.composition_tag if e else None


def is_known_building(name: str) -> bool:
    e = lookup(name)
    return e.is_building if e else False


# Race-bucketed name sets for fast `in` checks (used by event_extractor).
PROTOSS_NAMES: Set[str] = {e.name for e in PROTOSS_ENTRIES + PROTOSS_UPGRADES}
TERRAN_NAMES: Set[str] = {e.name for e in TERRAN_ENTRIES + TERRAN_UPGRADES}
ZERG_NAMES: Set[str] = {e.name for e in ZERG_ENTRIES + ZERG_UPGRADES}

# Quick category helpers for the strategy detector's composition fallback.
ARMY_CATEGORIES: Set[str] = {
    CATEGORY_ARMY, CATEGORY_CASTER, CATEGORY_AIR, CATEGORY_HERO, CATEGORY_DETECTOR,
}


def composition_summary(unit_events: List[Dict], min_count: int = 3) -> List[str]:
    """Return the top composition tags observed in `unit_events`.

    Used by the opponent strategy detector to derive a meaningful fallback
    label like "Roach/Hydra Comp" instead of "Standard Play (Unclassified)".
    """
    from collections import Counter
    counts: Counter = Counter()
    for ev in unit_events:
        if ev.get("type") != "unit":
            continue
        tag = composition_tag(ev.get("name", ""))
        if tag:
            counts[tag] += 1
    return [tag for tag, c in counts.most_common(3) if c >= min_count]
