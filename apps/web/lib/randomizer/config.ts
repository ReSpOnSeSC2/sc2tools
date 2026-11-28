/**
 * Randomizer config — defaults, sanitisation of the persisted blob, and
 * small pure helpers the settings UI uses to mutate a draft config.
 *
 * The config is stored under the `randomizer` preference type
 * (`/v1/me/preferences/randomizer`) and mirrored to the OBS overlay via
 * the `overlay:config` snapshot, so sanitisation has to be
 * defensive: anything off the wire is `unknown`.
 *
 * Version 3 made "Draw a build order" (`enabled`) and "Draw opening units"
 * (`unitRandomizerEnabled`) independent switches. Before it, units only
 * followed a drawn Protoss build, so an older blob reads its unit switch as
 * on only when its build draw is on in a Protoss matchup: every stored
 * config keeps its meaning. The desktop agent reads the blob the same way
 * (`apps/agent/sc2tools_agent/build_checkin/randomizer_draw.py`), pinned
 * by `__tests__/unitDrawParity.json`.
 */
import { coerceRace } from "@/lib/race";
import {
  MATCHUPS,
  OPENING_UNIT_IDS,
  isOpeningUnitId,
  playedRace,
  type GatewayCount,
  type MatchupConfig,
  type MatchupKey,
  type OpeningUnitId,
  type OpeningUnitsConfig,
  type PlayedRace,
  type RandomizerBuild,
  type RandomizerConfig,
  type WeightedOpeningUnit,
} from "./types";
import { defaultGatewayUnits, inferGatewayCount } from "./gatewayUnits";

/** Both draws off: a matchup draws nothing until the streamer turns one on. */
export function emptyMatchupConfig(): MatchupConfig {
  return {
    enabled: false,
    useCustomWeights: false,
    unitRandomizerEnabled: false,
    builds: [],
  };
}

export const DEFAULT_SOUND = { enabled: true, volume: 0.6 } as const;

export function defaultRandomizerConfig(): RandomizerConfig {
  const matchups = {} as Record<MatchupKey, MatchupConfig>;
  for (const m of MATCHUPS) matchups[m] = emptyMatchupConfig();
  return { version: 3, matchups, sound: { ...DEFAULT_SOUND } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
    weight: Number.isFinite(weightNum) && weightNum >= 0 ? weightNum : 1,
  };
  const openingUnits = race === playedRace(matchup)
    ? sanitizeBuildUnits(r.openingUnits, matchup, name)
    : undefined;
  if (openingUnits) build.openingUnits = openingUnits;
  return build;
}

/**
 * A pool entry's own unit draw. Version-1 Protoss builds did not carry one,
 * so every Protoss entry gets the Gateway default its name implies; a
 * Terran or Zerg entry without one draws with its matchup's `units`.
 */
function sanitizeBuildUnits(
  raw: unknown,
  matchup: MatchupKey,
  buildName: string,
): OpeningUnitsConfig | undefined {
  const race = playedRace(matchup);
  if (race === "Protoss") {
    return sanitizeOpeningUnits(raw, race, defaultGatewayUnits(inferGatewayCount(matchup, buildName)));
  }
  return isRecord(raw) ? sanitizeOpeningUnits(raw, race, noUnits(matchup)) : undefined;
}

/** The matchup's own unit draw; absent until the streamer sets it up. */
function sanitizeMatchupUnits(raw: unknown, matchup: MatchupKey): OpeningUnitsConfig | undefined {
  if (!isRecord(raw)) return undefined;
  const race = playedRace(matchup);
  const fallback = race === "Protoss" ? defaultGatewayUnits(inferGatewayCount(matchup, "")) : noUnits(matchup);
  return sanitizeOpeningUnits(raw, race, fallback);
}

function noUnits(matchup: MatchupKey): OpeningUnitsConfig {
  return { gateCount: inferGatewayCount(matchup, ""), useCustomWeights: false, units: [] };
}

function sanitizeOpeningUnits(
  raw: unknown,
  race: PlayedRace,
  defaults: OpeningUnitsConfig,
): OpeningUnitsConfig {
  if (!isRecord(raw)) return defaults;
  const gateCount: GatewayCount =
    raw.gateCount === 1 || raw.gateCount === 2 ? raw.gateCount : defaults.gateCount;
  const byId = Array.isArray(raw.units)
    ? unitWeights(raw.units, race)
    : new Map(defaults.units.map((unit) => [unit.id, unit]));
  return {
    gateCount,
    useCustomWeights: raw.useCustomWeights === true,
    // Canonical order makes settings, probabilities, and seeded rolls stable
    // even if a hostile or old payload shuffled/duplicated entries.
    units: inCanonicalOrder(byId, race),
  };
}

/** Each valid unit of `race` with its weight; a later duplicate wins. */
function unitWeights(rawUnits: unknown[], race: PlayedRace): Map<OpeningUnitId, WeightedOpeningUnit> {
  const byId = new Map<OpeningUnitId, WeightedOpeningUnit>();
  for (const rawUnit of rawUnits) {
    if (!isRecord(rawUnit)) continue;
    const rawId = typeof rawUnit.id === "string" ? rawUnit.id.toLowerCase() : rawUnit.id;
    if (!isOpeningUnitId(rawId, race)) continue;
    const weight = Number(rawUnit.weight);
    byId.set(rawId, { id: rawId, weight: Number.isFinite(weight) && weight >= 0 ? weight : 1 });
  }
  return byId;
}

function inCanonicalOrder(
  byId: ReadonlyMap<OpeningUnitId, WeightedOpeningUnit>,
  race: PlayedRace,
): WeightedOpeningUnit[] {
  return OPENING_UNIT_IDS[race].flatMap((id) => {
    const unit = byId.get(id);
    return unit ? [unit] : [];
  });
}

/** Before version 3, units only followed a drawn Protoss build. */
function legacyUnitSwitch(r: Record<string, unknown>, matchup: MatchupKey, enabled: boolean): boolean {
  if (!enabled || playedRace(matchup) !== "Protoss") return false;
  return typeof r.unitRandomizerEnabled === "boolean" ? r.unitRandomizerEnabled : true;
}

function sanitizeMatchup(raw: unknown, matchup: MatchupKey, independent: boolean): MatchupConfig {
  if (!raw || typeof raw !== "object") return emptyMatchupConfig();
  const r = raw as Record<string, unknown>;
  const builds = Array.isArray(r.builds)
    ? r.builds
        .map((build) => sanitizeBuild(build, matchup))
        .filter((b): b is RandomizerBuild => b !== null)
    : [];
  // De-dupe by id, last write wins.
  const byId = new Map<string, RandomizerBuild>();
  for (const b of builds) byId.set(b.id, b);
  const enabled = r.enabled === true;
  const units = sanitizeMatchupUnits(r.units, matchup);
  return {
    enabled,
    useCustomWeights: r.useCustomWeights === true,
    unitRandomizerEnabled: independent
      ? r.unitRandomizerEnabled === true
      : legacyUnitSwitch(r, matchup, enabled),
    builds: [...byId.values()],
    ...(units ? { units } : {}),
  };
}

/** Coerce an arbitrary persisted blob into a valid config. */
export function sanitizeRandomizerConfig(raw: unknown): RandomizerConfig {
  const cfg = defaultRandomizerConfig();
  if (!raw || typeof raw !== "object") return cfg;
  const obj = raw as Record<string, unknown>;
  cfg.sound = sanitizeSound(obj.sound);
  cfg.rollOnDesktop = obj.rollOnDesktop === true;
  const matchups = obj.matchups;
  if (!matchups || typeof matchups !== "object") return cfg;
  const independent = obj.version === 3;
  for (const m of MATCHUPS) {
    cfg.matchups[m] = sanitizeMatchup(
      (matchups as Record<string, unknown>)[m],
      m,
      independent,
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

/** Replace one selected build's complete opening-unit settings. */
export function setBuildOpeningUnits(
  mc: MatchupConfig,
  buildId: string,
  openingUnits: OpeningUnitsConfig,
): MatchupConfig {
  let changed = false;
  const builds = mc.builds.map((build) => {
    if (build.id !== buildId) return build;
    changed = true;
    return { ...build, openingUnits };
  });
  return changed ? { ...mc, builds } : mc;
}

/** Select or deselect one unit, keeping `race`'s canonical order. */
export function withUnitSelected(
  opening: OpeningUnitsConfig,
  race: PlayedRace,
  unitId: OpeningUnitId,
  on: boolean,
): OpeningUnitsConfig {
  const byId = new Map(opening.units.map((unit) => [unit.id, unit]));
  if (on && !byId.has(unitId)) byId.set(unitId, { id: unitId, weight: 1 });
  if (!on) byId.delete(unitId);
  return { ...opening, units: inCanonicalOrder(byId, race) };
}

export function withUnitWeight(
  opening: OpeningUnitsConfig,
  unitId: OpeningUnitId,
  weight: number,
): OpeningUnitsConfig {
  const nextWeight = Number.isFinite(weight) && weight >= 0 ? weight : 0;
  return {
    ...opening,
    units: opening.units.map((unit) =>
      unit.id === unitId ? { ...unit, weight: nextWeight } : unit,
    ),
  };
}

/** What a matchup draws: a build, opening units, both, or neither. */
export function matchupDraws(mc: MatchupConfig): { build: boolean; units: boolean } {
  const build = mc.enabled && mc.builds.length > 0;
  // With a build, units follow it (its own settings, else the matchup's);
  // with the build draw off they come from the matchup's own settings.
  const units = mc.unitRandomizerEnabled && (build || (!mc.enabled && (mc.units?.units.length ?? 0) > 0));
  return { build, units };
}

/** Count of matchups that will actually draw something. */
export function activeMatchupCount(cfg: RandomizerConfig): number {
  return MATCHUPS.reduce((n, m) => {
    const draws = matchupDraws(cfg.matchups[m]);
    return n + (draws.build || draws.units ? 1 : 0);
  }, 0);
}
