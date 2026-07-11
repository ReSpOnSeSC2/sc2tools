/**
 * lossAutopsy — a pure, deterministic "why you lost" rules engine.
 *
 * Turns ONE lost game's client-side payloads into a ranked recap of
 * the top macro causes, each with a quantified plain-English sentence
 * and game-clock timestamps. No LLM, no network, no randomness — the
 * whole thing is a pure function of its inputs so repeated renders
 * (and tests) always produce identical output.
 *
 * Data sources (all already fetched by existing analyzer surfaces):
 *
 *   - `MacroBreakdownData` from GET /v1/games/:gameId/macro-breakdown
 *     (see MacroBreakdownPanel.types.ts). The engine consumes:
 *       raw.supply_block_windows[].{start,end,blocked_sec}
 *       raw.supply_blocked_seconds
 *       raw.mineral_float_spikes
 *       raw.{injects,chronos,mules}_{actual,expected}
 *       stats_events[].{time,minerals_current,army_value}
 *       opp_stats_events[].{time,army_value}
 *       all_leaks[] / top_3_leaks[] — the REAL leak names emitted by
 *       analytics/macro_score.py: "Supply Blocked", "Mineral Float",
 *       "Inject Efficiency", "Chrono Efficiency", "MULE Efficiency"
 *       (used only to price causes in minerals via `mineral_cost`).
 *
 *   - `buildLog` string lines in the `[m:ss] Name` shape (same format
 *     `buildLogToEvents` in lib/build-events.ts parses).
 *
 *   - `ProfileGame` row metadata (result / game_length / id) from
 *     Last5GamesTimeline.tsx.
 *
 * Template sentences: each rule carries 2-3 handwritten variants and
 * picks one via `fnv1a(gameId) % variants.length`, so different games
 * read differently but the same game always renders the same sentence.
 */

import type { ProfileGame } from "@/components/analyzer/Last5GamesTimeline";
import type {
  EffectiveRace,
  LeakItem,
  MacroBreakdownData,
  StatsEvent,
} from "@/components/analyzer/macro/MacroBreakdownPanel.types";
import { computeEffectiveRace, formatGameClock } from "@/lib/macro";

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

export type AutopsyCause = {
  /** Stable rule id: "supply_block" | "resource_float" | "late_expansion"
   *  | "production_idle" | "one_sided_fight". */
  id: string;
  /** Short human title for the cause card header. */
  title: string;
  /** One complete plain-English sentence with the numbers baked in. */
  detail: string;
  /** 0-100, normalized per rule (formula documented at each rule). */
  severityScore: number;
  /** Game-clock strings ("m:ss") anchoring the cause, when derivable. */
  timestamps: string[];
};

/** Townhall internal names as they appear in `[m:ss] Name` build logs. */
export type TownhallName = "Hatchery" | "Nexus" | "CommandCenter";

export interface PersonalMedians {
  /**
   * The player's median NATURAL-EXPANSION start time in seconds, keyed
   * by townhall name. Compatible with the profile payload's
   * `medianTimingsLegacy` (MedianTimingsGrid TimingInfo): pass
   * `timings["Hatchery"].medianSeconds` etc. Absent → the
   * late-expansion rule is skipped entirely.
   */
  expansionTimings?: Partial<Record<TownhallName, number | null>>;
}

/**
 * One lost game, assembled from payloads the SPA already has client-
 * side. All fields optional — each rule degrades or skips when its
 * inputs are missing.
 */
export interface AutopsyGame extends ProfileGame {
  /** Full or slim macro breakdown for this game. */
  macroBreakdown?: MacroBreakdownData | null;
  /** Raw `[m:ss] Name` build-log lines for the local player. */
  buildLog?: ReadonlyArray<string> | null;
}

export interface LossAutopsyInput {
  game: AutopsyGame;
  personalMedians?: PersonalMedians;
}

// ---------------------------------------------------------------------------
// Tunables (thresholds mirror analytics/macro_score.py where noted).
// ---------------------------------------------------------------------------

const MAX_CAUSES = 3;

/** Below this many blocked seconds a supply block is noise, not a cause. */
const SUPPLY_BLOCK_MIN_SEC = 10;
/** Blocked seconds that saturate the severity score at 100. */
const SUPPLY_BLOCK_FULL_SEC = 75;
/** ~One production cycle in seconds — used for the "cycles lost" copy. */
const PRODUCTION_CYCLE_SEC = 30;

/** Float is only judged after 4:00, mirroring MINERAL_FLOAT_SPIKE_AFTER_SEC. */
const FLOAT_WINDOW_START_SEC = 240;
/** Per-sample spike threshold, mirroring MINERAL_FLOAT_SPIKE_THRESHOLD. */
const FLOAT_SPIKE_MINERALS = 800;
/** Mean bank at/below this earns severity 0; see formula at the rule. */
const FLOAT_MEAN_BASELINE = 400;
/** Mean bank at/above this earns severity 100. */
const FLOAT_MEAN_FULL = 1600;
/** Minimum post-4:00 samples before the stats path is trusted. */
const FLOAT_MIN_SAMPLES = 3;

/** Expansion delays under this many seconds are not reported. */
const EXPANSION_MIN_DELAY_SEC = 20;
/** Delay that saturates the severity score at 100. */
const EXPANSION_FULL_DELAY_SEC = 120;
/** A townhall logged at/below this time is the STARTING base, not an
 *  expansion (some build logs include the starting townhall at 0:00). */
const STARTING_TOWNHALL_MAX_SEC = 10;

/** Don't judge inject/chrono/MULE usage on tiny expected counts. */
const MECHANIC_MIN_EXPECTED = 5;
/** actual/expected at/above this ratio is fine — rule stays silent. */
const MECHANIC_OK_RATIO = 0.85;

/** Max window (seconds) an army-value drop is considered one fight. */
const FIGHT_WINDOW_SEC = 45;
/** Minimum own army value lost for a fight to register. */
const FIGHT_MIN_MY_LOSS = 400;
/** Fight is "one-sided" when the opponent lost at most this fraction. */
const FIGHT_ONE_SIDED_RATIO = 0.6;
/** Net value swing that saturates the severity score at 100. */
const FIGHT_FULL_NET_LOSS = 2500;

/** Real leak names emitted by analytics/macro_score.py — do not invent. */
const LEAK_SUPPLY_BLOCKED = "Supply Blocked";
const LEAK_MINERAL_FLOAT = "Mineral Float";
const LEAK_BY_RACE: Record<EffectiveRace, string> = {
  Zerg: "Inject Efficiency",
  Protoss: "Chrono Efficiency",
  Terran: "MULE Efficiency",
};

// ---------------------------------------------------------------------------
// Deterministic template selection.
// ---------------------------------------------------------------------------

/**
 * FNV-1a 32-bit hash. Exported so tests (and future callers) can
 * predict which template variant a given gameId selects.
 */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function pickVariant<F>(
  variants: ReadonlyArray<(facts: F) => string>,
  hash: number,
  facts: F,
): string {
  return variants[hash % variants.length](facts);
}

// ---------------------------------------------------------------------------
// Small shared helpers.
// ---------------------------------------------------------------------------

function isLossResult(result: string | null | undefined): boolean {
  return result === "Loss" || result === "Defeat";
}

function clamp01to100(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function findLeak(
  breakdown: MacroBreakdownData | null | undefined,
  name: string,
): LeakItem | null {
  const pools: ReadonlyArray<LeakItem[] | undefined> = [
    breakdown?.all_leaks,
    breakdown?.top_3_leaks,
  ];
  for (const pool of pools) {
    if (!Array.isArray(pool)) continue;
    const hit = pool.find((leak) => leak?.name === name);
    if (hit) return hit;
  }
  return null;
}

/** Parsed `[m:ss] Name` build-log line. */
interface BuildLogEntry {
  time: number;
  name: string;
}

/** Parse `[m:ss] Name` lines (same regex as buildLogToEvents). */
function parseBuildLog(
  lines: ReadonlyArray<string> | null | undefined,
): BuildLogEntry[] {
  if (!Array.isArray(lines)) return [];
  const out: BuildLogEntry[] = [];
  for (const line of lines) {
    const m = /^\[(\d+):(\d{2})\]\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const minutes = parseInt(m[1], 10);
    const seconds = parseInt(m[2], 10);
    if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) continue;
    out.push({ time: minutes * 60 + seconds, name: m[3] });
  }
  return out;
}

const TOWNHALL_BY_KEY: Record<string, TownhallName> = {
  hatchery: "Hatchery",
  nexus: "Nexus",
  commandcenter: "CommandCenter",
};

const TOWNHALL_BY_RACE: Record<EffectiveRace, TownhallName> = {
  Zerg: "Hatchery",
  Protoss: "Nexus",
  Terran: "CommandCenter",
};

const TOWNHALL_DISPLAY: Record<TownhallName, string> = {
  Hatchery: "Hatchery",
  Nexus: "Nexus",
  CommandCenter: "Command Center",
};

function townhallOf(rawName: string): TownhallName | null {
  const key = rawName.replace(/[\s_-]+/g, "").toLowerCase();
  return TOWNHALL_BY_KEY[key] ?? null;
}

interface ArmySample {
  time: number;
  army: number;
}

function armySeries(
  events: StatsEvent[] | undefined,
): ArmySample[] {
  if (!Array.isArray(events)) return [];
  const out: ArmySample[] = [];
  for (const ev of events) {
    if (typeof ev?.army_value !== "number") continue;
    if (typeof ev.time !== "number" || !Number.isFinite(ev.time)) continue;
    out.push({ time: ev.time, army: ev.army_value });
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

/** Nearest sample's army value at time t; null on empty input. */
function armyAt(series: ReadonlyArray<ArmySample>, t: number): number | null {
  if (series.length === 0) return null;
  let best = series[0];
  let bestD = Math.abs(best.time - t);
  for (let i = 1; i < series.length; i++) {
    const d = Math.abs(series[i].time - t);
    if (d < bestD) {
      best = series[i];
      bestD = d;
    }
  }
  return best.army;
}

// ---------------------------------------------------------------------------
// Rule 1 — supply blocks.
//
// Severity: min(100, 100 * blockedSec / 75). Rationale: 75 s at the
// supply cap is ~2.5 production cycles across every structure — at any
// league that alone decides a game, so it saturates the scale. A 10 s
// hiccup scores ~13.
// ---------------------------------------------------------------------------

interface SupplyBlockFacts {
  count: number | null;
  blockedSec: number;
  mineralCost: number | null;
  supplyUnit: string;
}

const SUPPLY_UNIT_BY_RACE: Record<EffectiveRace, string> = {
  Zerg: "Overlord",
  Protoss: "Pylon",
  Terran: "Supply Depot",
};

const SUPPLY_BLOCK_VARIANTS: ReadonlyArray<(f: SupplyBlockFacts) => string> = [
  (f) => {
    const cycles = Math.max(1, Math.round(f.blockedSec / PRODUCTION_CYCLE_SEC));
    const countSeg = f.count !== null ? `${f.count} time${f.count === 1 ? "" : "s"} ` : "";
    return (
      `You were supply-blocked ${countSeg}for ${f.blockedSec} seconds — ` +
      `that's roughly ${cycles} full production cycle${cycles === 1 ? "" : "s"} lost.`
    );
  },
  (f) => {
    const countSeg =
      f.count !== null ? ` across ${f.count} separate block${f.count === 1 ? "" : "s"}` : "";
    return (
      `Supply blocks froze your production for ${f.blockedSec} seconds${countSeg} — ` +
      `start your next ${f.supplyUnit} one cycle earlier and that time comes back.`
    );
  },
  (f) => {
    const costSeg =
      f.mineralCost !== null && f.mineralCost > 0
        ? `, roughly ${f.mineralCost} minerals of production that never happened`
        : "";
    return (
      `${f.blockedSec} seconds stuck at the supply cap${costSeg} — ` +
      `the whole time, no new units could start.`
    );
  },
];

function supplyBlockCause(
  breakdown: MacroBreakdownData | null | undefined,
  hash: number,
): AutopsyCause | null {
  const raw = breakdown?.raw;
  if (!raw) return null;
  const windows = Array.isArray(raw.supply_block_windows)
    ? raw.supply_block_windows
    : [];
  let blockedSec = 0;
  const stamps: number[] = [];
  for (const w of windows) {
    if (typeof w?.start !== "number" || typeof w?.end !== "number") continue;
    const dur =
      typeof w.blocked_sec === "number"
        ? w.blocked_sec
        : Math.max(0, w.end - w.start);
    if (dur <= 0) continue;
    blockedSec += dur;
    stamps.push(w.start);
  }
  let count: number | null = stamps.length > 0 ? stamps.length : null;
  if (blockedSec <= 0) {
    // Older payloads carry only the aggregate seconds — no windows.
    blockedSec =
      typeof raw.supply_blocked_seconds === "number"
        ? raw.supply_blocked_seconds
        : 0;
    count = null;
  }
  blockedSec = Math.round(blockedSec);
  if (blockedSec < SUPPLY_BLOCK_MIN_SEC) return null;

  const leak = findLeak(breakdown, LEAK_SUPPLY_BLOCKED);
  const mineralCost =
    typeof leak?.mineral_cost === "number" ? leak.mineral_cost : null;
  const race = computeEffectiveRace(breakdown?.race, raw);
  const facts: SupplyBlockFacts = {
    count,
    blockedSec,
    mineralCost,
    supplyUnit: race ? SUPPLY_UNIT_BY_RACE[race] : "supply structure",
  };
  return {
    id: "supply_block",
    title: "Supply blocks stalled production",
    detail: pickVariant(SUPPLY_BLOCK_VARIANTS, hash, facts),
    severityScore: clamp01to100((100 * blockedSec) / SUPPLY_BLOCK_FULL_SEC),
    timestamps: stamps.map((s) => formatGameClock(s)),
  };
}

// ---------------------------------------------------------------------------
// Rule 2 — resource float.
//
// Severity (stats path): clamp(100 * (meanBank - 400) / (1600 - 400)).
// Rationale: a post-4:00 mean bank of 400 minerals is normal churn
// (severity 0); a sustained mean of 1600 means an entire base's income
// sat unspent (severity 100). Fallback path (no stats_events):
// min(100, spikes * 8) — each >800-mineral sample (~10 s of float) adds
// 8 points, saturating at ~12 spikes ≈ 2 sustained minutes.
// ---------------------------------------------------------------------------

interface FloatFacts {
  mean: number | null;
  peak: number | null;
  peakClock: string | null;
  spikes: number | null;
  mineralCost: number | null;
}

const FLOAT_VARIANTS: ReadonlyArray<(f: FloatFacts) => string> = [
  (f) =>
    f.mean !== null && f.peak !== null
      ? `Your bank averaged ${f.mean} minerals after 4:00 and peaked at ${f.peak}` +
        `${f.peakClock ? ` around ${f.peakClock}` : ""} — money that never became units.`
      : `You had ${f.spikes ?? 0} stretches with ${FLOAT_SPIKE_MINERALS}+ minerals banked after 4:00 — money that never became units.`,
  (f) =>
    f.mean !== null && f.peak !== null
      ? `You floated ${f.mean} minerals on average after the 4:00 mark (peak ${f.peak}) — ` +
        `when the bank climbs like that, add a production building or take an expansion.`
      : `${f.spikes ?? 0} moments with over ${FLOAT_SPIKE_MINERALS} minerals unspent — ` +
        `when the bank climbs like that, add a production building or take an expansion.`,
  (f) => {
    const costSeg =
      f.mineralCost !== null && f.mineralCost > 0
        ? ` — about ${f.mineralCost} minerals of army that stayed in the bank`
        : " — that's army that stayed in the bank";
    return f.peak !== null
      ? `Unspent cash piled up to ${f.peak} minerals${f.peakClock ? ` at ${f.peakClock}` : ""}${costSeg}.`
      : `Your minerals spiked over ${FLOAT_SPIKE_MINERALS} on ${f.spikes ?? 0} samples${costSeg}.`;
  },
];

function resourceFloatCause(
  breakdown: MacroBreakdownData | null | undefined,
  hash: number,
): AutopsyCause | null {
  if (!breakdown) return null;
  const leak = findLeak(breakdown, LEAK_MINERAL_FLOAT);
  const mineralCost =
    typeof leak?.mineral_cost === "number" ? leak.mineral_cost : null;

  // Preferred path: full breakdowns carry per-sample minerals_current.
  const samples = (breakdown.stats_events ?? []).filter(
    (s): s is StatsEvent & { time: number; minerals_current: number } =>
      typeof s?.time === "number" &&
      s.time >= FLOAT_WINDOW_START_SEC &&
      typeof s.minerals_current === "number",
  );
  if (samples.length >= FLOAT_MIN_SAMPLES) {
    let peak = 0;
    let peakTime = 0;
    let sum = 0;
    const spikeTimes: number[] = [];
    for (const s of samples) {
      sum += s.minerals_current;
      if (s.minerals_current > peak) {
        peak = s.minerals_current;
        peakTime = s.time;
      }
      if (s.minerals_current >= FLOAT_SPIKE_MINERALS) spikeTimes.push(s.time);
    }
    const mean = Math.round(sum / samples.length);
    if (peak < FLOAT_SPIKE_MINERALS || mean <= FLOAT_MEAN_BASELINE) return null;
    const facts: FloatFacts = {
      mean,
      peak: Math.round(peak),
      peakClock: formatGameClock(peakTime),
      spikes: spikeTimes.length,
      mineralCost,
    };
    return {
      id: "resource_float",
      title: "Unspent resources piled up",
      detail: pickVariant(FLOAT_VARIANTS, hash, facts),
      severityScore: clamp01to100(
        (100 * (mean - FLOAT_MEAN_BASELINE)) /
          (FLOAT_MEAN_FULL - FLOAT_MEAN_BASELINE),
      ),
      timestamps: spikeTimes.slice(0, 3).map((t) => formatGameClock(t)),
    };
  }

  // Fallback path: slim breakdowns only carry the spike count.
  const spikes =
    typeof breakdown.raw?.mineral_float_spikes === "number"
      ? breakdown.raw.mineral_float_spikes
      : 0;
  if (spikes <= 0) return null;
  const facts: FloatFacts = {
    mean: null,
    peak: null,
    peakClock: null,
    spikes,
    mineralCost,
  };
  return {
    id: "resource_float",
    title: "Unspent resources piled up",
    detail: pickVariant(FLOAT_VARIANTS, hash, facts),
    severityScore: clamp01to100(spikes * 8),
    timestamps:
      typeof leak?.time === "number" ? [formatGameClock(leak.time)] : [],
  };
}

// ---------------------------------------------------------------------------
// Rule 3 — late expansion vs personal median.
//
// Severity: clamp(100 * delaySec / 120). Rationale: expanding two full
// minutes later than YOUR OWN median is a maximal economic self-sabotage
// (a whole base's mining time forfeited), so 120 s saturates the scale;
// the 20 s minimum filters ordinary game-to-game variance.
// ---------------------------------------------------------------------------

interface LateExpansionFacts {
  townhallDisplay: string;
  actualClock: string;
  medianClock: string;
  delaySec: number;
}

const LATE_EXPANSION_VARIANTS: ReadonlyArray<(f: LateExpansionFacts) => string> = [
  (f) =>
    `Your natural ${f.townhallDisplay} started at ${f.actualClock} — ` +
    `${f.delaySec} seconds later than your usual ${f.medianClock}, ` +
    `and that economic lag compounds every minute afterwards.`,
  (f) =>
    `You normally expand around ${f.medianClock}, but this game the second ` +
    `${f.townhallDisplay} went down at ${f.actualClock} (${f.delaySec}s late) — ` +
    `fewer workers means a smaller army at every fight that followed.`,
];

function lateExpansionCause(
  game: AutopsyGame,
  medians: PersonalMedians | undefined,
  hash: number,
): AutopsyCause | null {
  const timings = medians?.expansionTimings;
  if (!timings) return null;
  const entries = parseBuildLog(game.buildLog);
  if (entries.length === 0) return null;

  // Resolve which townhall to track: the player's race when known,
  // else the first townhall type that appears in the log.
  const race = computeEffectiveRace(
    game.macroBreakdown?.race,
    game.macroBreakdown?.raw,
  );
  let townhall: TownhallName | null = race ? TOWNHALL_BY_RACE[race] : null;
  if (!townhall) {
    for (const e of entries) {
      const th = townhallOf(e.name);
      if (th) {
        townhall = th;
        break;
      }
    }
  }
  if (!townhall) return null;

  const occurrences = entries
    .filter((e) => townhallOf(e.name) === townhall)
    .map((e) => e.time)
    .sort((a, b) => a - b);
  if (occurrences.length === 0) return null;

  // Some build logs include the starting base at ~0:00; some start at
  // the first CONSTRUCTED building. If the first townhall is inside the
  // first few seconds it's the starting base — the natural is the next
  // one. Otherwise the first logged townhall IS the natural.
  const natural =
    occurrences[0] <= STARTING_TOWNHALL_MAX_SEC
      ? occurrences.length > 1
        ? occurrences[1]
        : null
      : occurrences[0];
  if (natural === null) return null;

  const median = timings[townhall];
  if (typeof median !== "number" || !Number.isFinite(median)) return null;

  const delaySec = Math.round(natural - median);
  if (delaySec < EXPANSION_MIN_DELAY_SEC) return null;

  const facts: LateExpansionFacts = {
    townhallDisplay: TOWNHALL_DISPLAY[townhall],
    actualClock: formatGameClock(natural),
    medianClock: formatGameClock(median),
    delaySec,
  };
  return {
    id: "late_expansion",
    title: "Expanded later than usual",
    detail: pickVariant(LATE_EXPANSION_VARIANTS, hash, facts),
    severityScore: clamp01to100((100 * delaySec) / EXPANSION_FULL_DELAY_SEC),
    timestamps: [formatGameClock(natural)],
  };
}

// ---------------------------------------------------------------------------
// Rule 4 — production idle: missed injects / chronos / MULEs.
//
// Uses the REAL per-race fields the macro breakdown carries:
// raw.injects_actual/expected, raw.chronos_actual/expected,
// raw.mules_actual/expected (exactly one pair is populated per game),
// priced via the matching leak names "Inject Efficiency" /
// "Chrono Efficiency" / "MULE Efficiency".
//
// Severity: clamp(100 * (1 - actual/expected) * 1.3). Rationale: the
// missed fraction is the natural magnitude; the 1.3 gain means missing
// ~77 % of your casts saturates at 100 while the 15 % everyone misses
// (grace built into the fire threshold) scores ~20 at worst.
// ---------------------------------------------------------------------------

interface MechanicFacts {
  actual: number;
  expected: number;
  missed: number;
  pct: number;
  noun: string;
  hint: string;
  mineralCost: number | null;
}

const MECHANIC_META: Record<
  EffectiveRace,
  { title: string; noun: string; hint: string; actualKey: "injects_actual" | "chronos_actual" | "mules_actual"; expectedKey: "injects_expected" | "chronos_expected" | "mules_expected" }
> = {
  Zerg: {
    title: "Missed injects",
    noun: "injects",
    hint: "keep a Queen hotkeyed and inject every time she hits 25 energy",
    actualKey: "injects_actual",
    expectedKey: "injects_expected",
  },
  Protoss: {
    title: "Missed chrono boosts",
    noun: "chrono boosts",
    hint: "spend Nexus energy on your main production the moment it banks 50",
    actualKey: "chronos_actual",
    expectedKey: "chronos_expected",
  },
  Terran: {
    title: "Missed MULEs",
    noun: "MULE drops",
    hint: "dump Orbital energy into MULEs the moment it hits 50",
    actualKey: "mules_actual",
    expectedKey: "mules_expected",
  },
};

const MECHANIC_VARIANTS: ReadonlyArray<(f: MechanicFacts) => string> = [
  (f) => {
    const costSeg =
      f.mineralCost !== null && f.mineralCost > 0
        ? ` — roughly ${f.mineralCost} minerals of production you never got`
        : " — production time you never got back";
    return `You landed ${f.actual} of ${f.expected} expected ${f.noun} (${f.pct}%)${costSeg}.`;
  },
  (f) =>
    `${f.missed} ${f.noun} never happened this game (${f.actual}/${f.expected}) — ${f.hint}.`,
  (f) =>
    `Only ${f.pct}% of your possible ${f.noun} were used (${f.actual} of ${f.expected}) — ` +
    `that idle time quietly shrinks every wave of units you produce.`,
];

function productionIdleCause(
  breakdown: MacroBreakdownData | null | undefined,
  hash: number,
): AutopsyCause | null {
  const raw = breakdown?.raw;
  if (!raw) return null;
  const race = computeEffectiveRace(breakdown?.race, raw);
  if (!race) return null;
  const meta = MECHANIC_META[race];
  const actual = raw[meta.actualKey];
  const expected = raw[meta.expectedKey];
  if (typeof actual !== "number" || typeof expected !== "number") return null;
  if (expected < MECHANIC_MIN_EXPECTED) return null;
  const ratio = actual / expected;
  if (ratio >= MECHANIC_OK_RATIO) return null;

  const leak = findLeak(breakdown, LEAK_BY_RACE[race]);
  const facts: MechanicFacts = {
    actual,
    expected,
    missed: Math.max(0, expected - actual),
    pct: Math.round(100 * ratio),
    noun: meta.noun,
    hint: meta.hint,
    mineralCost: typeof leak?.mineral_cost === "number" ? leak.mineral_cost : null,
  };
  return {
    id: "production_idle",
    title: meta.title,
    detail: pickVariant(MECHANIC_VARIANTS, hash, facts),
    severityScore: clamp01to100(100 * (1 - ratio) * 1.3),
    timestamps:
      typeof leak?.time === "number" ? [formatGameClock(leak.time)] : [],
  };
}

// ---------------------------------------------------------------------------
// Rule 5 — one-sided fight loss.
//
// Uses `army_value` on stats_events / opp_stats_events (agent v0.5.11+
// full breakdowns; the same series the Active Army chart binds to).
// Scans every ≤45 s window for the largest own-army drop, then measures
// the opponent's drop across the same window. Fires when you lost
// ≥400 army value and the opponent lost ≤60 % of that.
//
// Severity: clamp(100 * (myLoss - oppLoss) / 2500). Rationale: the NET
// value swing is what decides games; donating a full 2500-resource army
// for nothing is an instant game-loss (100), a 400/0 skirmish scores 16.
// ---------------------------------------------------------------------------

interface FightFacts {
  myLoss: number;
  oppLoss: number;
  clock: string;
}

const FIGHT_VARIANTS: ReadonlyArray<(f: FightFacts) => string> = [
  (f) => {
    const oppSeg =
      f.oppLoss < 50
        ? "while your opponent lost almost nothing"
        : `while your opponent lost only ${f.oppLoss}`;
    return `Around ${f.clock} you lost ${f.myLoss} army value ${oppSeg} — one bad fight erased your whole army.`;
  },
  (f) => {
    const ratio =
      f.oppLoss >= 50 ? (f.myLoss / f.oppLoss).toFixed(1) : null;
    const ratioSeg = ratio ? ` (a ${ratio}:1 trade against you)` : " (a near-total wipe for free)";
    return (
      `The engagement at ${f.clock} traded ${f.myLoss} of your army for ${f.oppLoss} of theirs${ratioSeg} — ` +
      `backing off and re-engaging with your next production round wins that fight.`
    );
  },
];

function oneSidedFightCause(
  breakdown: MacroBreakdownData | null | undefined,
  hash: number,
): AutopsyCause | null {
  if (!breakdown) return null;
  const mySeries = armySeries(breakdown.stats_events);
  const oppSeries = armySeries(breakdown.opp_stats_events);
  if (mySeries.length < 2 || oppSeries.length < 2) return null;

  // Largest own-army drop across any window of ≤ FIGHT_WINDOW_SEC.
  let bestLoss = 0;
  let bestStart = 0;
  let bestEnd = 0;
  for (let i = 0; i < mySeries.length - 1; i++) {
    for (let j = i + 1; j < mySeries.length; j++) {
      const dt = mySeries[j].time - mySeries[i].time;
      if (dt > FIGHT_WINDOW_SEC) break;
      const loss = mySeries[i].army - mySeries[j].army;
      if (loss > bestLoss) {
        bestLoss = loss;
        bestStart = mySeries[i].time;
        bestEnd = mySeries[j].time;
      }
    }
  }
  if (bestLoss < FIGHT_MIN_MY_LOSS) return null;

  const oppBefore = armyAt(oppSeries, bestStart);
  const oppAfter = armyAt(oppSeries, bestEnd);
  if (oppBefore === null || oppAfter === null) return null;
  const oppLoss = Math.max(0, Math.round(oppBefore - oppAfter));
  const myLoss = Math.round(bestLoss);
  if (oppLoss > myLoss * FIGHT_ONE_SIDED_RATIO) return null;

  const facts: FightFacts = {
    myLoss,
    oppLoss,
    clock: formatGameClock(bestStart),
  };
  return {
    id: "one_sided_fight",
    title: "Lost a one-sided fight",
    detail: pickVariant(FIGHT_VARIANTS, hash, facts),
    severityScore: clamp01to100(
      (100 * (myLoss - oppLoss)) / FIGHT_FULL_NET_LOSS,
    ),
    timestamps: [formatGameClock(bestStart), formatGameClock(bestEnd)],
  };
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

/**
 * Rank the top causes of a loss. Returns [] when the game isn't a loss
 * (result must be "Loss"/"Defeat", the values Last5GamesTimeline keys
 * off) or when no rule finds enough data to fire. Max 3 causes, sorted
 * by severity descending; ties keep the rule-declaration order
 * (supply → float → expansion → mechanic → fight) because
 * Array.prototype.sort is stable.
 */
export function lossAutopsy(input: LossAutopsyInput): AutopsyCause[] {
  const { game, personalMedians } = input;
  if (!isLossResult(game.result)) return [];

  const hash = fnv1a(game.id ?? "");
  const breakdown = game.macroBreakdown ?? null;

  const causes: AutopsyCause[] = [];
  const candidates: ReadonlyArray<AutopsyCause | null> = [
    supplyBlockCause(breakdown, hash),
    resourceFloatCause(breakdown, hash),
    lateExpansionCause(game, personalMedians, hash),
    productionIdleCause(breakdown, hash),
    oneSidedFightCause(breakdown, hash),
  ];
  for (const cause of candidates) {
    if (cause && cause.severityScore > 0) causes.push(cause);
  }
  causes.sort((a, b) => b.severityScore - a.severityScore);
  return causes.slice(0, MAX_CAUSES);
}
