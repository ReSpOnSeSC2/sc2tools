/** Public fixture summaries only; original identities never belong in this DTO. */
import { INSTANT_ENGINE_VERSION } from "./engineVersion";
import type { InstantPayload } from "./reportPayload";

export const SAMPLE_SCHEMA_VERSION = 1;
export const SAMPLE_MAX_GAMES = 4;
export const SAMPLE_MAX_BYTES = 1_500_000;
const MAX_LOG_ROWS = 8192, MAX_STATS_ROWS = 4096;
const RACES = ["Protoss", "Terran", "Zerg", "Random"];
const RESULTS = ["Victory", "Defeat", "Tie"];
const LEAK_NAMES = ["Supply Blocked", "Inject Efficiency", "Chrono Efficiency", "MULE Efficiency", "Mineral Float"];
const RAW_KEYS = ["sq", "base_score", "supply_block_penalty", "race_penalty", "float_penalty", "injects_actual", "injects_expected", "chronos_actual", "chronos_expected", "mules_actual", "mules_expected", "supply_blocked_seconds", "mineral_float_spikes", "creep_tumors_queen", "creep_tumors_spread", "creep_tumors_total", "creep_tumors_lost", "first_tumor_sec"] as const;
const STATS_KEYS = ["time", "food_used", "food_made", "food_workers", "minerals_collection_rate", "vespene_collection_rate", "minerals_current", "vespene_current", "minerals_used_in_progress", "vespene_used_in_progress", "army_value"] as const;
type Json = Record<string, unknown>;
type Numbers = Record<string, number>;
interface SampleStats extends Numbers { time: number }
interface SampleLeak { name: string; penalty?: number; mineral_cost?: number; time?: number }
interface SampleMacro { raw?: Numbers; top_3_leaks?: SampleLeak[]; all_leaks?: SampleLeak[]; stats_events?: SampleStats[]; opp_stats_events?: SampleStats[] }
export interface SampleGame {
  date: string;
  result: string;
  myRace: string | null;
  map: string | null;
  durationSec: number;
  myBuild: string | null;
  macroScore: number | null;
  gameVersion: string | null;
  gameBuild: number | null;
  opponent: { race: string | null; strategy: string | null };
  buildLog: string[];
  oppBuildLog: string[];
  macroBreakdown: SampleMacro | null;
}
export interface SampleReportMetadata {
  schemaVersion: typeof SAMPLE_SCHEMA_VERSION;
  engineVersion: string;
  engineBundleId: string;
  engineSourceHash: string;
}
export interface SampleReportDocument extends SampleReportMetadata { games: SampleGame[] }
export interface SampleReportData { metadata: SampleReportMetadata; payloads: InstantPayload[] }

function record(value: unknown): Json | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : null; }
function number(value: unknown, max = 1_000_000_000): number | null { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? value : null; }
function label(value: unknown, max = 160): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f<>\\/]/.test(value) ? value : null;
}
function race(value: unknown): string | null { return typeof value === "string" && RACES.includes(value) ? value : null; }
function numbers(value: unknown, keys: readonly string[]): Numbers {
  const source = record(value) ?? {}, out: Numbers = {};
  for (const key of keys) { const n = number(source[key]); if (n !== null) out[key] = n; }
  return out;
}
function logs(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_LOG_ROWS) return null;
  // Canonical recorded unit/structure/upgrade tokens; no free-form copy.
  return value.filter((line): line is string => typeof line === "string" && line.length <= 90 && /^\[\d{1,4}:[0-5]\d\] [A-Za-z][A-Za-z0-9]{0,79}$/.test(line) && !/^\[\d+:[0-5]\d\] (Beacon|Reward|Spray)/.test(line));
}
function macro(value: unknown): SampleMacro | null {
  const source = record(value); if (!source) return null;
  const out: SampleMacro = {};
  if (record(source.raw)) out.raw = numbers(source.raw, RAW_KEYS);
  for (const key of ["top_3_leaks", "all_leaks"] as const) {
    if (!Array.isArray(source[key]) || source[key].length > 8) continue;
    out[key] = source[key].flatMap((item: unknown) => {
      const row = record(item); if (!row || typeof row.name !== "string" || !LEAK_NAMES.includes(row.name)) return [];
      return [{ name: row.name, ...numbers(row, ["penalty", "mineral_cost", "time"]) }];
    });
  }
  for (const key of ["stats_events", "opp_stats_events"] as const) {
    if (!Array.isArray(source[key]) || source[key].length > MAX_STATS_ROWS) continue;
    out[key] = source[key].flatMap((item: unknown) => {
      const row = numbers(item, STATS_KEYS); return row.time === undefined ? [] : [{ ...row, time: row.time }];
    });
  }
  return out;
}

/** Explicit allowlist, never a deep clone/redact of the engine's upload object. */
export function projectSampleGame(value: unknown): SampleGame | null {
  const raw = record(value); if (!raw) return null;
  const date = typeof raw.date === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(raw.date) && Number.isFinite(Date.parse(raw.date)) ? raw.date : null;
  const duration = number(raw.durationSec, 86_400);
  if (!date || duration === null || duration <= 0 || typeof raw.result !== "string" || !RESULTS.includes(raw.result)) return null;
  const buildLog = logs(raw.buildLog), oppBuildLog = logs(raw.oppBuildLog);
  if (!buildLog || !oppBuildLog) return null;
  const opp = record(raw.opponent) ?? {};
  const result: SampleGame = {
    date, result: raw.result, myRace: race(raw.myRace), map: label(raw.map, 100), durationSec: duration,
    myBuild: label(raw.myBuild), macroScore: number(raw.macroScore, 100),
    gameVersion: typeof raw.gameVersion === "string" && /^\d+\.\d+\.\d+(?:\.\d+)?$/.test(raw.gameVersion) && raw.gameVersion.length <= 32 ? raw.gameVersion : null,
    gameBuild: Number.isInteger(raw.gameBuild) ? number(raw.gameBuild, 10_000_000) : null,
    opponent: { race: race(opp.race), strategy: label(opp.strategy) },
    buildLog, oppBuildLog, macroBreakdown: macro(raw.macroBreakdown),
  };
  const stats = record(record(raw.macroBreakdown)?.player_stats);
  const identities = [raw.gameId, raw.myToonHandle, raw.myName, raw.userId, raw.fileName, raw.relativePath,
    opp.displayName, opp.toonHandle, opp.pulseId, opp.pulseCharacterId, record(stats?.me)?.name, record(stats?.opponent)?.name];
  const serialized = JSON.stringify(result);
  if (identities.some(identity => typeof identity === "string" && identity.length >= 3 && serialized.includes(identity))) return null;
  return result;
}

/** Reject extra/malformed fields as well as stale versions and same-version bundles. */
export function readSampleReport(value: unknown, currentBundleId: string): SampleReportData | null {
  const doc = record(value);
  if (!doc || doc.schemaVersion !== SAMPLE_SCHEMA_VERSION || doc.engineVersion !== INSTANT_ENGINE_VERSION
    || !/^[a-f0-9]{16}$/.test(currentBundleId) || doc.engineBundleId !== currentBundleId
    || typeof doc.engineSourceHash !== "string" || !/^[a-f0-9]{64}$/.test(doc.engineSourceHash)
    || Object.keys(doc).some(key => !["schemaVersion", "engineVersion", "engineBundleId", "engineSourceHash", "games"].includes(key))
    || !Array.isArray(doc.games) || doc.games.length < 1 || doc.games.length > SAMPLE_MAX_GAMES) return null;
  const payloads: InstantPayload[] = [];
  for (const [index, game] of doc.games.entries()) {
    const projected = projectSampleGame(game);
    // Equivalent canonical objects only. Order is irrelevant; projection must
    // not repair a published sample by silently dropping private/invalid data.
    if (!projected || !sameJson(game, projected)) return null;
    payloads.push({ ...projected, gameId: `sample-${index + 1}`, myMmr: null, myMmrSource: null,
      myToonHandle: null, myLadderRace: null, isLadderGame: null, apmCurve: null,
      opponent: { ...projected.opponent, displayName: null, toonHandle: null, pulseId: null, mmr: null, mmrSource: null } });
  }
  // Only serialize after canonical bounded shapes are established.
  let bytes: number; try { bytes = new TextEncoder().encode(JSON.stringify(doc)).length; } catch { return null; }
  if (bytes > SAMPLE_MAX_BYTES) return null;
  const metadata: SampleReportMetadata = { schemaVersion: SAMPLE_SCHEMA_VERSION, engineVersion: INSTANT_ENGINE_VERSION,
    engineBundleId: currentBundleId, engineSourceHash: doc.engineSourceHash };
  return { metadata, payloads };
}
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => sameJson(value, b[i]));
  const left = record(a), right = record(b); if (!left || !right) return false;
  const keys = Object.keys(left); return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && sameJson(left[key], right[key]));
}
