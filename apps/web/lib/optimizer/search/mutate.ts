/**
 * Mutation operators over action sequences, plus a structural repair
 * pass. The simulator tolerates out-of-order tech (it waits, or marks
 * a step impossible) but repaired children waste fewer evaluations on
 * dead branches.
 */
import type { BuildAction, PatchProfile, SimRace } from "../types";
import { insertableActions } from "./seeds";

export type Rng = () => number;

/** Defense / supply / production structures it's normal to mass. */
const MASSABLE_STRUCTURES = new Set([
  "PhotonCannon",
  "ShieldBattery",
  "Bunker",
  "SpineCrawler",
  "SporeCrawler",
  "MissileTurret",
  "Gateway",
  "Barracks",
  "SupplyDepot",
  "Pylon",
]);

/** Structures where a second copy is plausible inside an opening. */
const DOUBLABLE_STRUCTURES = new Set([
  "Forge",
  "EvolutionChamber",
  "EngineeringBay",
  "Stargate",
  "RoboticsFacility",
  "Factory",
  "Starport",
  "BarracksTechLab",
  "BarracksReactor",
]);

/**
 * How many of a structure the repair pass tolerates in one opening.
 * Within a build-order horizon, a 4th nexus or 2nd cybernetics core
 * is money-dumping noise, not a plan — fitness float penalties alone
 * proved too weak to stop the search exploiting them.
 */
function structureCap(name: string, isTownHall: boolean | undefined): number {
  if (isTownHall) return 3;
  if (MASSABLE_STRUCTURES.has(name)) return 6;
  if (DOUBLABLE_STRUCTURES.has(name)) return 2;
  return 1;
}

function randInt(rng: Rng, maxExclusive: number): number {
  return Math.floor(rng() * maxExclusive);
}

function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[randInt(rng, items.length)];
}

export function cloneActions(actions: readonly BuildAction[]): BuildAction[] {
  return actions.map((a) => ({ ...a }));
}

/** Insert a random action at a random position (defense-weighted). */
function mutateInsert(
  actions: BuildAction[],
  race: SimRace,
  rng: Rng,
): BuildAction[] {
  const pool = insertableActions(race);
  const action = { ...pick(rng, pool) };
  const index = randInt(rng, actions.length + 1);
  const next = cloneActions(actions);
  next.splice(index, 0, action);
  return next;
}

function mutateDelete(actions: BuildAction[], rng: Rng): BuildAction[] {
  if (actions.length <= 2) return cloneActions(actions);
  const next = cloneActions(actions);
  next.splice(randInt(rng, next.length), 1);
  return next;
}

/** Move one action to a different position (retiming). */
function mutateMove(actions: BuildAction[], rng: Rng): BuildAction[] {
  if (actions.length < 2) return cloneActions(actions);
  const next = cloneActions(actions);
  const from = randInt(rng, next.length);
  const [moved] = next.splice(from, 1);
  const to = randInt(rng, next.length + 1);
  next.splice(to, 0, moved);
  return next;
}

function mutateSwapAdjacent(actions: BuildAction[], rng: Rng): BuildAction[] {
  if (actions.length < 2) return cloneActions(actions);
  const next = cloneActions(actions);
  const i = randInt(rng, next.length - 1);
  [next[i], next[i + 1]] = [next[i + 1], next[i]];
  return next;
}

/** Duplicate an army/defense action — "make another one of those". */
function mutateDuplicate(actions: BuildAction[], rng: Rng): BuildAction[] {
  if (actions.length === 0) return [];
  const next = cloneActions(actions);
  const i = randInt(rng, next.length);
  next.splice(i, 0, { ...next[i] });
  return next;
}

export function mutate(
  actions: readonly BuildAction[],
  race: SimRace,
  rng: Rng,
): BuildAction[] {
  const roll = rng();
  const base = cloneActions(actions);
  if (roll < 0.3) return mutateInsert(base, race, rng);
  if (roll < 0.5) return mutateDelete(base, rng);
  if (roll < 0.7) return mutateMove(base, rng);
  if (roll < 0.85) return mutateSwapAdjacent(base, rng);
  return mutateDuplicate(base, rng);
}

/** One-point crossover preserving relative order from each parent. */
export function crossover(
  a: readonly BuildAction[],
  b: readonly BuildAction[],
  rng: Rng,
): BuildAction[] {
  if (a.length === 0) return cloneActions(b);
  if (b.length === 0) return cloneActions(a);
  const cutA = randInt(rng, a.length + 1);
  const cutB = randInt(rng, b.length + 1);
  return [...cloneActions(a.slice(0, cutA)), ...cloneActions(b.slice(cutB))];
}

/**
 * Structural repair:
 *  1. inject missing tech ancestors before their dependents
 *  2. drop duplicate one-off structures/research the sim would reject
 *  3. cap action count (search shouldn't grow unbounded tails)
 */
export function repair(
  actions: readonly BuildAction[],
  profile: PatchProfile,
  race: SimRace,
  maxLength: number,
): BuildAction[] {
  const out: BuildAction[] = [];
  const seenStructures = new Map<string, number>();
  const seenResearch = new Set<string>();
  const present = new Set<string>();
  const workerName = profile.starting.worker[race];
  // You start with one town hall; each extra one unlocks two more
  // geysers. Without this cap the search drifts into gas-collector
  // spam (cheap, no fitness upside, hard for mutation to clean up).
  let townHalls = 1;
  let gasBuildings = 0;

  const ensurePrereqs = (name: string, depth: number) => {
    if (depth > 6) return;
    const def = profile.units[name] ?? null;
    const upgrade = profile.upgrades[name] ?? null;
    const requires = def?.requires ?? upgrade?.requires ?? [];
    const producers = def
      ? def.builtFrom.filter((b) => b !== "Larva" && b !== workerName)
      : (upgrade?.researchedAt ?? []);
    for (const entry of [...requires, ...producers]) {
      const alternatives = entry.split("|");
      if (alternatives.some((alt) => present.has(alt))) continue;
      const target = alternatives[0];
      const targetDef = profile.units[target];
      if (!targetDef || !targetDef.isStructure) continue;
      ensurePrereqs(target, depth + 1);
      if (!present.has(target)) {
        out.push({ kind: "build", name: target });
        present.add(target);
        seenStructures.set(target, 1);
      }
    }
  };

  for (const action of actions) {
    if (out.length >= maxLength) break;
    if (action.kind === "research") {
      if (seenResearch.has(action.name)) continue;
      ensurePrereqs(action.name, 0);
      seenResearch.add(action.name);
      out.push({ ...action });
      present.add(action.name);
      continue;
    }
    const def = profile.units[action.name];
    if (def?.isGasBuilding) {
      if (gasBuildings >= 2 * townHalls) continue;
      gasBuildings += 1;
    } else if (def?.isStructure) {
      const cap = structureCap(action.name, def.isTownHall);
      const seen = seenStructures.get(action.name) ?? 0;
      if (seen >= cap) continue;
      seenStructures.set(action.name, seen + 1);
      if (def.isTownHall) townHalls += 1;
    }
    if (def) ensurePrereqs(action.name, 0);
    out.push({ ...action });
    present.add(action.name);
  }
  return out.slice(0, maxLength);
}
