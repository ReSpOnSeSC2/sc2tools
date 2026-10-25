/** Replay tracker names, display aliases and historical spellings. These are
 * distinct event tokens: the editor never rewrites an existing rule's alias. */
export const BUILD_TOKEN_UPGRADE_NAMES = {
  Protoss: [
    "WarpGateResearch", "Charge", "Blink", "BlinkTech", "ResonatingGlaives", "AdeptPiercingAttack", "PsiStorm", "PsiStormTech",
    "DarkTemplarBlinkUpgrade", "ShadowStride", "ExtendedThermalLance", "GraviticDrive", "ObserverGraviticBooster", "GraviticBoosters",
    "PhoenixRangeUpgrade", "AnionPulseCrystals", "VoidRaySpeedUpgrade", "FluxVanes", "TempestGroundAttackUpgrade", "TectonicDestabilizers",
    ...[1, 2, 3].flatMap(level => [
      `ProtossGroundWeaponsLevel${level}`, `ProtossGroundArmorsLevel${level}`, `ProtossGroundArmorLevel${level}`,
      `ProtossShieldsLevel${level}`, `ProtossAirWeaponsLevel${level}`, `ProtossAirArmorsLevel${level}`, `ProtossAirArmorLevel${level}`,
    ]),
  ],
  Terran: [
    "Stimpack", "Stim", "ShieldWall", "CombatShield", "PunisherGrenades", "ConcussiveShells", "HiSecAutoTracking", "TerranBuildingArmor", "NeosteelArmor",
    "DrillClaws", "DrillingClaws", "CycloneLockOnDamageUpgrade", "MagFieldAccelerator", "HighCapacityBarrels", "InfernalPreigniter", "SmartServos",
    "BansheeCloak", "CloakingField", "BansheeSpeed", "HyperflightRotors", "RavenCorvidReactor", "CorvidReactor", "EnhancedShockwaves",
    "MedivacCaduceusReactor", "CaduceusReactor", "MedivacIncreaseSpeedBoost", "RapidReignition", "LiberatorAGRangeUpgrade", "AdvancedBallistics",
    "BattlecruiserEnableSpecializations", "WeaponRefit", "PersonalCloaking", "YamatoCannon",
    ...[1, 2, 3].flatMap(level => [
      `TerranInfantryWeaponsLevel${level}`, `TerranInfantryArmorsLevel${level}`, `TerranInfantryArmorLevel${level}`,
      `TerranVehicleWeaponsLevel${level}`, `TerranVehicleAndShipArmorsLevel${level}`, `TerranVehicleArmorLevel${level}`, `TerranShipWeaponsLevel${level}`,
    ]),
  ],
  Zerg: [
    "Burrow", "PneumatizedCarapace", "OverlordSpeed", "MetabolicBoost", "ZerglingMetabolicBoost", "ZerglingMovementSpeed", "zerglingmovementspeed",
    "AdrenalGlands", "ZerglingAdrenalGlands", "ZerglingAttackSpeed", "zerglingattackspeed", "CentrifugalHooks", "CentrificalHooks",
    "GlialReconstitution", "TunnelingClaws", "EvolveMuscularAugments", "MuscularAugments", "EvolveGroovedSpines", "GroovedSpines",
    "LurkerRange", "SeismicSpines", "DiggingClaws", "AdaptiveTalons", "AnabolicSynthesis", "ChitinousPlating", "InfestorEnergyUpgrade", "PathogenGlands",
    "NeuralParasite", "Frenzy", "MicrobialShroud",
    ...[1, 2, 3].flatMap(level => [
      `ZergMissileWeaponsLevel${level}`, `ZergMeleeWeaponsLevel${level}`, `ZergGroundArmorsLevel${level}`, `ZergGroundCarapaceLevel${level}`,
      `ZergFlyerWeaponsLevel${level}`, `ZergFlyerArmorsLevel${level}`, `ZergFlyerCarapaceLevel${level}`,
    ]),
  ],
} as const;
