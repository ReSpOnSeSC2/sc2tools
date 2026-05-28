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
  MATCHUPS,
  type MatchupConfig,
  type MatchupKey,
  type RandomizerBuild,
  type RandomizerConfig,
} from "./types";

export function emptyMatchupConfig(): MatchupConfig {
  return { enabled: false, useCustomWeights: false, builds: [] };
}

export function defaultRandomizerConfig(): RandomizerConfig {
  const matchups = {} as Record<MatchupKey, MatchupConfig>;
  for (const m of MATCHUPS) matchups[m] = emptyMatchupConfig();
  return { version: 1, matchups };
}

function sanitizeBuild(raw: unknown): RandomizerBuild | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id : "";
  const name = typeof r.name === "string" ? r.name.trim() : "";
  if (!id || !name) return null;
  const weightNum = Number(r.weight);
  return {
    id,
    name,
    race: coerceRace(r.race),
    source: r.source === "custom" ? "custom" : "catalog",
    weight: Number.isFinite(weightNum) && weightNum > 0 ? weightNum : 1,
  };
}

function sanitizeMatchup(raw: unknown): MatchupConfig {
  if (!raw || typeof raw !== "object") return emptyMatchupConfig();
  const r = raw as Record<string, unknown>;
  const builds = Array.isArray(r.builds)
    ? r.builds
        .map(sanitizeBuild)
        .filter((b): b is RandomizerBuild => b !== null)
    : [];
  // De-dupe by id, last write wins.
  const byId = new Map<string, RandomizerBuild>();
  for (const b of builds) byId.set(b.id, b);
  return {
    enabled: r.enabled === true,
    useCustomWeights: r.useCustomWeights === true,
    builds: [...byId.values()],
  };
}

/** Coerce an arbitrary persisted blob into a valid config. */
export function sanitizeRandomizerConfig(raw: unknown): RandomizerConfig {
  const cfg = defaultRandomizerConfig();
  if (!raw || typeof raw !== "object") return cfg;
  const matchups = (raw as Record<string, unknown>).matchups;
  if (!matchups || typeof matchups !== "object") return cfg;
  for (const m of MATCHUPS) {
    cfg.matchups[m] = sanitizeMatchup((matchups as Record<string, unknown>)[m]);
  }
  return cfg;
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

/** Count of matchups that will actually fire (enabled + non-empty). */
export function activeMatchupCount(cfg: RandomizerConfig): number {
  return MATCHUPS.reduce((n, m) => {
    const mc = cfg.matchups[m];
    return n + (mc.enabled && mc.builds.length > 0 ? 1 : 0);
  }, 0);
}
