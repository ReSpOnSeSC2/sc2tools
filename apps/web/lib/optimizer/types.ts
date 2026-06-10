/**
 * Shared types for the build-order optimizer.
 *
 * Everything the engine consumes is data-driven: a {@link PatchProfile}
 * carries every game constant (costs, build times, supply, income-model
 * rates, race mechanics) so a future balance patch is a JSON delta, not
 * a code change. See lib/optimizer/data/patches/.
 */

export type SimRace = "Protoss" | "Terran" | "Zerg";

/* ------------------------------------------------------------------ */
/* Patch profile                                                       */
/* ------------------------------------------------------------------ */

export interface CombatStats {
  hp: number;
  shields?: number;
  /** Sustained DPS vs ground targets (Liquipedia values). */
  dpsGround?: number;
  /** Sustained DPS vs air targets. */
  dpsAir?: number;
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
     * Gateway production speed multiplier once research completes
     * (5.0.16: 1.35 — gateways produce 35% faster).
     */
    gatewaySpeedMultiplier: number;
    transformCost: { minerals: number; gas: number };
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

/* ------------------------------------------------------------------ */
/* Build actions & simulation                                          */
/* ------------------------------------------------------------------ */

export type BuildActionKind =
  | "build" // structure (worker-built; zerg drone consumed)
  | "train" // unit from structure or larva
  | "research" // upgrade
  | "morph" // unit/structure morph (Lair, Baneling, Overseer, Orbital…)
  | "chrono" // spend nexus energy on a producer/structure name
  | "transform-warpgate"; // convert one gateway to a warpgate

export interface BuildAction {
  kind: BuildActionKind;
  /** Canonical PascalCase unit / structure / upgrade name. */
  name: string;
  /** Chrono target structure name (kind === "chrono"). */
  target?: string;
}

export interface MacroPolicies {
  /** Keep training workers whenever idle town-hall capacity allows. */
  autoWorkers: boolean;
  /** Auto-build supply when projected to block within this many seconds. 0 = off. */
  autoSupplyLeadSec: number;
  /** Spend nexus energy automatically on the newest producer. */
  autoChrono: "off" | "production" | "economy";
  /** Drop MULEs whenever orbital energy ≥ cost. */
  autoMule: boolean;
  /** Queens auto-inject their hatchery whenever energy allows. */
  autoInject: boolean;
  /** Saturate new geysers to 3 workers automatically. */
  autoSaturateGas: boolean;
}

export interface SimEvent {
  time: number;
  kind:
    | "start"
    | "complete"
    | "supply-blocked"
    | "chrono"
    | "mule"
    | "inject"
    | "warning";
  name: string;
  /** Supply used at event time (the "14" in "14 Pylon"). */
  supplyUsed: number;
  detail?: string;
}

export interface BuildOrderStep {
  /** Supply used when the step started — classic build-order stamp. */
  supply: number;
  name: string;
  kind: BuildActionKind;
  startSec: number;
  doneSec: number;
}

export interface EconomySample {
  time: number;
  minerals: number;
  gas: number;
  mineralRate: number;
  gasRate: number;
  workers: number;
  supplyUsed: number;
  supplyCap: number;
}

export interface SimUnitCount {
  completed: number;
  inProgress: number;
}

export interface SimResult {
  profileId: string;
  race: SimRace;
  steps: BuildOrderStep[];
  events: SimEvent[];
  samples: EconomySample[];
  /** Final wall-clock second simulated. */
  endTime: number;
  finalMinerals: number;
  finalGas: number;
  finalWorkers: number;
  finalSupplyUsed: number;
  finalSupplyCap: number;
  /** Completed unit counts at end of sim. */
  unitsAtEnd: Record<string, number>;
  /** Completion timeline: name → sorted completion seconds. */
  completionTimes: Record<string, number[]>;
  /** Total seconds spent supply-blocked (fitness penalty input). */
  supplyBlockedSec: number;
  /** Actions that never became feasible within the horizon. */
  unexecutedActions: number;
}

export interface SimOptions {
  /** Hard stop for the simulation clock (seconds). */
  horizonSec: number;
  policies: MacroPolicies;
}

/* ------------------------------------------------------------------ */
/* Threats, scouting, safety                                           */
/* ------------------------------------------------------------------ */

export interface ScoutingTell {
  id: string;
  /** Human description shown as a checklist item ("Pool by 0:45"). */
  observation: string;
  /** Optional [from, to] window (sec) when this tell is observable. */
  windowSec?: [number, number];
  /** Evidence weight in [0, 1]; negative tells use `contradicts`. */
  weight: number;
  /** When true, observing this tell argues AGAINST the threat. */
  contradicts?: boolean;
}

export interface ThreatWave {
  timeSec: number;
  /** Attacking units arriving at this time, name → count. */
  units: Record<string, number>;
}

export interface Threat {
  id: string;
  attackerRace: SimRace;
  /** Defender races this threat applies to. */
  vsDefender: SimRace[];
  name: string;
  description: string;
  earliestArrivalSec: number;
  scoutingTells: ScoutingTell[];
  waves: ThreatWave[];
  dangerWindows: { fromSec: number; toSec: number; note: string }[];
  defenderHints: {
    wallRecommended?: boolean;
    workerPullViable?: boolean;
  };
  /** Baseline probability before any scouting info (meta frequency). */
  priorProbability: number;
}

export interface ScoutingObservation {
  tellId: string;
  /** When the observation was made, seconds. */
  atSec: number;
}

export interface ThreatAssessment {
  threatId: string;
  probability: number;
  /** True when probability clears the active-threat threshold. */
  active: boolean;
  matchedTells: string[];
  contradictedTells: string[];
}

export type SafetyVerdict = "safe" | "risky" | "unsafe";

export interface WaveReport {
  timeSec: number;
  attackPower: number;
  defensePower: number;
  /** (defense − attack) / max(attack, 1). */
  margin: number;
  verdict: SafetyVerdict;
  /** Defender units counted, name → count. */
  defenders: Record<string, number>;
  /** The constraint that decides the verdict, human-readable. */
  bindingNote?: string;
}

export interface ThreatSafetyReport {
  threatId: string;
  threatName: string;
  probability: number;
  verdict: SafetyVerdict;
  worstMargin: number;
  waves: WaveReport[];
}

export interface SafetyReport {
  overall: SafetyVerdict;
  threats: ThreatSafetyReport[];
}

export interface SafetyOptions {
  /** Defender walled off (boosts defense vs melee-only waves). */
  hasWall: boolean;
  /** Allow worker-pull contribution where the threat hints it's viable. */
  allowWorkerPull: boolean;
}

/* ------------------------------------------------------------------ */
/* Build adaptation                                                    */
/* ------------------------------------------------------------------ */

/** A known-good 12-worker opener shipped with the app. */
export interface ReferenceBuild {
  id: string;
  name: string;
  race: SimRace;
  /** Matchup labels this opener is played in ("PvZ", "TvT", …). */
  matchups: string[];
  description: string;
  /** Ordered building/unit/upgrade names (no workers, no supply). */
  steps: string[];
}

/** One step's timing on the old patch vs the adapted patch. */
export interface ComparisonRow {
  name: string;
  kind: BuildActionKind;
  baselineSupply?: number;
  baselineStartSec?: number;
  adaptedSupply?: number;
  adaptedStartSec?: number;
  /** adapted − baseline start (positive = later on the new patch). */
  deltaSec?: number;
}

export interface AdaptRequest {
  /** Patch the reference build was designed for. */
  baselineProfileId: string;
  /** Patch to adapt to. */
  profileId: string;
  race: SimRace;
  actions: BuildAction[];
  referenceName: string;
  referenceId?: string;
  threats: { threat: Threat; probability: number }[];
  policies: MacroPolicies;
  safety: SafetyOptions;
  horizonSec: number;
}

export interface AdaptResult {
  referenceName: string;
  referenceId?: string;
  actions: BuildAction[];
  baselineProfileId: string;
  profileId: string;
  /** The build re-timed on the target patch. */
  sim: SimResult;
  /** The same build on its original patch, for comparison. */
  baselineSim: SimResult;
  safety: SafetyReport;
  comparison: ComparisonRow[];
  /** Reference entries that didn't resolve to known units/upgrades. */
  unknownNames: string[];
}
