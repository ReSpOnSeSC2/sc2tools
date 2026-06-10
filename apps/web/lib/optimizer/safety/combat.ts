/**
 * Heuristic combat scoring for safety evaluation.
 *
 * Each unit gets a Lanchester-flavored value sqrt(dps × effectiveHP)
 * from the patch profile's combat stats, masked by what it can
 * actually shoot (a zealot contributes nothing against an oracle).
 * Static defense gets a positional multiplier, bunkers boost the
 * infantry inside them, and shield batteries scale the whole defense.
 *
 * This is a planning estimate, not a battle simulator — it has no
 * positioning, micro, or splash. Tests pin its direction (more/less
 * safe), never exact values, so the constants below can be tuned
 * without breaking the suite.
 */
import type { CombatStats, PatchProfile } from "../types";

/** Defending from behind your own wall / on creep / at the ramp. */
export const STATIC_DEFENSE_MULTIPLIER = 1.5;
/** Workers fight at a fraction of their stats (they trade mining, die fast). */
export const WORKER_PULL_EFFICIENCY = 0.35;
/** Max workers that can usefully surround an early attack. */
export const WORKER_PULL_CAP = 8;
/** Defense multiplier of a wall-off vs melee-only attacking waves. */
export const WALL_VS_MELEE_MULTIPLIER = 1.3;
/** Each shield battery adds 15% to total defense, two add 25%. */
export const BATTERY_MULTIPLIERS = [1, 1.15, 1.25];
/** Units finishing within this window after a wave still half-count. */
export const GRACE_WINDOW_SEC = 10;
export const GRACE_WEIGHT = 0.5;

export type CombatRole = "attacker" | "defender";

export interface UnitContribution {
  name: string;
  count: number;
  value: number;
}

function effectiveHp(stats: CombatStats): number {
  return stats.hp + (stats.shields ?? 0);
}

/**
 * Value of one unit against a target domain. `vsAir` / `vsGround`
 * describe what it must be able to hit to contribute.
 */
export function unitCombatValue(
  profile: PatchProfile,
  name: string,
  opts: { needsAntiAir: boolean; needsAntiGround: boolean },
): number {
  const stats = profile.units[name]?.combat;
  if (!stats) return 0;
  let dps = 0;
  if (opts.needsAntiGround) dps = Math.max(dps, stats.dpsGround ?? 0);
  if (opts.needsAntiAir) dps = Math.max(dps, stats.dpsAir ?? 0);
  if (dps <= 0) return 0;
  return Math.sqrt(dps * effectiveHp(stats));
}

/** True when every unit in the wave is a melee ground unit. */
export function waveIsMeleeOnly(
  profile: PatchProfile,
  wave: Record<string, number>,
): boolean {
  const MELEE = new Set(["Zergling", "Zealot", "Baneling", "Ultralisk"]);
  let any = false;
  for (const [name, count] of Object.entries(wave)) {
    if (count <= 0) continue;
    any = true;
    const stats = profile.units[name]?.combat;
    if (stats?.isFlying) return false;
    // workers tag along in some all-ins and count as melee
    if (!MELEE.has(name) && !profile.units[name]?.isWorker) return false;
  }
  return any;
}

/** True when any unit in the wave flies (defense needs anti-air). */
export function waveHasAir(
  profile: PatchProfile,
  wave: Record<string, number>,
): boolean {
  return Object.entries(wave).some(
    ([name, count]) => count > 0 && profile.units[name]?.combat?.isFlying,
  );
}

/** Attacker power of a wave (cumulative waves are summed by the caller). */
export function attackPower(
  profile: PatchProfile,
  wave: Record<string, number>,
): number {
  let total = 0;
  for (const [name, count] of Object.entries(wave)) {
    if (count <= 0) continue;
    const def = profile.units[name];
    const stats = def?.combat;
    if (!stats) continue;
    const value = unitCombatValue(profile, name, {
      needsAntiAir: false,
      needsAntiGround: true,
    });
    // attacking workers fight at reduced efficiency too
    total += (def.isWorker ? value * WORKER_PULL_EFFICIENCY : value) * count;
  }
  return total;
}

export interface DefenseInput {
  /** Completed defender units at the wave time, name → count. */
  completed: Record<string, number>;
  /** Units completing within the grace window, name → count. */
  inGrace: Record<string, number>;
  /** Mineral-line workers available for a pull. */
  workers: number;
  hasWall: boolean;
  allowWorkerPull: boolean;
  /** Wave being defended (drives air/melee masks). */
  wave: Record<string, number>;
}

export interface DefenseBreakdown {
  total: number;
  contributions: UnitContribution[];
  workerPullValue: number;
  wallApplied: boolean;
  batteryMultiplier: number;
}

export function defensePower(
  profile: PatchProfile,
  input: DefenseInput,
): DefenseBreakdown {
  const airWave = waveHasAir(profile, input.wave);
  const opts = { needsAntiAir: airWave, needsAntiGround: !airWave };
  const contributions: UnitContribution[] = [];
  let bunkeredInfantryBonus = 0;
  let batteries = 0;
  let total = 0;

  const addGroup = (units: Record<string, number>, weight: number) => {
    for (const [name, count] of Object.entries(units)) {
      if (count <= 0) continue;
      const def = profile.units[name];
      if (!def?.combat || def.isWorker) continue;
      if (name === "ShieldBattery") {
        batteries += count;
        continue;
      }
      let value = unitCombatValue(profile, name, opts) * count * weight;
      if (def.combat.isStatic && value > 0) {
        value *= STATIC_DEFENSE_MULTIPLIER;
      }
      const garrison = def.combat.garrison;
      if (garrison && !airWave) {
        // bunker itself doesn't shoot; it boosts infantry below
        bunkeredInfantryBonus += garrison.capacity * (garrison.multiplier - 1);
      }
      if (value > 0) {
        contributions.push({ name, count, value });
        total += value;
      }
    }
  };
  addGroup(input.completed, 1);
  addGroup(input.inGrace, GRACE_WEIGHT);

  // Bunker garrison: boost up to `capacity` marines-worth of the
  // cheapest infantry value present.
  if (bunkeredInfantryBonus > 0) {
    const marineValue = unitCombatValue(profile, "Marine", opts);
    const marines = input.completed.Marine ?? 0;
    const boosted = Math.min(marines, bunkeredInfantryBonus);
    total += boosted * marineValue * 0.75;
  }

  let workerPullValue = 0;
  if (input.allowWorkerPull && !airWave && input.workers > 0) {
    const pulled = Math.min(input.workers, WORKER_PULL_CAP);
    // any worker type — use the defender's own worker stats via the
    // strongest of the three (they're nearly identical)
    const workerValue = Math.max(
      unitCombatValue(profile, "Probe", opts),
      unitCombatValue(profile, "SCV", opts),
      unitCombatValue(profile, "Drone", opts),
    );
    workerPullValue = pulled * workerValue * WORKER_PULL_EFFICIENCY;
    total += workerPullValue;
  }

  let wallApplied = false;
  if (input.hasWall && waveIsMeleeOnly(profile, input.wave)) {
    total *= WALL_VS_MELEE_MULTIPLIER;
    wallApplied = true;
  }

  const batteryMultiplier =
    BATTERY_MULTIPLIERS[Math.min(batteries, BATTERY_MULTIPLIERS.length - 1)];
  total *= batteryMultiplier;

  return { total, contributions, workerPullValue, wallApplied, batteryMultiplier };
}
