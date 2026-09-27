/**
 * StarCraft II balance-patch types.
 *
 * A {@link PatchProfile} carries the game constants (costs, build times,
 * supply, income-model rates, race mechanics) for one balance patch, so a
 * new patch is a JSON delta, not a code change. See lib/sc2-patch/data/.
 * The map replayer prices lost units from these profiles.
 */

export type SimRace = "Protoss" | "Terran" | "Zerg";

/* ------------------------------------------------------------------ */
/* Patch profile                                                       */
/* ------------------------------------------------------------------ */

export interface CombatStats {
  hp: number;
  shields?: number;
  /**
   * Exact weapon values used to preserve balance changes that a single
   * sustained-DPS number cannot express (bonuses and upgrade scaling).
   * The safety sim still consumes the aggregate DPS fields below.
   */
  weapon?: {
    damage: number;
    attacks?: number;
    bonusVsLight?: number;
    damagePerUpgrade?: number;
    bonusVsLightPerUpgrade?: number;
  };
  /** Sustained DPS vs ground targets (Liquipedia values). */
  dpsGround?: number;
  /** Sustained DPS vs air targets. */
  dpsAir?: number;
  /** Movement speed (game units/sec). Recorded for completeness; the
   *  macro/safety sim does not model movement. */
  speed?: number;
  /** Attack/ability range. Recorded for completeness; not consumed by the sim. */
  range?: number;
  /** Static defense (cannon/spine/bunker/turret) — can't chase. */
  isStatic?: boolean;
  /** Flying unit — only defenders with dpsAir can hit it. */
  isFlying?: boolean;
  /** Garrisonable structure (Bunker): boosts up to `capacity` infantry. */
  garrison?: { capacity: number; multiplier: number };
}

export interface UnitDef {
  race: SimRace;
  minerals: number;
  gas: number;
  /** Supply consumed. 0 for structures; 0.5 for zerglings. */
  supply: number;
  /** Build / train / morph duration in real ("faster") seconds. */
  buildTime: number;
  /**
   * Producer names. "Larva" for larva-born zerg units, a structure
   * name for trained units, the consumed unit name for morphs
   * (combined with `morphFrom`), or "Probe"/"SCV"/"Drone" for
   * structures (worker-built).
   */
  builtFrom: string[];
  /**
   * Tech requirements, all must be satisfied. Each entry may offer
   * alternatives with "|" (e.g. "Lair|Hive"). Entries name structures
   * or upgrades that must be COMPLETED.
   */
  requires?: string[];
  isStructure?: boolean;
  isWorker?: boolean;
  /** Supply granted on completion (Pylon 8, Overlord 8, town halls…). */
  providesSupply?: number;
  /** Town hall — mining target, larva source for zerg. */
  isTownHall?: boolean;
  /** Gas collector built on a geyser. */
  isGasBuilding?: boolean;
  /** Unit consumed by this morph (Zergling→Baneling, Hatchery→Lair…). */
  morphFrom?: string;
  /** Terran addon: attaches to the producer named in builtFrom. */
  isAddon?: boolean;
  /** Production of this unit requires a TechLab on the producer. */
  requiresAddon?: boolean;
  /** Consumes one larva when trained (zerg larva-born units). */
  consumesLarva?: boolean;
  /**
   * One train order yields two units (Zerglings). Cost/supply are
   * per-unit; the engine doubles both for a single order.
   */
  pairTrained?: boolean;
  /** Caster/structure energy capacity (Shield Battery). Recorded for
   *  completeness; not consumed by the macro sim. */
  energy?: number;
  combat?: CombatStats;
}

export interface UpgradeDef {
  race: SimRace;
  minerals: number;
  gas: number;
  researchTime: number;
  /** Structures that can research this. */
  researchedAt: string[];
  requires?: string[];
  /**
   * Research runs without occupying the structure's production queue.
   * (Kept for research that lives on a unit-producing structure; 5.0.16
   * 5.0.16 moved warpgate research to the Cybernetics Core, which
   * trains nothing, so it no longer needs this.)
   */
  nonBlocking?: boolean;
}

export interface EconomyConfig {
  /** Patches per base by size class. */
  patchesPerBase: { large: number; small: number };
  /** Total minerals per patch by size class. */
  patchCapacity: { large: number; small: number };
  geysersPerBase: number;
  geyserCapacity: number;
  /** Rich geysers return 6 (5.0.16) instead of 4 — multiplier vs normal. */
  richGasMultiplier: number;
  /** Minerals/sec for workers 1..2 per patch. */
  mineralRatePerWorker: number;
  /** Marginal minerals/sec for the 3rd worker on a patch. */
  mineralRateThirdWorker: number;
  /** Gas/sec per worker, up to 3 per geyser. */
  gasRatePerWorker: number;
  muleMineralsTotal: number;
  muleDurationSec: number;
}

export interface MechanicsConfig {
  chrono: { energy: number; durationSec: number; rateMultiplier: number };
  inject: { energy: number; delaySec: number; larvae: number };
  larva: { intervalSec: number; naturalCap: number };
  energyRegenPerSec: number;
  /** Starting energy for casters that matter to macro (Nexus/Orbital/Queen). */
  startingEnergy: number;
  maxEnergy: number;
  warpgate: {
    /**
     * Fraction removed from Gateway train times after Warp Gate research.
     * When present, this is the authoritative percentage; explicit rounded
     * per-unit times still take precedence when a patch publishes them.
     */
    gatewayTrainTimeReduction?: number;
    /**
     * Legacy fallback gateway production speed multiplier once research
     * completes. Used only when the profile has neither a rounded per-unit
     * time nor an exact train-time reduction.
     */
    gatewaySpeedMultiplier: number;
    /**
     * Per-unit gateway production time AFTER warpgate research finishes.
     * The initial 5.0.16 release published rounded values per unit. When
     * present for a unit, this overrides both percentage and multiplier.
     */
    boostedBuildTimes?: Record<string, number>;
    transformCost: { minerals: number; gas: number };
    /** Shared duration for Gateway ↔ Warp Gate transformations. */
    transformTime: number;
    warpInSec: number;
    /** Per-unit warpgate cooldowns. */
    cooldowns: Record<string, number>;
  };
}

export interface StartingConfig {
  workers: number;
  minerals: number;
  gas: number;
  /** Hard supply ceiling (200). */
  maxSupply: number;
  /** Town hall each race starts with. */
  townHall: Record<SimRace, string>;
  worker: Record<SimRace, string>;
  /** Extra starting units beyond town hall + workers (zerg Overlord). */
  extraUnits: Record<SimRace, Record<string, number>>;
  /** Larvae present at the starting hatchery. */
  startingLarvae: number;
}

export interface PatchProfile {
  id: string;
  label: string;
  starting: StartingConfig;
  economy: EconomyConfig;
  mechanics: MechanicsConfig;
  units: Record<string, UnitDef>;
  upgrades: Record<string, UpgradeDef>;
}

/**
 * On-disk patch file: either a complete base profile or a sparse delta
 * with `extends` naming its parent. Deltas deep-merge over the parent;
 * `null` leaves delete keys; arrays replace wholesale.
 */
export interface PatchProfileFile {
  id: string;
  label: string;
  extends?: string;
  starting?: DeepPartial<StartingConfig>;
  economy?: DeepPartial<EconomyConfig>;
  mechanics?: DeepPartial<MechanicsConfig>;
  units?: Record<string, DeepPartial<UnitDef> | null>;
  upgrades?: Record<string, DeepPartial<UpgradeDef> | null>;
}

export type DeepPartial<T> = T extends (infer E)[]
  ? E[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> | null }
    : T;
