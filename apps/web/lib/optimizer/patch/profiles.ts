/**
 * Patch-profile registry and layering.
 *
 * Profiles ship as JSON under data/patches/. A profile either stands
 * alone (the lotv-base dataset) or names a parent via `extends` and
 * carries only the fields that changed — so adapting to a new balance
 * patch means adding one small delta file and registering it here.
 *
 * Merge semantics (applied leaf-by-leaf):
 *   - objects deep-merge, delta keys win
 *   - `null` deletes the key (removes a unit/upgrade from the game)
 *   - arrays replace wholesale (a delta can't append to `requires`)
 */
import lotvBase from "../data/patches/lotv-base.json";
import patch5016 from "../data/patches/patch-5-0-16.json";
import patch5016a from "../data/patches/patch-5-0-16a.json";
import patch5016b from "../data/patches/patch-5-0-16b.json";
import type {
  PatchProfile,
  PatchProfileFile,
  UnitDef,
  UpgradeDef,
} from "../types";

const REGISTRY: Record<string, PatchProfileFile> = {
  [lotvBase.id]: lotvBase as PatchProfileFile,
  [patch5016.id]: patch5016 as PatchProfileFile,
  [patch5016a.id]: patch5016a as PatchProfileFile,
  [patch5016b.id]: patch5016b as PatchProfileFile,
};

/** Profile the UI selects by default — the live balance patch. */
export const DEFAULT_PROFILE_ID = "5.0.16b";

export interface ProfileSummary {
  id: string;
  label: string;
  extends?: string;
}

export function listProfiles(): ProfileSummary[] {
  return Object.values(REGISTRY).map((p) => ({
    id: p.id,
    label: p.label,
    extends: p.extends,
  }));
}

type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

/**
 * Deep-merge `delta` over `base` without mutating either. `null`
 * delta leaves delete; arrays and scalars replace.
 */
export function mergeLayer(base: unknown, delta: unknown): unknown {
  if (delta === undefined) return clone(base);
  if (delta === null) return undefined;
  if (isPlainObject(base) && isPlainObject(delta)) {
    const out: JsonObject = {};
    for (const key of Object.keys(base)) {
      if (key in delta) continue;
      out[key] = clone(base[key]);
    }
    for (const key of Object.keys(delta)) {
      const merged = mergeLayer(base[key], delta[key]);
      if (merged !== undefined) out[key] = merged;
    }
    return out;
  }
  return clone(delta);
}

function clone<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Walk the extends chain root-first. Throws on unknown ids / cycles. */
function layerChain(id: string): PatchProfileFile[] {
  const chain: PatchProfileFile[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined = id;
  while (cursor) {
    if (seen.has(cursor)) {
      throw new Error(`Patch profile cycle detected at "${cursor}"`);
    }
    seen.add(cursor);
    const file: PatchProfileFile | undefined = REGISTRY[cursor];
    if (!file) throw new Error(`Unknown patch profile "${cursor}"`);
    chain.unshift(file);
    cursor = file.extends;
  }
  return chain;
}

/**
 * Resolve a profile id into a complete, validated {@link PatchProfile}.
 * An optional user delta (edited in the UI) is applied last with the
 * same merge semantics as a patch file.
 */
export function resolveProfile(
  id: string,
  userDelta?: Partial<PatchProfileFile>,
): PatchProfile {
  const chain = layerChain(id);
  let merged: unknown = {};
  for (const layer of chain) {
    const { extends: _ext, ...rest } = layer;
    merged = mergeLayer(merged, rest);
  }
  if (userDelta) {
    const { extends: _ext, id: _id, ...rest } = userDelta;
    merged = mergeLayer(merged, rest);
  }
  const profile = merged as PatchProfile;
  validateProfile(profile);
  return profile;
}

/**
 * Structural sanity: every producer / prerequisite / morph reference
 * must resolve to a known unit or upgrade, and core sections must be
 * present. Throws with a precise message — a bad data edit should
 * fail loudly at load, not mid-simulation.
 */
export function validateProfile(profile: PatchProfile): void {
  const problems: string[] = [];
  if (!profile.starting || !profile.economy || !profile.mechanics) {
    throw new Error(
      `Patch profile "${profile.id ?? "?"}" is missing starting/economy/mechanics sections`,
    );
  }
  const units = profile.units ?? {};
  const upgrades = profile.upgrades ?? {};
  const known = new Set<string>([
    ...Object.keys(units),
    ...Object.keys(upgrades),
    "Larva",
  ]);
  const checkRef = (owner: string, ref: string, where: string) => {
    const ok = ref.split("|").every((alt) => known.has(alt));
    if (!ok) problems.push(`${owner}: ${where} references unknown "${ref}"`);
  };
  for (const [name, def] of Object.entries(units)) {
    checkUnit(name, def, checkRef, problems);
  }
  for (const [name, def] of Object.entries(upgrades)) {
    for (const at of def.researchedAt) checkRef(name, at, "researchedAt");
    for (const req of def.requires ?? []) checkRef(name, req, "requires");
  }
  for (const race of ["Protoss", "Terran", "Zerg"] as const) {
    const th = profile.starting.townHall[race];
    const worker = profile.starting.worker[race];
    if (!units[th]) problems.push(`starting.townHall.${race} "${th}" unknown`);
    if (!units[worker]) {
      problems.push(`starting.worker.${race} "${worker}" unknown`);
    }
  }
  for (const wgUnit of Object.keys(profile.mechanics.warpgate.cooldowns)) {
    if (!units[wgUnit]) {
      problems.push(`warpgate cooldown references unknown "${wgUnit}"`);
    }
  }
  const trainTimeReduction =
    profile.mechanics.warpgate.gatewayTrainTimeReduction;
  if (
    trainTimeReduction !== undefined &&
    (trainTimeReduction < 0 || trainTimeReduction >= 1)
  ) {
    problems.push(
      "warpgate.gatewayTrainTimeReduction must be at least 0 and less than 1",
    );
  }
  if (profile.mechanics.warpgate.transformTime <= 0) {
    problems.push("warpgate.transformTime must be positive");
  }
  if (problems.length > 0) {
    throw new Error(
      `Patch profile "${profile.id}" failed validation:\n  ${problems.join("\n  ")}`,
    );
  }
}

function checkUnit(
  name: string,
  def: UnitDef,
  checkRef: (owner: string, ref: string, where: string) => void,
  problems: string[],
): void {
  for (const from of def.builtFrom) checkRef(name, from, "builtFrom");
  for (const req of def.requires ?? []) checkRef(name, req, "requires");
  if (def.morphFrom) checkRef(name, def.morphFrom, "morphFrom");
  if (def.minerals < 0 || def.gas < 0 || def.buildTime <= 0) {
    problems.push(`${name}: non-positive cost or build time`);
  }
}

/** Convenience lookups used across the engine. */
export function unitDef(profile: PatchProfile, name: string): UnitDef {
  const def = profile.units[name];
  if (!def) throw new Error(`Unknown unit "${name}" in profile ${profile.id}`);
  return def;
}

export function upgradeDef(profile: PatchProfile, name: string): UpgradeDef {
  const def = profile.upgrades[name];
  if (!def) {
    throw new Error(`Unknown upgrade "${name}" in profile ${profile.id}`);
  }
  return def;
}
