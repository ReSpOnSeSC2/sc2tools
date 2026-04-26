/**
 * SC2 Catalog (JS twin of core/sc2_catalog.py).
 *
 * Mirrors the Python catalog so the browser app can render canonical
 * display names, race-color coded badges, and category groupings without
 * round-tripping to the Python side.
 *
 * Keep this file in sync with core/sc2_catalog.py — when adding a new
 * unit or upgrade in the Python catalog, add the matching entry here.
 *
 * Each entry: { display, race, category, tier, isBuilding, comp }
 */

const CAT = {
    TOWNHALL: 'townhall', BUILDER: 'builder', DEFENSE: 'defense',
    SUPPLY: 'supply', TECH: 'tech', WORKER: 'worker',
    ARMY: 'army', CASTER: 'caster', AIR: 'air',
    DETECTOR: 'detector', TRANSPORT: 'transport', HERO: 'hero',
    SPAWN: 'spawn', UPGRADE: 'upgrade',
};

function mk(display, race, category, tier, isBuilding = false, comp = null) {
    return { display, race, category, tier, isBuilding, comp };
}

// ---------------------------------------------------------------------------
// PROTOSS
// ---------------------------------------------------------------------------
const PROTOSS = {
    Nexus: mk('Nexus', 'Protoss', CAT.TOWNHALL, 1, true),
    Pylon: mk('Pylon', 'Protoss', CAT.SUPPLY, 1, true),
    Assimilator: mk('Assimilator', 'Protoss', CAT.BUILDER, 1, true),
    Gateway: mk('Gateway', 'Protoss', CAT.BUILDER, 1, true),
    WarpGate: mk('Warp Gate', 'Protoss', CAT.BUILDER, 1, true),
    Forge: mk('Forge', 'Protoss', CAT.TECH, 1, true),
    PhotonCannon: mk('Photon Cannon', 'Protoss', CAT.DEFENSE, 1, true),
    ShieldBattery: mk('Shield Battery', 'Protoss', CAT.DEFENSE, 1, true),
    CyberneticsCore: mk('Cybernetics Core', 'Protoss', CAT.TECH, 1, true),
    TwilightCouncil: mk('Twilight Council', 'Protoss', CAT.TECH, 2, true),
    RoboticsFacility: mk('Robotics Facility', 'Protoss', CAT.BUILDER, 2, true),
    RoboticsBay: mk('Robotics Bay', 'Protoss', CAT.TECH, 3, true),
    Stargate: mk('Stargate', 'Protoss', CAT.BUILDER, 2, true),
    FleetBeacon: mk('Fleet Beacon', 'Protoss', CAT.TECH, 3, true),
    TemplarArchive: mk('Templar Archives', 'Protoss', CAT.TECH, 2, true),
    DarkShrine: mk('Dark Shrine', 'Protoss', CAT.TECH, 2, true),
    Probe: mk('Probe', 'Protoss', CAT.WORKER, 1),
    Zealot: mk('Zealot', 'Protoss', CAT.ARMY, 1, false, 'gateway'),
    Stalker: mk('Stalker', 'Protoss', CAT.ARMY, 1, false, 'gateway'),
    Sentry: mk('Sentry', 'Protoss', CAT.CASTER, 1, false, 'gateway'),
    Adept: mk('Adept', 'Protoss', CAT.ARMY, 1, false, 'gateway'),
    HighTemplar: mk('High Templar', 'Protoss', CAT.CASTER, 2, false, 'templar'),
    DarkTemplar: mk('Dark Templar', 'Protoss', CAT.ARMY, 2, false, 'dt'),
    Archon: mk('Archon', 'Protoss', CAT.ARMY, 2, false, 'templar'),
    Observer: mk('Observer', 'Protoss', CAT.DETECTOR, 1, false, 'robo'),
    ObserverSiegeMode: mk('Surveillance Mode', 'Protoss', CAT.DETECTOR, 1, false, 'robo'),
    WarpPrism: mk('Warp Prism', 'Protoss', CAT.TRANSPORT, 1, false, 'robo'),
    WarpPrismPhasing: mk('Warp Prism (Phasing)', 'Protoss', CAT.TRANSPORT, 1, false, 'robo'),
    Immortal: mk('Immortal', 'Protoss', CAT.ARMY, 2, false, 'robo'),
    Colossus: mk('Colossus', 'Protoss', CAT.ARMY, 3, false, 'robo'),
    Disruptor: mk('Disruptor', 'Protoss', CAT.ARMY, 3, false, 'robo'),
    Phoenix: mk('Phoenix', 'Protoss', CAT.AIR, 1, false, 'sky'),
    VoidRay: mk('Void Ray', 'Protoss', CAT.AIR, 2, false, 'sky'),
    Oracle: mk('Oracle', 'Protoss', CAT.CASTER, 1, false, 'sky'),
    Tempest: mk('Tempest', 'Protoss', CAT.AIR, 3, false, 'sky'),
    Carrier: mk('Carrier', 'Protoss', CAT.AIR, 3, false, 'sky'),
    Mothership: mk('Mothership', 'Protoss', CAT.HERO, 3, false, 'sky'),
    MothershipCore: mk('Mothership Core', 'Protoss', CAT.HERO, 1, false, 'sky'),
    Interceptor: mk('Interceptor', 'Protoss', CAT.SPAWN, 3, false, 'sky'),
    AdeptPhaseShift: mk('Adept Phase Shift', 'Protoss', CAT.SPAWN, 1, false, 'gateway'),
    // Upgrades
    WarpGateResearch: mk('Warp Gate Research', 'Protoss', CAT.UPGRADE, 1),
    Charge: mk('Charge', 'Protoss', CAT.UPGRADE, 2, false, 'gateway'),
    BlinkTech: mk('Blink', 'Protoss', CAT.UPGRADE, 2, false, 'gateway'),
    AdeptPiercingAttack: mk('Resonating Glaives', 'Protoss', CAT.UPGRADE, 2, false, 'gateway'),
    PsiStormTech: mk('Psionic Storm', 'Protoss', CAT.UPGRADE, 2, false, 'templar'),
    DarkTemplarBlinkUpgrade: mk('Shadow Stride', 'Protoss', CAT.UPGRADE, 2, false, 'dt'),
    ExtendedThermalLance: mk('Extended Thermal Lance', 'Protoss', CAT.UPGRADE, 3, false, 'robo'),
    GraviticDrive: mk('Gravitic Drive', 'Protoss', CAT.UPGRADE, 2, false, 'robo'),
    ObserverGraviticBooster: mk('Gravitic Boosters', 'Protoss', CAT.UPGRADE, 1, false, 'robo'),
    PhoenixRangeUpgrade: mk('Anion Pulse-Crystals', 'Protoss', CAT.UPGRADE, 2, false, 'sky'),
    VoidRaySpeedUpgrade: mk('Flux Vanes', 'Protoss', CAT.UPGRADE, 2, false, 'sky'),
    TempestGroundAttackUpgrade: mk('Tectonic Destabilizers', 'Protoss', CAT.UPGRADE, 3, false, 'sky'),
    InterceptorGravitonCatapult: mk('Graviton Catapult', 'Protoss', CAT.UPGRADE, 3, false, 'sky'),
    ProtossGroundWeaponsLevel1: mk('Ground Weapons +1', 'Protoss', CAT.UPGRADE, 1),
    ProtossGroundWeaponsLevel2: mk('Ground Weapons +2', 'Protoss', CAT.UPGRADE, 2),
    ProtossGroundWeaponsLevel3: mk('Ground Weapons +3', 'Protoss', CAT.UPGRADE, 3),
    ProtossGroundArmorsLevel1: mk('Ground Armor +1', 'Protoss', CAT.UPGRADE, 1),
    ProtossGroundArmorsLevel2: mk('Ground Armor +2', 'Protoss', CAT.UPGRADE, 2),
    ProtossGroundArmorsLevel3: mk('Ground Armor +3', 'Protoss', CAT.UPGRADE, 3),
    ProtossShieldsLevel1: mk('Shields +1', 'Protoss', CAT.UPGRADE, 1),
    ProtossShieldsLevel2: mk('Shields +2', 'Protoss', CAT.UPGRADE, 2),
    ProtossShieldsLevel3: mk('Shields +3', 'Protoss', CAT.UPGRADE, 3),
    ProtossAirWeaponsLevel1: mk('Air Weapons +1', 'Protoss', CAT.UPGRADE, 1),
    ProtossAirWeaponsLevel2: mk('Air Weapons +2', 'Protoss', CAT.UPGRADE, 2),
    ProtossAirWeaponsLevel3: mk('Air Weapons +3', 'Protoss', CAT.UPGRADE, 3),
    ProtossAirArmorsLevel1: mk('Air Armor +1', 'Protoss', CAT.UPGRADE, 1),
    ProtossAirArmorsLevel2: mk('Air Armor +2', 'Protoss', CAT.UPGRADE, 2),
    ProtossAirArmorsLevel3: mk('Air Armor +3', 'Protoss', CAT.UPGRADE, 3),
};

// ---------------------------------------------------------------------------
// TERRAN
// ---------------------------------------------------------------------------
const TERRAN = {
    CommandCenter: mk('Command Center', 'Terran', CAT.TOWNHALL, 1, true),
    OrbitalCommand: mk('Orbital Command', 'Terran', CAT.TOWNHALL, 1, true),
    PlanetaryFortress: mk('Planetary Fortress', 'Terran', CAT.TOWNHALL, 2, true),
    CommandCenterFlying: mk('Command Center (Lifted)', 'Terran', CAT.TOWNHALL, 1, true),
    OrbitalCommandFlying: mk('Orbital Command (Lifted)', 'Terran', CAT.TOWNHALL, 1, true),
    SupplyDepot: mk('Supply Depot', 'Terran', CAT.SUPPLY, 1, true),
    SupplyDepotLowered: mk('Supply Depot (Lowered)', 'Terran', CAT.SUPPLY, 1, true),
    Refinery: mk('Refinery', 'Terran', CAT.BUILDER, 1, true),
    Barracks: mk('Barracks', 'Terran', CAT.BUILDER, 1, true),
    BarracksFlying: mk('Barracks (Lifted)', 'Terran', CAT.BUILDER, 1, true),
    BarracksTechLab: mk('Barracks Tech Lab', 'Terran', CAT.TECH, 1, true),
    BarracksReactor: mk('Barracks Reactor', 'Terran', CAT.TECH, 1, true),
    EngineeringBay: mk('Engineering Bay', 'Terran', CAT.TECH, 1, true),
    Bunker: mk('Bunker', 'Terran', CAT.DEFENSE, 1, true),
    MissileTurret: mk('Missile Turret', 'Terran', CAT.DEFENSE, 1, true),
    SensorTower: mk('Sensor Tower', 'Terran', CAT.DETECTOR, 2, true),
    GhostAcademy: mk('Ghost Academy', 'Terran', CAT.TECH, 2, true),
    Factory: mk('Factory', 'Terran', CAT.BUILDER, 2, true),
    FactoryFlying: mk('Factory (Lifted)', 'Terran', CAT.BUILDER, 2, true),
    FactoryTechLab: mk('Factory Tech Lab', 'Terran', CAT.TECH, 2, true),
    FactoryReactor: mk('Factory Reactor', 'Terran', CAT.TECH, 2, true),
    Armory: mk('Armory', 'Terran', CAT.TECH, 2, true),
    Starport: mk('Starport', 'Terran', CAT.BUILDER, 2, true),
    StarportFlying: mk('Starport (Lifted)', 'Terran', CAT.BUILDER, 2, true),
    StarportTechLab: mk('Starport Tech Lab', 'Terran', CAT.TECH, 2, true),
    StarportReactor: mk('Starport Reactor', 'Terran', CAT.TECH, 2, true),
    FusionCore: mk('Fusion Core', 'Terran', CAT.TECH, 3, true),
    TechLab: mk('Tech Lab', 'Terran', CAT.TECH, 1, true),
    Reactor: mk('Reactor', 'Terran', CAT.TECH, 1, true),
    SCV: mk('SCV', 'Terran', CAT.WORKER, 1),
    MULE: mk('MULE', 'Terran', CAT.SPAWN, 1),
    Marine: mk('Marine', 'Terran', CAT.ARMY, 1, false, 'bio'),
    Marauder: mk('Marauder', 'Terran', CAT.ARMY, 1, false, 'bio'),
    Reaper: mk('Reaper', 'Terran', CAT.ARMY, 1, false, 'bio'),
    Ghost: mk('Ghost', 'Terran', CAT.CASTER, 2, false, 'bio'),
    Hellion: mk('Hellion', 'Terran', CAT.ARMY, 2, false, 'mech'),
    HellionTank: mk('Hellbat', 'Terran', CAT.ARMY, 2, false, 'mech'),
    Hellbat: mk('Hellbat', 'Terran', CAT.ARMY, 2, false, 'mech'),
    WidowMine: mk('Widow Mine', 'Terran', CAT.ARMY, 2, false, 'mech'),
    WidowMineBurrowed: mk('Widow Mine (Burrowed)', 'Terran', CAT.ARMY, 2, false, 'mech'),
    SiegeTank: mk('Siege Tank', 'Terran', CAT.ARMY, 2, false, 'mech'),
    SiegeTankSieged: mk('Siege Tank (Sieged)', 'Terran', CAT.ARMY, 2, false, 'mech'),
    Cyclone: mk('Cyclone', 'Terran', CAT.ARMY, 2, false, 'mech'),
    Thor: mk('Thor', 'Terran', CAT.ARMY, 3, false, 'mech'),
    ThorAP: mk('Thor (High Impact)', 'Terran', CAT.ARMY, 3, false, 'mech'),
    VikingFighter: mk('Viking', 'Terran', CAT.AIR, 2, false, 'sky'),
    VikingAssault: mk('Viking (Landed)', 'Terran', CAT.AIR, 2, false, 'sky'),
    Medivac: mk('Medivac', 'Terran', CAT.TRANSPORT, 2, false, 'bio'),
    Liberator: mk('Liberator', 'Terran', CAT.AIR, 2, false, 'sky'),
    LiberatorAG: mk('Liberator (Defender)', 'Terran', CAT.AIR, 2, false, 'sky'),
    Banshee: mk('Banshee', 'Terran', CAT.AIR, 2, false, 'sky'),
    Raven: mk('Raven', 'Terran', CAT.DETECTOR, 2, false, 'sky'),
    Battlecruiser: mk('Battlecruiser', 'Terran', CAT.AIR, 3, false, 'sky'),
    AutoTurret: mk('Auto Turret', 'Terran', CAT.SPAWN, 2, false, 'sky'),
    PointDefenseDrone: mk('Point Defense Drone', 'Terran', CAT.SPAWN, 2, false, 'sky'),
    Stimpack: mk('Stimpack', 'Terran', CAT.UPGRADE, 1, false, 'bio'),
    ShieldWall: mk('Combat Shield', 'Terran', CAT.UPGRADE, 1, false, 'bio'),
    PunisherGrenades: mk('Concussive Shells', 'Terran', CAT.UPGRADE, 1, false, 'bio'),
    DrillClaws: mk('Drilling Claws', 'Terran', CAT.UPGRADE, 2, false, 'mech'),
    CycloneLockOnDamageUpgrade: mk('Mag-Field Accelerator', 'Terran', CAT.UPGRADE, 2, false, 'mech'),
    HighCapacityBarrels: mk('Infernal Pre-Igniter', 'Terran', CAT.UPGRADE, 2, false, 'mech'),
    SmartServos: mk('Smart Servos', 'Terran', CAT.UPGRADE, 2, false, 'mech'),
    BansheeCloak: mk('Cloaking Field', 'Terran', CAT.UPGRADE, 2, false, 'sky'),
    BansheeSpeed: mk('Hyperflight Rotors', 'Terran', CAT.UPGRADE, 2, false, 'sky'),
    RavenCorvidReactor: mk('Corvid Reactor', 'Terran', CAT.UPGRADE, 2, false, 'sky'),
    LiberatorAGRangeUpgrade: mk('Advanced Ballistics', 'Terran', CAT.UPGRADE, 2, false, 'sky'),
    YamatoCannon: mk('Yamato Cannon', 'Terran', CAT.UPGRADE, 3, false, 'sky'),
    PersonalCloaking: mk('Personal Cloaking', 'Terran', CAT.UPGRADE, 2, false, 'bio'),
    TerranInfantryWeaponsLevel1: mk('Infantry Weapons +1', 'Terran', CAT.UPGRADE, 1, false, 'bio'),
    TerranInfantryWeaponsLevel2: mk('Infantry Weapons +2', 'Terran', CAT.UPGRADE, 2, false, 'bio'),
    TerranInfantryWeaponsLevel3: mk('Infantry Weapons +3', 'Terran', CAT.UPGRADE, 3, false, 'bio'),
    TerranInfantryArmorsLevel1: mk('Infantry Armor +1', 'Terran', CAT.UPGRADE, 1, false, 'bio'),
    TerranInfantryArmorsLevel2: mk('Infantry Armor +2', 'Terran', CAT.UPGRADE, 2, false, 'bio'),
    TerranInfantryArmorsLevel3: mk('Infantry Armor +3', 'Terran', CAT.UPGRADE, 3, false, 'bio'),
    TerranVehicleWeaponsLevel1: mk('Vehicle Weapons +1', 'Terran', CAT.UPGRADE, 1, false, 'mech'),
    TerranVehicleWeaponsLevel2: mk('Vehicle Weapons +2', 'Terran', CAT.UPGRADE, 2, false, 'mech'),
    TerranVehicleWeaponsLevel3: mk('Vehicle Weapons +3', 'Terran', CAT.UPGRADE, 3, false, 'mech'),
    TerranVehicleAndShipArmorsLevel1: mk('Vehicle/Ship Armor +1', 'Terran', CAT.UPGRADE, 1, false, 'mech'),
    TerranVehicleAndShipArmorsLevel2: mk('Vehicle/Ship Armor +2', 'Terran', CAT.UPGRADE, 2, false, 'mech'),
    TerranVehicleAndShipArmorsLevel3: mk('Vehicle/Ship Armor +3', 'Terran', CAT.UPGRADE, 3, false, 'mech'),
    TerranShipWeaponsLevel1: mk('Ship Weapons +1', 'Terran', CAT.UPGRADE, 1, false, 'sky'),
    TerranShipWeaponsLevel2: mk('Ship Weapons +2', 'Terran', CAT.UPGRADE, 2, false, 'sky'),
    TerranShipWeaponsLevel3: mk('Ship Weapons +3', 'Terran', CAT.UPGRADE, 3, false, 'sky'),
};

// ---------------------------------------------------------------------------
// ZERG
// ---------------------------------------------------------------------------
const ZERG = {
    Hatchery: mk('Hatchery', 'Zerg', CAT.TOWNHALL, 1, true),
    Lair: mk('Lair', 'Zerg', CAT.TOWNHALL, 2, true),
    Hive: mk('Hive', 'Zerg', CAT.TOWNHALL, 3, true),
    Extractor: mk('Extractor', 'Zerg', CAT.BUILDER, 1, true),
    SpawningPool: mk('Spawning Pool', 'Zerg', CAT.TECH, 1, true),
    EvolutionChamber: mk('Evolution Chamber', 'Zerg', CAT.TECH, 1, true),
    RoachWarren: mk('Roach Warren', 'Zerg', CAT.TECH, 1, true),
    BanelingNest: mk('Baneling Nest', 'Zerg', CAT.TECH, 1, true),
    SpineCrawler: mk('Spine Crawler', 'Zerg', CAT.DEFENSE, 1, true),
    SporeCrawler: mk('Spore Crawler', 'Zerg', CAT.DEFENSE, 1, true),
    HydraliskDen: mk('Hydralisk Den', 'Zerg', CAT.TECH, 2, true),
    LurkerDen: mk('Lurker Den', 'Zerg', CAT.TECH, 2, true),
    LurkerDenMP: mk('Lurker Den', 'Zerg', CAT.TECH, 2, true),
    InfestationPit: mk('Infestation Pit', 'Zerg', CAT.TECH, 2, true),
    Spire: mk('Spire', 'Zerg', CAT.TECH, 2, true),
    GreaterSpire: mk('Greater Spire', 'Zerg', CAT.TECH, 3, true),
    NydusNetwork: mk('Nydus Network', 'Zerg', CAT.BUILDER, 2, true),
    NydusCanal: mk('Nydus Worm', 'Zerg', CAT.BUILDER, 2, true),
    UltraliskCavern: mk('Ultralisk Cavern', 'Zerg', CAT.TECH, 3, true),
    CreepTumor: mk('Creep Tumor', 'Zerg', CAT.BUILDER, 1, true),
    CreepTumorBurrowed: mk('Creep Tumor (Burrowed)', 'Zerg', CAT.BUILDER, 1, true),
    CreepTumorQueen: mk('Creep Tumor (Queen)', 'Zerg', CAT.BUILDER, 1, true),
    Drone: mk('Drone', 'Zerg', CAT.WORKER, 1),
    Larva: mk('Larva', 'Zerg', CAT.SPAWN, 1),
    Egg: mk('Egg', 'Zerg', CAT.SPAWN, 1),
    Overlord: mk('Overlord', 'Zerg', CAT.SUPPLY, 1),
    OverlordTransport: mk('Overlord (Transport)', 'Zerg', CAT.TRANSPORT, 2),
    Overseer: mk('Overseer', 'Zerg', CAT.DETECTOR, 2),
    OverseerSiegeMode: mk('Oversight Mode', 'Zerg', CAT.DETECTOR, 2),
    Queen: mk('Queen', 'Zerg', CAT.CASTER, 1),
    Zergling: mk('Zergling', 'Zerg', CAT.ARMY, 1, false, 'ling'),
    Baneling: mk('Baneling', 'Zerg', CAT.ARMY, 1, false, 'bane'),
    Roach: mk('Roach', 'Zerg', CAT.ARMY, 1, false, 'roach'),
    Ravager: mk('Ravager', 'Zerg', CAT.ARMY, 2, false, 'roach'),
    Hydralisk: mk('Hydralisk', 'Zerg', CAT.ARMY, 2, false, 'hydra'),
    Lurker: mk('Lurker', 'Zerg', CAT.ARMY, 2, false, 'lurker'),
    LurkerMP: mk('Lurker', 'Zerg', CAT.ARMY, 2, false, 'lurker'),
    LurkerMPBurrowed: mk('Lurker (Burrowed)', 'Zerg', CAT.ARMY, 2, false, 'lurker'),
    Infestor: mk('Infestor', 'Zerg', CAT.CASTER, 2, false, 'caster'),
    InfestedTerran: mk('Infested Terran', 'Zerg', CAT.SPAWN, 2, false, 'caster'),
    SwarmHost: mk('Swarm Host', 'Zerg', CAT.ARMY, 2, false, 'swarm'),
    SwarmHostMP: mk('Swarm Host', 'Zerg', CAT.ARMY, 2, false, 'swarm'),
    LocustMP: mk('Locust', 'Zerg', CAT.SPAWN, 2, false, 'swarm'),
    LocustMPFlying: mk('Locust (Flying)', 'Zerg', CAT.SPAWN, 2, false, 'swarm'),
    Mutalisk: mk('Mutalisk', 'Zerg', CAT.AIR, 2, false, 'muta'),
    Corruptor: mk('Corruptor', 'Zerg', CAT.AIR, 2, false, 'corruptor'),
    BroodLord: mk('Brood Lord', 'Zerg', CAT.AIR, 3, false, 'broodlord'),
    Broodling: mk('Broodling', 'Zerg', CAT.SPAWN, 1, false, 'broodlord'),
    Viper: mk('Viper', 'Zerg', CAT.CASTER, 3, false, 'caster'),
    Ultralisk: mk('Ultralisk', 'Zerg', CAT.ARMY, 3, false, 'ultra'),
    Changeling: mk('Changeling', 'Zerg', CAT.SPAWN, 1),
    ChangelingMarine: mk('Changeling (Marine)', 'Zerg', CAT.SPAWN, 1),
    ChangelingZergling: mk('Changeling (Zergling)', 'Zerg', CAT.SPAWN, 1),
    ChangelingZealot: mk('Changeling (Zealot)', 'Zerg', CAT.SPAWN, 1),
    Burrow: mk('Burrow', 'Zerg', CAT.UPGRADE, 1),
    PneumatizedCarapace: mk('Pneumatized Carapace', 'Zerg', CAT.UPGRADE, 1),
    Overlordspeed: mk('Pneumatized Carapace', 'Zerg', CAT.UPGRADE, 1),
    Zerglingmovementspeed: mk('Metabolic Boost', 'Zerg', CAT.UPGRADE, 1, false, 'ling'),
    ZerglingMetabolicBoost: mk('Metabolic Boost', 'Zerg', CAT.UPGRADE, 1, false, 'ling'),
    Zerglingattackspeed: mk('Adrenal Glands', 'Zerg', CAT.UPGRADE, 3, false, 'ling'),
    ZerglingAdrenalGlands: mk('Adrenal Glands', 'Zerg', CAT.UPGRADE, 3, false, 'ling'),
    CentrifugalHooks: mk('Centrifugal Hooks', 'Zerg', CAT.UPGRADE, 2, false, 'bane'),
    GlialReconstitution: mk('Glial Reconstitution', 'Zerg', CAT.UPGRADE, 2, false, 'roach'),
    TunnelingClaws: mk('Tunneling Claws', 'Zerg', CAT.UPGRADE, 2, false, 'roach'),
    EvolveMuscularAugments: mk('Muscular Augments', 'Zerg', CAT.UPGRADE, 2, false, 'hydra'),
    EvolveGroovedSpines: mk('Grooved Spines', 'Zerg', CAT.UPGRADE, 2, false, 'hydra'),
    LurkerRange: mk('Seismic Spines', 'Zerg', CAT.UPGRADE, 2, false, 'lurker'),
    DiggingClaws: mk('Adaptive Talons', 'Zerg', CAT.UPGRADE, 2, false, 'lurker'),
    AnabolicSynthesis: mk('Anabolic Synthesis', 'Zerg', CAT.UPGRADE, 3, false, 'ultra'),
    ChitinousPlating: mk('Chitinous Plating', 'Zerg', CAT.UPGRADE, 3, false, 'ultra'),
    NeuralParasite: mk('Neural Parasite', 'Zerg', CAT.UPGRADE, 2, false, 'caster'),
    ZergMissileWeaponsLevel1: mk('Missile Attacks +1', 'Zerg', CAT.UPGRADE, 1),
    ZergMissileWeaponsLevel2: mk('Missile Attacks +2', 'Zerg', CAT.UPGRADE, 2),
    ZergMissileWeaponsLevel3: mk('Missile Attacks +3', 'Zerg', CAT.UPGRADE, 3),
    ZergMeleeWeaponsLevel1: mk('Melee Attacks +1', 'Zerg', CAT.UPGRADE, 1),
    ZergMeleeWeaponsLevel2: mk('Melee Attacks +2', 'Zerg', CAT.UPGRADE, 2),
    ZergMeleeWeaponsLevel3: mk('Melee Attacks +3', 'Zerg', CAT.UPGRADE, 3),
    ZergGroundArmorsLevel1: mk('Ground Carapace +1', 'Zerg', CAT.UPGRADE, 1),
    ZergGroundArmorsLevel2: mk('Ground Carapace +2', 'Zerg', CAT.UPGRADE, 2),
    ZergGroundArmorsLevel3: mk('Ground Carapace +3', 'Zerg', CAT.UPGRADE, 3),
    ZergFlyerWeaponsLevel1: mk('Flyer Attacks +1', 'Zerg', CAT.UPGRADE, 1),
    ZergFlyerWeaponsLevel2: mk('Flyer Attacks +2', 'Zerg', CAT.UPGRADE, 2),
    ZergFlyerWeaponsLevel3: mk('Flyer Attacks +3', 'Zerg', CAT.UPGRADE, 3),
    ZergFlyerArmorsLevel1: mk('Flyer Carapace +1', 'Zerg', CAT.UPGRADE, 1),
    ZergFlyerArmorsLevel2: mk('Flyer Carapace +2', 'Zerg', CAT.UPGRADE, 2),
    ZergFlyerArmorsLevel3: mk('Flyer Carapace +3', 'Zerg', CAT.UPGRADE, 3),
};

const CATALOG = Object.assign({}, PROTOSS, TERRAN, ZERG);

function lookup(name) {
    if (!name) return null;
    if (CATALOG[name]) return CATALOG[name];
    for (const prefix of ['Protoss', 'Terran', 'Zerg']) {
        if (name.startsWith(prefix)) {
            const stripped = name.slice(prefix.length);
            if (CATALOG[stripped]) return CATALOG[stripped];
        }
    }
    return null;
}

function displayName(name) {
    const e = lookup(name);
    return e ? e.display : name;
}

function raceFor(name) {
    const e = lookup(name);
    return e ? e.race : 'Neutral';
}

function categoryFor(name) {
    const e = lookup(name);
    return e ? e.category : 'unknown';
}

function isBuilding(name) {
    const e = lookup(name);
    return e ? !!e.isBuilding : false;
}

module.exports = {
    CATALOG, CAT, PROTOSS, TERRAN, ZERG,
    lookup, displayName, raceFor, categoryFor, isBuilding,
};
