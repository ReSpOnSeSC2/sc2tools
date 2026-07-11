/**
 * grudge — rivalry storyline lines for the live overlay.
 *
 * A pure, deterministic template engine that turns the head-to-head /
 * history the Rematch + Rival widgets already carry into ONE broadcast-
 * friendly storyline for the streamer: "REMATCH: 3rd meeting this week —
 * they're up 4-2, last game they went Cannon Rush on this map."
 *
 * No LLM, no network, no randomness. Every line is a pure function of
 * its input, so a given matchup always renders the same line (stable on
 * stream) while different opponents get different template variants
 * (varied across the ladder). Returns null when there's simply no story
 * to tell — a first meeting, or an opponent with no shared history.
 *
 * The core `buildGrudgeLine` takes a decoupled `GrudgeInput` so it can be
 * unit-tested without a live payload. `grudgeInputFromLive` is the thin
 * glue the widgets use to map a `LiveGamePayload` onto that input.
 */

import type { LiveGamePayload } from "@/components/overlay/types";

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

export interface GrudgeInput {
  /**
   * Stable per-OPPONENT identifier (not per-game) used to seed the
   * deterministic template pick. Opponent display name, pulse id, battle
   * tag — anything that stays constant across meetings with the same
   * player. Absent → falls back to `opponentName`, then a constant.
   */
  opponentId?: string | null;
  /** Opponent display name used in the line copy. */
  opponentName?: string | null;
  /** Head-to-head record vs this opponent (player's wins/losses). */
  headToHead?: { wins: number; losses: number } | null;
  /** Result of the immediately-previous meeting, when known. */
  lastResult?: "win" | "loss" | null;
  /**
   * How many times you've faced this opponent TODAY, counting this
   * encounter (so the 2nd meeting today is `2`). Drives the "Nth today"
   * hook. Absent/1 → not a repeat.
   */
  meetingsThisSession?: number | null;
  /**
   * How many times you've faced this opponent in the last 7 days,
   * counting this encounter. Drives the "Nth this week" hook when there's
   * no same-day repeat.
   */
  meetingsThisWeek?: number | null;
  /** Current map name. */
  map?: string | null;
  /** Map of the previous meeting — enables the same-map callback. */
  lastMap?: string | null;
  /** Opponent's build/strategy label in the previous meeting, if known. */
  lastOppBuild?: string | null;
}

export interface GrudgeLine {
  /** Short broadcast tag, e.g. "REMATCH" | "NEMESIS" | "RUN IT BACK". */
  tag: string;
  /** One complete, broadcast-friendly storyline sentence. */
  line: string;
}

// ---------------------------------------------------------------------------
// Deterministic template selection (self-contained FNV-1a; kept local so
// this module stays dependency-light for the OBS overlay bundle).
// ---------------------------------------------------------------------------

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Stable seed key: opponent identity + the current rivalry "standing". */
export function grudgeKey(input: GrudgeInput, standing: number): string {
  const id = (input.opponentId || input.opponentName || "opp").trim() || "opp";
  return `${id}|${standing}`;
}

// ---------------------------------------------------------------------------
// Small copy helpers.
// ---------------------------------------------------------------------------

function capFirst(s: string): string {
  return s.length ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

/** Strip a leading race/matchup prefix ("PvZ - ", "Protoss - ") and cap length. */
function cleanBuild(raw: string | null | undefined): string {
  const s = (raw || "").trim();
  if (!s) return "";
  const m = /^[A-Za-z]{2,8}\s*[-–]\s*(.+)$/.exec(s);
  const body = (m ? m[1] : s).trim();
  return body.length > 46 ? `${body.slice(0, 45).trimEnd()}…` : body;
}

function sameMap(a?: string | null, b?: string | null): boolean {
  const x = (a || "").trim().toLowerCase();
  const y = (b || "").trim().toLowerCase();
  return x.length > 0 && x === y;
}

// ---------------------------------------------------------------------------
// Derived facts + scenario copy.
// ---------------------------------------------------------------------------

interface Facts {
  /** Subject form: opponent name or "This opponent". */
  opp: string;
  /** Object form: opponent name or "them". */
  oppObj: string;
  wins: number;
  losses: number;
  total: number;
  diff: number;
  lostLast: boolean;
  /** Repeat-meeting count (>= 2) within the chosen scope, else 0. */
  meetCount: number;
  /** "today" | "this week" | "". */
  scope: string;
  onSameMap: boolean;
  lastBuild: string;
}

/** Mid-sentence record clause, lowercase, from the player's perspective. */
function recordMid(f: Facts): string {
  if (f.diff > 0) return `you're up ${f.wins}-${f.losses}`;
  if (f.diff < 0) return `they're up ${f.losses}-${f.wins}`;
  return `it's ${f.wins}-${f.losses} even`;
}

/** Last-meeting callback fragment, lowercase, or "" when nothing to say. */
function callback(f: Facts): string {
  const onMap = f.onSameMap ? " on this map" : "";
  if (f.lastBuild) return `last game they went ${f.lastBuild}${onMap}`;
  if (f.onSameMap) return "same map as your last meeting";
  return "";
}

type Variant = (f: Facts) => string;

interface Scenario {
  tag: string;
  variants: Variant[];
}

const NEMESIS: Scenario = {
  tag: "NEMESIS",
  variants: [
    (f) => {
      const cb = callback(f);
      return `${f.opp} has your number — they lead ${f.losses}-${f.wins}.${cb ? ` ${capFirst(cb)}.` : ""} Break the pattern.`;
    },
    (f) => {
      const cb = callback(f);
      return `${f.opp} owns this matchup, ${f.losses}-${f.wins} against you${cb ? `, ${cb}` : ""}. Flip the script.`;
    },
  ],
};

const DOMINANT: Scenario = {
  tag: "DOMINANT",
  variants: [
    (f) =>
      `You own ${f.oppObj} — ${f.wins}-${f.losses} in your favor.${f.lostLast ? " They nicked the last one, though — keep the lead." : " Keep it rolling."}`,
    (f) => {
      const cb = callback(f);
      return `${f.opp} still can't crack you: ${f.wins}-${f.losses} on the board.${cb ? ` ${capFirst(cb)}.` : ""}`;
    },
  ],
};

const REMATCH: Scenario = {
  tag: "REMATCH",
  variants: [
    (f) => {
      const cb = callback(f);
      const rec = f.total > 0 ? ` — ${recordMid(f)}` : "";
      return `${ordinal(f.meetCount)} meeting ${f.scope}${rec}${cb ? `, ${cb}` : ""}.`;
    },
    (f) => {
      const cb = callback(f);
      const rec = f.total > 0 ? `: ${recordMid(f)}` : "";
      return `Round ${f.meetCount} ${f.scope} against ${f.oppObj}${rec}${cb ? ` — ${cb}` : ""}.`;
    },
  ],
};

const REVENGE: Scenario = {
  tag: "RUN IT BACK",
  variants: [
    (f) => {
      const buildSeg = f.lastBuild ? ` (they went ${f.lastBuild})` : "";
      const mapSeg = f.onSameMap ? " on this very map" : "";
      return `You dropped the last one to ${f.oppObj}${buildSeg}${mapSeg} — run it back.`;
    },
    (f) => {
      const mapSeg = f.onSameMap ? " Same map — no excuses this time." : "";
      return `${f.opp} took your last meeting. Even the score.${mapSeg}`;
    },
  ],
};

const LEADING: Scenario = {
  tag: "AHEAD",
  variants: [
    (f) => `You lead ${f.oppObj} ${f.wins}-${f.losses}. Stay on top.`,
    (f) => `Up ${f.wins}-${f.losses} on ${f.oppObj} — press the edge.`,
  ],
};

const BEHIND: Scenario = {
  tag: "PAYBACK",
  variants: [
    (f) => `${f.opp} edges the series ${f.losses}-${f.wins}. Chip into that lead.`,
    (f) => `Down ${f.losses}-${f.wins} to ${f.oppObj} — claw one back.`,
  ],
};

const EVEN: Scenario = {
  tag: "DEAD EVEN",
  variants: [
    (f) => `Dead even with ${f.oppObj} at ${f.wins}-${f.losses}. Tiebreaker time.`,
    (f) => `All square vs ${f.oppObj}, ${f.wins}-${f.losses}. Break the tie.`,
  ],
};

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

/**
 * Build the single most-compelling rivalry line for this matchup, or
 * null when there's no story. Scenario priority (highest first):
 *
 *   NEMESIS (down big) → DOMINANT (up big) → REMATCH (repeat this
 *   week/today) → RUN IT BACK (lost last, one-off) → AHEAD → PAYBACK →
 *   DEAD EVEN.
 *
 * Within the chosen scenario a template variant is picked by
 * `fnv1a(opponentId + standing)`, so the line is stable per matchup and
 * varied across opponents.
 */
export function buildGrudgeLine(input: GrudgeInput | null | undefined): GrudgeLine | null {
  if (!input) return null;

  const wins = Math.max(0, Math.round(input.headToHead?.wins ?? 0));
  const losses = Math.max(0, Math.round(input.headToHead?.losses ?? 0));
  const total = wins + losses;
  const diff = wins - losses;
  const lostLast = input.lastResult === "loss";

  // Resolve the repeat-meeting hook: prefer a same-day repeat (stronger
  // "we keep meeting" story), fall back to a this-week repeat.
  const session = Math.max(0, Math.round(input.meetingsThisSession ?? 0));
  const week = Math.max(0, Math.round(input.meetingsThisWeek ?? 0));
  let meetCount = 0;
  let scope = "";
  if (session >= 2) {
    meetCount = session;
    scope = "today";
  } else if (week >= 2) {
    meetCount = week;
    scope = "this week";
  }
  const repeat = meetCount >= 2;

  // No story: a first meeting with no prior record and no repeat hook.
  // (A lone "you won the last game" isn't a rivalry beat on its own — the
  // Rematch widget already states that — so it doesn't count as history.)
  const hasHistory = total >= 1 || lostLast || repeat;
  if (!hasHistory) return null;

  const facts: Facts = {
    opp: (input.opponentName || "").trim() || "This opponent",
    oppObj: (input.opponentName || "").trim() || "them",
    wins,
    losses,
    total,
    diff,
    lostLast,
    meetCount,
    scope,
    onSameMap: sameMap(input.map, input.lastMap),
    lastBuild: cleanBuild(input.lastOppBuild),
  };

  const scenario = pickScenario(facts, repeat);
  if (!scenario) return null;

  const standing = total > 0 ? total : meetCount;
  const hash = fnv1a(grudgeKey(input, standing));
  const variant = scenario.variants[hash % scenario.variants.length];
  return { tag: scenario.tag, line: variant(facts) };
}

function pickScenario(f: Facts, repeat: boolean): Scenario | null {
  // "Big" records own the narrative: a 3+ game lead either way. A
  // moderate 2-game edge (e.g. 2-4) stays available to the repeat /
  // revenge / record beats below, so a 3rd-meeting-this-week reads as
  // REMATCH rather than being swallowed by NEMESIS.
  if (f.diff <= -3) return NEMESIS;
  if (f.diff >= 3) return DOMINANT;
  if (repeat) return REMATCH;
  if (f.lostLast) return REVENGE;
  if (f.diff >= 1) return LEADING;
  if (f.diff <= -1) return BEHIND;
  if (f.total >= 1) return EVEN;
  return null;
}

// ---------------------------------------------------------------------------
// Live-payload glue.
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/**
 * Map the live overlay payload the Rematch/Rival widgets receive onto a
 * `GrudgeInput`. Meeting counts are derived from `recentGames` dates and
 * counted INCLUSIVE of the current encounter (prior meetings + 1), so the
 * copy reads "3rd meeting this week" when there were two before. `now` is
 * injectable purely so tests stay deterministic.
 */
export function grudgeInputFromLive(
  live: LiveGamePayload | null | undefined,
  now: number = Date.now(),
): GrudgeInput {
  const recent = Array.isArray(live?.recentGames) ? live!.recentGames : [];

  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const startOfDayMs = startOfDay.getTime();

  let priorWeek = 0;
  let priorSession = 0;
  for (const g of recent) {
    if (!g?.date) continue;
    const t = Date.parse(g.date);
    if (Number.isNaN(t)) continue;
    if (t > now) continue;
    if (now - t <= 7 * DAY_MS) priorWeek += 1;
    if (t >= startOfDayMs) priorSession += 1;
  }

  const last = recent[0];
  const lastResult: "win" | "loss" | null =
    live?.rematch?.lastResult ??
    (last?.result === "Win" ? "win" : last?.result === "Loss" ? "loss" : null);

  const h2h = live?.headToHead ?? live?.rival?.headToHead ?? null;
  const name = live?.oppName ?? live?.rival?.name ?? null;

  return {
    opponentId: name,
    opponentName: name,
    headToHead: h2h,
    lastResult,
    // +1 for the current encounter; 0 stays 0 (no history this window).
    meetingsThisSession: priorSession > 0 ? priorSession + 1 : null,
    meetingsThisWeek: priorWeek > 0 ? priorWeek + 1 : null,
    map: live?.map ?? null,
    lastMap: last?.map ?? null,
    lastOppBuild: last?.oppBuild ?? null,
  };
}
