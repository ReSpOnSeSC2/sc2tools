/**
 * Narrow a parsed-game JSON string (the exact payload the engine
 * produced for upload) into the typed subset the /try report reads.
 *
 * The payload crosses a trust boundary (IndexedDB, a Web Worker, a
 * future engine version), so every field is checked; anything missing
 * or malformed becomes null and the matching report card hides itself.
 * `macroBreakdown` is narrowed to a `MacroBreakdownData`-compatible
 * shape (without the envelope fields the API adds: ok, macro_score,
 * race, game_length_sec), and `apmCurve` to the `ApmCurveResponse`
 * fields `lib/apm.ts` reads.
 *
 * Example:
 *   const payload = parseInstantPayload(parsedGame.json);
 *   if (payload) games.push(payload);
 */
import type {
  BreakdownRaw,
  ChronoTarget,
  LeakItem,
  MacroBreakdownData,
  PlayerStats,
  PlayerStatsRecord,
  ProductionBuildingRecord,
  StatsEvent,
  SupplyBlockWindow,
  UnitTimelineEntry,
} from "@/components/analyzer/macro/MacroBreakdownPanel.types";
import type { ApmCurveResponse } from "@/lib/apm";

export interface InstantOpponent {
  displayName: string | null;
  race: string | null;
  toonHandle: string | null;
  pulseId: string | null;
  mmr: number | null;
  /** Where `mmr` came from ("replay" = the replay's pre-game value). */
  mmrSource: string | null;
  strategy: string | null;
}

/** `macroBreakdown` as stored on the payload (no API envelope fields). */
export type InstantMacroBreakdown = Omit<
  MacroBreakdownData,
  "ok" | "macro_score" | "race" | "game_length_sec"
>;

export interface InstantPayload {
  gameId: string;
  date: string;
  result: string;
  myRace: string | null;
  map: string | null;
  durationSec: number | null;
  myBuild: string | null;
  macroScore: number | null;
  myMmr: number | null;
  /** Where `myMmr` came from ("replay" = the replay's pre-game value). */
  myMmrSource: string | null;
  myToonHandle: string | null;
  /** The race you queued as (the ladder queue), e.g. "Random". */
  myLadderRace: string | null;
  /** True for ranked 1v1 ladder games; null when the payload does not say. */
  isLadderGame: boolean | null;
  /** Replay release string ("5.0.16.97425") and numeric client build;
   *  they pick the patch era that prices units (`patchEraForGame`). */
  gameVersion: string | null;
  gameBuild: number | null;
  opponent: InstantOpponent | null;
  macroBreakdown: InstantMacroBreakdown | null;
  buildLog: string[];
  oppBuildLog: string[];
  /** The APM curve, in the shape GET /v1/games/:id/apm-curve serves. */
  apmCurve: ApmCurveResponse | null;
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function records(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Copy the listed numeric fields that are finite numbers. */
function copyNumbers<K extends string>(
  source: Json,
  keys: ReadonlyArray<K>,
  target: Partial<Record<K, number | null>>,
): void {
  for (const key of keys) {
    const value = num(source[key]);
    if (value !== null) target[key] = value;
  }
}

const RAW_NUMBER_KEYS = [
  "sq", "base_score", "supply_block_penalty", "race_penalty", "float_penalty",
  "injects_actual", "injects_expected", "chronos_actual", "chronos_expected",
  "mules_actual", "mules_expected", "supply_blocked_seconds", "mineral_float_spikes",
  "creep_tumors_queen", "creep_tumors_spread", "creep_tumors_total", "creep_tumors_lost",
  "first_tumor_sec",
] as const satisfies ReadonlyArray<keyof BreakdownRaw>;

const STATS_NUMBER_KEYS = [
  "food_used", "food_made", "food_workers", "minerals_collection_rate",
  "vespene_collection_rate", "minerals_current", "vespene_current",
  "minerals_used_in_progress", "vespene_used_in_progress", "army_value",
] as const satisfies ReadonlyArray<keyof StatsEvent>;

const LEAK_NUMBER_KEYS = ["penalty", "mineral_cost", "time"] as const satisfies ReadonlyArray<
  keyof LeakItem
>;

const PLAYER_STAT_NUMBER_KEYS = [
  "pid", "mmr", "apm", "spm", "spq", "supply_blocked_seconds", "units_produced",
  "units_killed", "units_lost", "workers_built", "structures_built", "structures_killed",
  "structures_lost",
] as const satisfies ReadonlyArray<keyof PlayerStatsRecord>;

function toWindow(value: Json): SupplyBlockWindow | null {
  const start = num(value.start);
  const end = num(value.end);
  if (start === null || end === null) return null;
  const window: SupplyBlockWindow = { start, end };
  const blocked = num(value.blocked_sec);
  if (blocked !== null) window.blocked_sec = blocked;
  if (typeof value.kind === "string") window.kind = value.kind;
  return window;
}

function toWindows(value: unknown): SupplyBlockWindow[] {
  return records(value).flatMap((item) => toWindow(item) ?? []);
}

function toChronoTarget(value: Json): ChronoTarget | null {
  const count = num(value.count);
  if (count === null) return null;
  const target: ChronoTarget = { count };
  if (typeof value.name === "string") target.name = value.name;
  if (typeof value.building_name === "string") target.building_name = value.building_name;
  return target;
}

function toRaw(value: unknown): BreakdownRaw | undefined {
  if (!isRecord(value)) return undefined;
  const raw: BreakdownRaw = {};
  copyNumbers(value, RAW_NUMBER_KEYS, raw);
  if (Array.isArray(value.supply_block_windows)) {
    raw.supply_block_windows = toWindows(value.supply_block_windows);
  }
  if (Array.isArray(value.opp_supply_block_windows)) {
    raw.opp_supply_block_windows = toWindows(value.opp_supply_block_windows);
  }
  if (Array.isArray(value.chrono_targets)) {
    raw.chrono_targets = records(value.chrono_targets).flatMap((item) => toChronoTarget(item) ?? []);
  }
  return raw;
}

function toLeak(value: Json): LeakItem {
  const leak: LeakItem = {};
  if (typeof value.name === "string") leak.name = value.name;
  if (typeof value.detail === "string") leak.detail = value.detail;
  copyNumbers(value, LEAK_NUMBER_KEYS, leak);
  return leak;
}

function toStatsEvents(value: unknown): StatsEvent[] {
  return records(value).flatMap((item) => {
    const time = num(item.time);
    if (time === null) return [];
    const event: StatsEvent = { time };
    copyNumbers(item, STATS_NUMBER_KEYS, event);
    return [event];
  });
}

function toCountMap(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [key, count] of Object.entries(value)) {
    const n = num(count);
    if (n !== null) out[key] = n;
  }
  return out;
}

function toUnitTimeline(value: unknown): UnitTimelineEntry[] {
  return records(value).flatMap((item) => {
    const time = num(item.time);
    if (time === null) return [];
    const entry: UnitTimelineEntry = { time };
    const my = toCountMap(item.my);
    const opp = toCountMap(item.opp);
    if (my) entry.my = my;
    if (opp) entry.opp = opp;
    return [entry];
  });
}

function toBuildings(value: unknown): ProductionBuildingRecord[] {
  return records(value).flatMap((item) => {
    const born = num(item.born_time);
    const died = num(item.died_time);
    if (typeof item.name !== "string" || born === null || died === null) return [];
    const record: ProductionBuildingRecord = { name: item.name, born_time: born, died_time: died };
    const unitId = num(item.unit_id);
    if (unitId !== null) record.unit_id = unitId;
    if (typeof item.destroyed === "boolean") record.destroyed = item.destroyed;
    return [record];
  });
}

function toPlayerStatsRecord(value: unknown): PlayerStatsRecord | null {
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.is_me !== "boolean") {
    return null;
  }
  const record: PlayerStatsRecord = { name: value.name, is_me: value.is_me };
  if (typeof value.race === "string") record.race = value.race;
  copyNumbers(value, PLAYER_STAT_NUMBER_KEYS, record);
  return record;
}

function toPlayerStats(value: unknown): PlayerStats | null {
  if (!isRecord(value)) return null;
  return { me: toPlayerStatsRecord(value.me), opponent: toPlayerStatsRecord(value.opponent) };
}

/** Optional array fields: absent stays absent (charts show empty states). */
function setIfArray<K extends keyof InstantMacroBreakdown>(
  target: InstantMacroBreakdown,
  key: K,
  source: unknown,
  convert: (value: unknown) => NonNullable<InstantMacroBreakdown[K]>,
): void {
  if (Array.isArray(source)) target[key] = convert(source);
}

function toMacroBreakdown(value: unknown): InstantMacroBreakdown | null {
  if (!isRecord(value)) return null;
  const out: InstantMacroBreakdown = {};
  const raw = toRaw(value.raw);
  if (raw) out.raw = raw;
  const leaks = (items: unknown) => records(items).map(toLeak);
  setIfArray(out, "all_leaks", value.all_leaks, leaks);
  setIfArray(out, "top_3_leaks", value.top_3_leaks, leaks);
  setIfArray(out, "stats_events", value.stats_events, toStatsEvents);
  setIfArray(out, "opp_stats_events", value.opp_stats_events, toStatsEvents);
  setIfArray(out, "unit_timeline", value.unit_timeline, toUnitTimeline);
  setIfArray(out, "production_buildings", value.production_buildings, toBuildings);
  setIfArray(out, "opp_production_buildings", value.opp_production_buildings, toBuildings);
  const playerStats = toPlayerStats(value.player_stats);
  if (playerStats) out.player_stats = playerStats;
  return out;
}

type ApmPlayer = NonNullable<ApmCurveResponse["players"]>[number];
type ApmPoint = NonNullable<ApmPlayer["samples"]>[number];

function toApmSample(value: Json): ApmPoint {
  const sample: ApmPoint = {};
  copyNumbers(value, ["t", "apm", "spm"], sample);
  return sample;
}

function toApmPlayer(value: Json): ApmPlayer {
  const player: ApmPlayer = { samples: records(value.samples).map(toApmSample) };
  copyNumbers(value, ["pid", "avg_apm"], player);
  if (typeof value.is_me === "boolean") player.is_me = value.is_me;
  return player;
}

/**
 * The curve as GET /v1/games/:id/apm-curve would serve it (the API adds
 * `game_length_sec` from `durationSec`); `readGameApm` does the rest of
 * the trust checks (version, is_me, finite samples).
 */
function toApmCurve(value: unknown, durationSec: number | null): ApmCurveResponse | null {
  if (!isRecord(value)) return null;
  const curve: ApmCurveResponse = {
    has_data: value.has_data === true,
    players: records(value.players).map(toApmPlayer),
  };
  copyNumbers(value, ["v", "window_sec"], curve);
  if (durationSec !== null) curve.game_length_sec = durationSec;
  return curve;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function toOpponent(value: unknown): InstantOpponent | null {
  if (!isRecord(value)) return null;
  return {
    displayName: str(value.displayName),
    race: str(value.race),
    toonHandle: str(value.toonHandle),
    pulseId: str(value.pulseId),
    mmr: num(value.mmr),
    mmrSource: str(value.mmrSource),
    strategy: str(value.strategy),
  };
}

/**
 * Parse one game JSON string; null when it is not JSON or lacks the
 * fields every game must have (gameId, date, result).
 *
 * Example:
 *   parseInstantPayload('{"gameId":"g","date":"2026-05-08T19:08:12Z","result":"Victory"}')?.result;
 *   // -> "Victory"
 */
export function parseInstantPayload(json: string): InstantPayload | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    // Not JSON: the caller treats the game as unusable for the report.
    return null;
  }
  if (!isRecord(value)) return null;
  const gameId = str(value.gameId);
  const date = str(value.date);
  const result = str(value.result);
  if (!gameId || !date || !result) return null;
  const durationSec = num(value.durationSec);
  return {
    gameId,
    date,
    result,
    myRace: str(value.myRace),
    map: str(value.map),
    durationSec,
    myBuild: str(value.myBuild),
    macroScore: num(value.macroScore),
    myMmr: num(value.myMmr),
    myMmrSource: str(value.myMmrSource),
    myToonHandle: str(value.myToonHandle),
    myLadderRace: str(value.myLadderRace),
    isLadderGame: bool(value.isLadderGame),
    gameVersion: str(value.gameVersion),
    gameBuild: num(value.gameBuild),
    opponent: toOpponent(value.opponent),
    macroBreakdown: toMacroBreakdown(value.macroBreakdown),
    buildLog: strings(value.buildLog),
    oppBuildLog: strings(value.oppBuildLog),
    apmCurve: toApmCurve(value.apmCurve, durationSec),
  };
}
