/**
 * Randomizer config — defaults, sanitisation of the persisted blob, and
 * small pure helpers the settings UI uses to mutate a draft config.
 *
 * The config is stored under the `randomizer` preference type
 * (`/v1/me/preferences/randomizer`) and mirrored to the OBS overlay via
 * the `overlay:config` socket snapshot, so sanitisation has to be
 * defensive: anything off the wire is `unknown`.
 */
import { coerceRace } from "@/lib/race";
import {
  GATEWAY_UNIT_IDS,
  MATCHUPS,
  type GatewayCount,
  type GatewayUnitId,
  type MatchupConfig,
  type MatchupKey,
  type OpeningUnitsConfig,
  type RandomizerBuild,
  type RandomizerConfig,
  type WeightedGatewayUnit,
} from "./types";
import {
  defaultOpeningUnitsForBuild,
  isGatewayUnitId,
} from "./gatewayUnits";

export function emptyMatchupConfig(matchup?: MatchupKey): MatchupConfig {
  return {
    enabled: false,
    useCustomWeights: false,
    unitRandomizerEnabled: matchup?.startsWith("P") ?? false,
    builds: [],
  };
}

export const DEFAULT_SOUND = { enabled: true, volume: 0.6 } as const;

export function defaultRandomizerConfig(): RandomizerConfig {
  const matchups = {} as Record<MatchupKey, MatchupConfig>;
  for (const m of MATCHUPS) matchups[m] = emptyMatchupConfig(m);
  return { version: 2, matchups, sound: { ...DEFAULT_SOUND } };
}

function sanitizeBuild(
  raw: unknown,
  matchup: MatchupKey,
): RandomizerBuild | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id : "";
  const name = typeof r.name === "string" ? r.name.trim() : "";
  if (!id || !name) return null;
  const weightNum = Number(r.weight);
  const race = coerceRace(r.race);
  const build: RandomizerBuild = {
    id,
    name,
    race,
    source: r.source === "custom" ? "custom" : "catalog",
    weight: Number.isFinite(weightNum) && weightNum > 0 ? weightNum : 1,
  };
  // Version-1 builds did not carry this block. Give every persisted Protoss
  // build a safe inferred default while leaving other races ineligible.
  if (race === "Protoss") {
    build.openingUnits = sanitizeOpeningUnits(r.openingUnits, matchup, name);
  }
  return build;
}

function sanitizeOpeningUnits(
  raw: unknown,
  matchup: MatchupKey,
  buildName: string,
): OpeningUnitsConfig {
  const defaults = defaultOpeningUnitsForBuild(matchup, buildName);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return defaults;
  const r = raw as Record<string, unknown>;
  const gateCount: GatewayCount =
    r.gateCount === 1 || r.gateCount === 2
      ? r.gateCount
      : defaults.gateCount;

  const byId = new Map<GatewayUnitId, WeightedGatewayUnit>();
  if (Array.isArray(r.units)) {
    for (const rawUnit of r.units) {
      if (!rawUnit || typeof rawUnit !== "object" || Array.isArray(rawUnit)) {
        continue;
      }
      const unit = rawUnit as Record<string, unknown>;
      const rawId = typeof unit.id === "string" ? unit.id.toLowerCase() : unit.id;
      if (!isGatewayUnitId(rawId)) continue;
      const weight = Number(unit.weight);
      byId.set(rawId, {
        id: rawId,
        weight: Number.isFinite(weight) && weight >= 0 ? weight : 1,
      });
    }
  } else {
    for (const unit of defaults.units) byId.set(unit.id, unit);
  }

  return {
    gateCount,
    useCustomWeights: r.useCustomWeights === true,
    // Canonical order makes settings, probabilities, and seeded rolls stable
    // even if a hostile or old payload shuffled/duplicated entries.
    units: GATEWAY_UNIT_IDS.flatMap((id) => {
      const unit = byId.get(id);
      return unit ? [unit] : [];
    }),
  };
}

function sanitizeMatchup(raw: unknown, matchup: MatchupKey): MatchupConfig {
  if (!raw || typeof raw !== "object") return emptyMatchupConfig(matchup);
  const r = raw as Record<string, unknown>;
  const builds = Array.isArray(r.builds)
    ? r.builds
        .map((build) => sanitizeBuild(build, matchup))
        .filter((b): b is RandomizerBuild => b !== null)
    : [];
  // De-dupe by id, last write wins.
  const byId = new Map<string, RandomizerBuild>();
  for (const b of builds) byId.set(b.id, b);
  return {
    enabled: r.enabled === true,
    useCustomWeights: r.useCustomWeights === true,
    unitRandomizerEnabled:
      typeof r.unitRandomizerEnabled === "boolean"
        ? r.unitRandomizerEnabled
        : matchup.startsWith("P"),
    builds: [...byId.values()],
  };
}

/** Coerce an arbitrary persisted blob into a valid config. */
export function sanitizeRandomizerConfig(raw: unknown): RandomizerConfig {
  const cfg = defaultRandomizerConfig();
  if (!raw || typeof raw !== "object") return cfg;
  const obj = raw as Record<string, unknown>;
  cfg.sound = sanitizeSound(obj.sound);
  const matchups = obj.matchups;
  if (!matchups || typeof matchups !== "object") return cfg;
  for (const m of MATCHUPS) {
    cfg.matchups[m] = sanitizeMatchup(
      (matchups as Record<string, unknown>)[m],
      m,
    );
  }
  return cfg;
}

function sanitizeSound(raw: unknown): RandomizerConfig["sound"] {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_SOUND };
  const r = raw as Record<string, unknown>;
  const vol = Number(r.volume);
  return {
    enabled: r.enabled !== false,
    volume: Number.isFinite(vol) ? Math.max(0, Math.min(1, vol)) : DEFAULT_SOUND.volume,
  };
}

/** Replace one matchup's config, returning a new top-level config. */
export function withMatchup(
  cfg: RandomizerConfig,
  m: MatchupKey,
  next: MatchupConfig,
): RandomizerConfig {
  return { ...cfg, matchups: { ...cfg.matchups, [m]: next } };
}

/** Add or remove a build from a matchup's pool. */
export function toggleBuild(
  mc: MatchupConfig,
  build: RandomizerBuild,
  on: boolean,
): MatchupConfig {
  if (on) {
    if (mc.builds.some((b) => b.id === build.id)) return mc;
    return { ...mc, builds: [...mc.builds, { ...build, weight: 1 }] };
  }
  return { ...mc, builds: mc.builds.filter((b) => b.id !== build.id) };
}

/** Set a build's raw weight (clamped to >= 0). */
export function setBuildWeight(
  mc: MatchupConfig,
  id: string,
  weight: number,
): MatchupConfig {
  const w = Number.isFinite(weight) && weight > 0 ? weight : 0;
  return {
    ...mc,
    builds: mc.builds.map((b) => (b.id === id ? { ...b, weight: w } : b)),
  };
}

/** Enable/disable the second-stage unit roll for one matchup. */
export function setUnitRandomizerEnabled(
  mc: MatchupConfig,
  enabled: boolean,
): MatchupConfig {
  return { ...mc, unitRandomizerEnabled: enabled };
}

/** Replace one selected build's complete opening-unit settings. */
export function setBuildOpeningUnits(
  mc: MatchupConfig,
  buildId: string,
  openingUnits: OpeningUnitsConfig,
): MatchupConfig {
  return updateOpeningUnits(mc, buildId, () => openingUnits);
}

export function setOpeningUnitGateCount(
  mc: MatchupConfig,
  buildId: string,
  gateCount: GatewayCount,
): MatchupConfig {
  return updateOpeningUnits(mc, buildId, (current) => ({
    ...current,
    gateCount,
  }));
}

export function setOpeningUnitCustomWeights(
  mc: MatchupConfig,
  buildId: string,
  useCustomWeights: boolean,
): MatchupConfig {
  return updateOpeningUnits(mc, buildId, (current) => ({
    ...current,
    useCustomWeights,
  }));
}

/** Select/deselect a fixed Gateway unit for one build. */
export function toggleOpeningUnit(
  mc: MatchupConfig,
  buildId: string,
  unitId: GatewayUnitId,
  on: boolean,
): MatchupConfig {
  return updateOpeningUnits(mc, buildId, (current) => {
    const byId = new Map(current.units.map((unit) => [unit.id, unit]));
    if (on) {
      if (!byId.has(unitId)) byId.set(unitId, { id: unitId, weight: 1 });
    } else {
      byId.delete(unitId);
    }
    return {
      ...current,
      units: GATEWAY_UNIT_IDS.flatMap((id) => {
        const unit = byId.get(id);
        return unit ? [unit] : [];
      }),
    };
  });
}

export function setOpeningUnitWeight(
  mc: MatchupConfig,
  buildId: string,
  unitId: GatewayUnitId,
  weight: number,
): MatchupConfig {
  const nextWeight = Number.isFinite(weight) && weight >= 0 ? weight : 0;
  return updateOpeningUnits(mc, buildId, (current) => ({
    ...current,
    units: current.units.map((unit) =>
      unit.id === unitId ? { ...unit, weight: nextWeight } : unit,
    ),
  }));
}

function updateOpeningUnits(
  mc: MatchupConfig,
  buildId: string,
  update: (current: OpeningUnitsConfig) => OpeningUnitsConfig,
): MatchupConfig {
  let changed = false;
  const builds = mc.builds.map((build) => {
    if (build.id !== buildId || !build.openingUnits) return build;
    changed = true;
    return { ...build, openingUnits: update(build.openingUnits) };
  });
  return changed ? { ...mc, builds } : mc;
}

/** Count of matchups that will actually fire (enabled + non-empty). */
export function activeMatchupCount(cfg: RandomizerConfig): number {
  return MATCHUPS.reduce((n, m) => {
    const mc = cfg.matchups[m];
    return n + (mc.enabled && mc.builds.length > 0 ? 1 : 0);
  }, 0);
}
