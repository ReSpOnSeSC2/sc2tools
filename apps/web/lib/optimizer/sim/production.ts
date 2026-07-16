/**
 * Production-side state: producer instances (structures that train,
 * research, morph, or warp), addon attachment, prerequisite checks,
 * and the chrono-boost time math.
 */
import type { PatchProfile, UnitDef } from "../types";

export type AddonKind = "techlab" | "reactor" | null;

export interface Producer {
  id: number;
  /** Structure name ("Gateway", "Barracks", "Hatchery", …). */
  name: string;
  /** Completion time; producers under construction can't work. */
  readyAt: number;
  /** Busy with primary queue (train/research/morph/transform). */
  busyUntil: number;
  /** Reactor side-slot busy time (terran). */
  reactorBusyUntil: number;
  addon: AddonKind;
  isWarpgate: boolean;
  /** This Gateway has paid its one-time Warp Gate transformation fee. */
  warpgateTransformPaid: boolean;
  /** Chrono boost window end (0 when never boosted). */
  chronoUntil: number;
  /** Base this producer mines/injects for (town halls only). */
  baseId: number | null;
}

export interface LarvaPool {
  /** Producer id of the owning hatchery/lair/hive. */
  hatchId: number;
  larvae: number;
  /** Next natural larva spawn time (Infinity while at cap). */
  nextNaturalAt: number;
  /** Pending inject landing times, sorted ascending. */
  pendingInjects: number[];
}

export interface Caster {
  /** "Nexus" | "OrbitalCommand" | "Queen". */
  kind: string;
  /** Producer id for nexus/orbital; hatch producer id for queens. */
  attachedTo: number | null;
  energy: number;
  lastUpdated: number;
}

/** Lazily regenerate a caster's energy up to `now`. */
export function updateEnergy(
  caster: Caster,
  now: number,
  regenPerSec: number,
  maxEnergy: number,
): void {
  if (now <= caster.lastUpdated) return;
  caster.energy = Math.min(
    maxEnergy,
    caster.energy + regenPerSec * (now - caster.lastUpdated),
  );
  caster.lastUpdated = now;
}

/** Time at which `caster` reaches `threshold` energy (≥ now). */
export function energyReadyAt(
  caster: Caster,
  now: number,
  threshold: number,
  regenPerSec: number,
): number {
  updateEnergy(caster, now, regenPerSec, Infinity);
  if (caster.energy >= threshold) return now;
  return now + (threshold - caster.energy) / regenPerSec;
}

/**
 * Tech prerequisite check. Entries support "|" alternatives and may
 * name structures (need one completed) or upgrades (need researched).
 */
export function prereqsMet(
  requires: string[] | undefined,
  completedUnits: ReadonlyMap<string, number>,
  upgradesDone: ReadonlySet<string>,
): boolean {
  if (!requires || requires.length === 0) return true;
  return requires.every((entry) =>
    entry
      .split("|")
      .some(
        (alt) => (completedUnits.get(alt) ?? 0) > 0 || upgradesDone.has(alt),
      ),
  );
}

/**
 * Pick the producer that can start training `unit` the soonest.
 * Considers: completion, addon requirement, reactor parallel slot
 * (units that don't need a techlab can use the reactor side), and
 * current busy windows. Returns null when no candidate exists at all
 * (e.g. no such structure yet).
 */
export function pickProducer(
  producers: Producer[],
  def: UnitDef,
  now: number,
): { producer: Producer; startAt: number; viaReactor: boolean } | null {
  let best: { producer: Producer; startAt: number; viaReactor: boolean } | null =
    null;
  for (const producer of producers) {
    if (!def.builtFrom.includes(producer.name)) continue;
    if (def.requiresAddon && producer.addon !== "techlab") continue;
    const candidates: { startAt: number; viaReactor: boolean }[] = [
      { startAt: Math.max(now, producer.readyAt, producer.busyUntil), viaReactor: false },
    ];
    if (producer.addon === "reactor" && !def.requiresAddon) {
      candidates.push({
        startAt: Math.max(now, producer.readyAt, producer.reactorBusyUntil),
        viaReactor: true,
      });
    }
    for (const candidate of candidates) {
      if (!best || candidate.startAt < best.startAt) {
        best = { producer, ...candidate };
      }
    }
  }
  return best;
}

/**
 * Completion time for work of `duration` started at `start` on a
 * producer whose chrono window ends at `chronoUntil`, with boosted
 * speed `mult` (1.5). Work inside the window progresses mult× faster.
 */
export function completionWithChrono(
  start: number,
  duration: number,
  chronoUntil: number,
  mult: number,
): number {
  if (chronoUntil <= start || mult <= 1) return start + duration;
  const boostedSpan = chronoUntil - start;
  const workDoneBoosted = boostedSpan * mult;
  if (workDoneBoosted >= duration) return start + duration / mult;
  return chronoUntil + (duration - workDoneBoosted);
}

/**
 * Apply a fresh chrono at `now` to a producer mid-task: shorten the
 * remaining work and extend the producer's chrono window.
 */
export function applyChronoToTask(
  now: number,
  currentCompletion: number,
  chronoDuration: number,
  mult: number,
): number {
  const remaining = currentCompletion - now;
  if (remaining <= 0) return currentCompletion;
  const boostedSpan = chronoDuration;
  const workDoneBoosted = boostedSpan * mult;
  if (workDoneBoosted >= remaining) return now + remaining / mult;
  return now + boostedSpan + (remaining - workDoneBoosted);
}
