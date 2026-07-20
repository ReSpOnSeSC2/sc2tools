// Daily Pulse — the dashboard's fresh-content engine. A rotating strip
// of insight cards derived entirely from the user's own replay corpus:
// yesterday's session, live streaks, MMR peak-chasing, rising/rusty
// builds, nemesis sightings, map edges, matchup shifts, milestones,
// on-this-day throwbacks and macro trends. Every visit to the dashboard
// shows something current, and the mix rotates every calendar day.
//
// This module owns the card pool and the daily selection; the corpus
// crunching (PulseContext + tuning constants) lives in
// lib/dailyPulseContext.ts and is re-exported here so consumers and
// tests import everything from one place.
//
// Determinism / cross-device contract:
//   - selectDailyPulse seeds with mulberry32(dailySeed(userId,
//     `${dateKey}#pulse`)) — the same helper family ArcadeEngine's
//     Daily Drop / Daily Quests use, namespaced with "#pulse" so the
//     pulse rotation is decorrelated from the quest shuffle — and every
//     context window is anchored on `dateKey`, never Date.now(). The
//     same corpus + (user, day) always yields the same strip on every
//     device.
//   - Null-safe and no-mock by design: every card documents its data
//     requirement in `requires` and self-excludes when the corpus
//     can't support it. An empty corpus yields an empty strip, never
//     filler content.

import type { ArcadeGame } from "@/components/analyzer/arcade/types";
import {
  dailySeed,
  mulberry32,
  shuffle,
} from "@/components/analyzer/arcade/ArcadeEngine";
import {
  BOUNCE_BACK_MIN_SAMPLES,
  CLIMB_MIN_DELTA,
  CLIMB_MIN_GAMES,
  CLIMB_WINDOW_DAYS,
  MACRO_TREND_MIN_DELTA,
  MACRO_TREND_MIN_SCORED,
  MAP_EDGE_MIN_DECIDED,
  MAP_EDGE_MIN_WINRATE,
  MAP_WINDOW_DAYS,
  MATCHUP_MIN_DELTA,
  MATCHUP_RECENT_DAYS,
  MILESTONE_GAMES_WITHIN,
  MILESTONE_WINS_WITHIN,
  NEMESIS_MAX_WINRATE,
  NEMESIS_MIN_DECIDED,
  NEMESIS_WINDOW_DAYS,
  PEAK_MIN_RATED,
  PEAK_WINDOW_DAYS,
  RISING_BUILD_MIN_DELTA,
  RISING_BUILD_MIN_RECENT_DECIDED,
  RISING_BUILD_WINDOW_DAYS,
  RIVAL_MIN_DECIDED,
  RIVAL_WINDOW_DAYS,
  RUSTY_BUILD_IDLE_DAYS,
  RUSTY_BUILD_MIN_WINRATE,
  SESSION_MIN_GAMES,
  STREAK_MIN,
  buildPulseContext,
  type PulseContext,
} from "@/lib/dailyPulseContext";

// One import surface for consumers/tests: the context layer's types,
// constants and helpers are part of this module's public API.
export * from "@/lib/dailyPulseContext";

/* ──────────────── tuning constants ──────────────── */

/** How many cards a day serves by default. */
export const DAILY_PULSE_COUNT = 4;
/** At most this many "timely" cards (session / streak / mmr) per day. */
export const TIMELY_MAX = 2;

/* ──────────────── types ──────────────── */

export type PulseTone = "positive" | "warning" | "neutral" | "accent";

/**
 * Selection picks at most one card per category, so a day never serves
 * two variations of the same idea (e.g. both build cards).
 */
export type PulseCategory =
  | "session"
  | "streak"
  | "mmr"
  | "build"
  | "opponent"
  | "map"
  | "matchup"
  | "milestone"
  | "throwback"
  | "macro";

/** Analyzer tab a card can deep-link into (subset of tabs.ts TabId). */
export type PulseTargetTab =
  | "opponents"
  | "strategies"
  | "trends"
  | "macro"
  | "battlefield"
  | "builds"
  | "arcade";

/** One ready-to-render insight card for a specific day. */
export interface PulseCard {
  /** Stable pool id — also the React key. */
  id: string;
  category: PulseCategory;
  tone: PulseTone;
  /** Small uppercase label, e.g. "STREAK WATCH". */
  kicker: string;
  /** Headline. */
  title: string;
  /** One or two supporting sentences. All real numbers, no filler. */
  body: string;
  /** Optional big number rendered beside the copy. */
  stat?: string;
  statLabel?: string;
  /** Analyzer tab this card drills into. */
  targetTab?: PulseTargetTab;
  /**
   * Opponent dossier this card drills into (the storage pulseId).
   * When set, clicking the card opens this profile directly instead
   * of just landing on the Opponents list.
   */
  targetOpponentId?: string;
}

/** Pool entry: eligibility gate + card factory. */
export interface PulseSpec {
  id: string;
  category: PulseCategory;
  /** Human note documenting the data this card requires. */
  requires: string;
  /**
   * Timely cards describe "right now" (yesterday's session, a live
   * streak, current MMR) and win slot contention; evergreen cards
   * rotate through the remaining slots.
   */
  timely: boolean;
  /** Higher weight surfaces earlier and wins timely slot contention. */
  weight: number;
  eligible(ctx: PulseContext): boolean;
  /** Only called when eligible(ctx) is true. */
  build(ctx: PulseContext): PulseCard;
}

export interface DailyPulseSelection {
  dateKey: string;
  context: PulseContext;
  /** Up to `count` cards, distinct categories, deterministic per (user, day). */
  cards: PulseCard[];
}

/* ──────────────── copy helpers ──────────────── */

const RACE_NAME: Record<"P" | "T" | "Z", string> = {
  P: "Protoss",
  T: "Terran",
  Z: "Zerg",
};

function pctLabel(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function signed(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toLocaleString()}`;
}

/* ──────────────── the card pool ──────────────── */

/**
 * 14 card definitions across 10 categories. Every builder reads ONLY
 * the PulseContext; every spec documents its data requirement in
 * `requires` and enforces it in `eligible`.
 */
export const PULSE_POOL: PulseSpec[] = [
  {
    id: "session-recap",
    category: "session",
    requires: `≥${SESSION_MIN_GAMES} games yesterday (result/date; MMR optional).`,
    timely: true,
    weight: 100,
    eligible: (ctx) => ctx.yesterday !== null,
    build: (ctx) => {
      const y = ctx.yesterday!;
      const tone: PulseTone =
        y.wins > y.losses ? "positive" : y.losses > y.wins ? "warning" : "neutral";
      const mmrBit =
        y.netMmr !== null ? ` and finished ${signed(y.netMmr)} MMR` : "";
      return {
        id: "session-recap",
        category: "session",
        tone,
        kicker: "Yesterday's session",
        title:
          y.wins > y.losses
            ? "You banked a winning session"
            : y.losses > y.wins
              ? "Yesterday fought back"
              : "An even session on the ladder",
        body: `You played ${y.games} game${y.games === 1 ? "" : "s"} yesterday, went ${y.wins}–${y.losses}${mmrBit}.`,
        stat: y.netMmr !== null ? signed(y.netMmr) : `${y.wins}–${y.losses}`,
        statLabel: y.netMmr !== null ? "net MMR" : "record",
        targetTab: "trends",
      };
    },
  },
  {
    id: "streak-live",
    category: "streak",
    requires: `Active win streak ≥${STREAK_MIN} (result only).`,
    timely: true,
    weight: 90,
    eligible: (ctx) => ctx.winStreak >= STREAK_MIN,
    build: (ctx) => ({
      id: "streak-live",
      category: "streak",
      tone: "positive",
      kicker: "Streak watch",
      title: `You're riding a ${ctx.winStreak}-game win streak`,
      body:
        ctx.winStreak >= ctx.longestWinStreak
          ? "That ties or beats your longest run on record. Every queue from here is new territory."
          : `Your longest run on record is ${ctx.longestWinStreak} — ${
              ctx.longestWinStreak - ctx.winStreak
            } more win${ctx.longestWinStreak - ctx.winStreak === 1 ? "" : "s"} matches it.`,
      stat: String(ctx.winStreak),
      statLabel: "straight wins",
      targetTab: "trends",
    }),
  },
  {
    id: "bounce-back",
    category: "streak",
    requires: `Active loss streak ≥${STREAK_MIN}; rate shown only with ≥${BOUNCE_BACK_MIN_SAMPLES} post-loss samples.`,
    timely: true,
    weight: 85,
    eligible: (ctx) => ctx.lossStreak >= STREAK_MIN,
    build: (ctx) => ({
      id: "bounce-back",
      category: "streak",
      tone: "warning",
      kicker: "Reset point",
      title: `${ctx.lossStreak} losses in a row — time for a reset`,
      body:
        ctx.bounceBackRate !== null
          ? `Historically you win ${pctLabel(ctx.bounceBackRate)} of games played right after a loss (${ctx.bounceBackSamples} samples). One deliberate game beats three tilted ones.`
          : "A short break, one replay review, then queue again. One deliberate game beats three tilted ones.",
      stat:
        ctx.bounceBackRate !== null ? pctLabel(ctx.bounceBackRate) : undefined,
      statLabel: ctx.bounceBackRate !== null ? "post-loss win rate" : undefined,
      targetTab: "trends",
    }),
  },
  {
    id: "peak-watch",
    category: "mmr",
    requires: `≥${PEAK_MIN_RATED} rated ranked games on one account in ${PEAK_WINDOW_DAYS} days (myMmr + myToonHandle).`,
    timely: true,
    weight: 80,
    eligible: (ctx) => ctx.mainAccount !== null,
    build: (ctx) => {
      const a = ctx.mainAccount!;
      const gap = a.peakMmr - a.currentMmr;
      if (gap <= 0) {
        return {
          id: "peak-watch",
          category: "mmr",
          tone: "positive",
          kicker: "Peak watch",
          title: `${a.label} is at its ${PEAK_WINDOW_DAYS}-day peak`,
          body: `Your last recorded MMR (${a.currentMmr.toLocaleString()}) is the highest of your past ${PEAK_WINDOW_DAYS} days. Every win from here sets a new mark.`,
          stat: a.currentMmr.toLocaleString(),
          statLabel: "current MMR",
          targetTab: "trends",
        };
      }
      return {
        id: "peak-watch",
        category: "mmr",
        tone: "accent",
        kicker: "Peak watch",
        title: `${gap.toLocaleString()} MMR from your ${PEAK_WINDOW_DAYS}-day peak`,
        body: `${a.label} sits at ${a.currentMmr.toLocaleString()}; your ${PEAK_WINDOW_DAYS}-day peak is ${a.peakMmr.toLocaleString()}. One good session closes that.`,
        stat: gap.toLocaleString(),
        statLabel: "MMR to peak",
        targetTab: "trends",
      };
    },
  },
  {
    id: "climb-recap",
    category: "mmr",
    requires: `≥${CLIMB_MIN_GAMES} rated games in ${CLIMB_WINDOW_DAYS} days on the main account, net |Δ| ≥ ${CLIMB_MIN_DELTA}.`,
    timely: true,
    weight: 75,
    eligible: (ctx) =>
      ctx.mainAccount !== null &&
      ctx.mainAccount.climbNet !== null &&
      ctx.mainAccount.climbGames >= CLIMB_MIN_GAMES &&
      Math.abs(ctx.mainAccount.climbNet) >= CLIMB_MIN_DELTA,
    build: (ctx) => {
      const a = ctx.mainAccount!;
      const net = a.climbNet!;
      const up = net > 0;
      return {
        id: "climb-recap",
        category: "mmr",
        tone: up ? "positive" : "warning",
        kicker: "This week",
        title: up
          ? `${signed(net)} MMR over the last ${CLIMB_WINDOW_DAYS} days`
          : `Down ${Math.abs(net).toLocaleString()} MMR this week — recoverable`,
        body: up
          ? `${a.label} climbed across ${a.climbGames} rated games this week. Keep the same openings — it's working.`
          : `${a.label} dropped across ${a.climbGames} rated games this week. Check which matchup is bleeding before the next queue.`,
        stat: signed(net),
        statLabel: "net MMR, 7 days",
        targetTab: "trends",
      };
    },
  },
  {
    id: "rising-build",
    category: "build",
    requires: `A classified build with ≥${RISING_BUILD_MIN_RECENT_DECIDED} decided recent games beating its career WR by ≥${Math.round(RISING_BUILD_MIN_DELTA * 100)}pts.`,
    timely: false,
    weight: 60,
    eligible: (ctx) => ctx.risingBuild !== null,
    build: (ctx) => {
      const b = ctx.risingBuild!;
      return {
        id: "rising-build",
        category: "build",
        tone: "positive",
        kicker: "Build heating up",
        title: `${b.name} is on form`,
        body: `${pctLabel(b.recentWinRate)} over ${b.recentDecided} games in the last ${RISING_BUILD_WINDOW_DAYS} days, up from ${pctLabel(b.careerWinRate)} career. Ride it while it's hot.`,
        stat: pctLabel(b.recentWinRate),
        statLabel: `last ${b.recentDecided} decided`,
        targetTab: "builds",
      };
    },
  },
  {
    id: "rusty-build",
    category: "build",
    requires: `A classified ≥${Math.round(RUSTY_BUILD_MIN_WINRATE * 100)}% career build untouched for ${RUSTY_BUILD_IDLE_DAYS}+ days.`,
    timely: false,
    weight: 50,
    eligible: (ctx) => ctx.rustyBuild !== null,
    build: (ctx) => {
      const b = ctx.rustyBuild!;
      return {
        id: "rusty-build",
        category: "build",
        tone: "accent",
        kicker: "Dust it off",
        title: `${b.name} misses you`,
        body: `It wins ${pctLabel(b.careerWinRate)} of your games (${b.careerDecided} decided) but you haven't played it in over ${RUSTY_BUILD_IDLE_DAYS} days. Worth one queue today?`,
        stat: pctLabel(b.careerWinRate),
        statLabel: "career win rate",
        targetTab: "builds",
      };
    },
  },
  {
    id: "nemesis-watch",
    category: "opponent",
    requires: `An opponent with ≥${NEMESIS_MIN_DECIDED} decided games, ≤${Math.round(NEMESIS_MAX_WINRATE * 100)}% WR, seen in ${NEMESIS_WINDOW_DAYS} days. Barcode names need a resolved SC2Pulse id.`,
    timely: false,
    weight: 55,
    eligible: (ctx) => ctx.nemesis !== null,
    build: (ctx) => {
      const n = ctx.nemesis!;
      return {
        id: "nemesis-watch",
        category: "opponent",
        tone: "warning",
        kicker: "Nemesis watch",
        title: `${n.name} owns the ledger — for now`,
        body: `They've taken ${n.losses} of your ${n.decided} meetings and they're active on your ladder. Skim their dossier before the next queue.`,
        stat: `${n.wins}–${n.losses}`,
        statLabel: "your head-to-head",
        targetTab: "opponents",
        targetOpponentId: n.pulseId,
      };
    },
  },
  {
    id: "rival-ledger",
    category: "opponent",
    requires: `An opponent faced ≥${RIVAL_MIN_DECIDED} times in ${RIVAL_WINDOW_DAYS} days. Barcode names need a resolved SC2Pulse id.`,
    timely: false,
    weight: 45,
    eligible: (ctx) => ctx.rival !== null,
    build: (ctx) => {
      const r = ctx.rival!;
      const ahead = r.wins > r.losses;
      return {
        id: "rival-ledger",
        category: "opponent",
        tone: ahead ? "positive" : "neutral",
        kicker: "Ladder rival",
        title: `${r.name} keeps finding you`,
        body: `${r.windowDecided} meetings in the last ${RIVAL_WINDOW_DAYS} days; the career ledger reads ${r.wins}–${r.losses} ${ahead ? "in your favour" : "and it's up for grabs"}. Odds are you'll queue into them again soon.`,
        stat: `${r.wins}–${r.losses}`,
        statLabel: "head-to-head",
        targetTab: "opponents",
        targetOpponentId: r.pulseId,
      };
    },
  },
  {
    id: "map-edge",
    category: "map",
    requires: `A map with ≥${MAP_EDGE_MIN_DECIDED} decided games at ≥${Math.round(MAP_EDGE_MIN_WINRATE * 100)}% in ${MAP_WINDOW_DAYS} days.`,
    timely: false,
    weight: 50,
    eligible: (ctx) => ctx.bestMap !== null,
    build: (ctx) => {
      const m = ctx.bestMap!;
      return {
        id: "map-edge",
        category: "map",
        tone: "positive",
        kicker: "Queue thought",
        title: `${m.name} is your happy place`,
        body: `${pctLabel(m.winRate)} over ${m.decided} recent games${m.inPool ? " — and it's in the current pool, so spend your vetoes elsewhere" : ""}.`,
        stat: pctLabel(m.winRate),
        statLabel: `${m.decided} recent decided`,
        targetTab: "battlefield",
      };
    },
  },
  {
    id: "matchup-shift",
    category: "matchup",
    requires: `A matchup moving ≥${Math.round(MATCHUP_MIN_DELTA * 100)}pts vs career over ${MATCHUP_RECENT_DAYS} days.`,
    timely: false,
    weight: 50,
    eligible: (ctx) => ctx.matchupShift !== null,
    build: (ctx) => {
      const s = ctx.matchupShift!;
      const up = s.delta > 0;
      const race = RACE_NAME[s.race];
      return {
        id: "matchup-shift",
        category: "matchup",
        tone: up ? "positive" : "warning",
        kicker: up ? "Matchup heating up" : "Matchup cooling off",
        title: up
          ? `Your vs-${race} game is peaking`
          : `Vs ${race} has gone cold`,
        body: `${pctLabel(s.recentWinRate)} across ${s.recentDecided} games these ${MATCHUP_RECENT_DAYS} days, against ${pctLabel(s.careerWinRate)} career. ${
          up
            ? "Whatever you changed, keep it."
            : "Worth a replay review before it hardens into a habit."
        }`,
        stat: `${s.delta > 0 ? "+" : ""}${Math.round(s.delta * 100)}pts`,
        statLabel: `vs ${race}, recent vs career`,
        targetTab: "strategies",
      };
    },
  },
  {
    id: "milestone-watch",
    category: "milestone",
    requires: `Within ${MILESTONE_GAMES_WITHIN} games (or ${MILESTONE_WINS_WITHIN} wins) of a round-number milestone.`,
    timely: false,
    weight: 40,
    eligible: (ctx) => ctx.milestone !== null,
    build: (ctx) => {
      const m = ctx.milestone!;
      const noun = m.kind === "games" ? "career game" : "career win";
      return {
        id: "milestone-watch",
        category: "milestone",
        tone: "accent",
        kicker: "Milestone watch",
        title: `${noun} #${m.target.toLocaleString()} is in sight`,
        body:
          m.kind === "games"
            ? `You've logged ${m.current.toLocaleString()} games — ${m.remaining} more and the odometer rolls over.`
            : `You're on ${m.current.toLocaleString()} wins — ${m.remaining} more takes the round number.`,
        stat: String(m.remaining),
        statLabel: m.kind === "games" ? "games to go" : "wins to go",
        targetTab: "trends",
      };
    },
  },
  {
    id: "on-this-day",
    category: "throwback",
    requires: "≥1 game on this calendar day 1/3/6/12 months back.",
    timely: false,
    weight: 35,
    eligible: (ctx) => ctx.throwback !== null,
    build: (ctx) => {
      const t = ctx.throwback!;
      const n = t.notable;
      const notableBit = n
        ? ` The one to remember: ${n.won ? "a win over" : "a scrap with"} ${
            n.opponentName ?? "an unnamed opponent"
          }${n.oppMmr !== null ? ` (${n.oppMmr.toLocaleString()} MMR)` : ""}${
            n.map ? ` on ${n.map}` : ""
          }.`
        : "";
      return {
        id: "on-this-day",
        category: "throwback",
        tone: "neutral",
        kicker: t.label,
        title: `On this day: ${t.wins}–${t.losses} across ${t.games} game${t.games === 1 ? "" : "s"}`,
        body: `Same calendar day, ${t.dateKey}.${notableBit}`,
        stat: `${t.wins}–${t.losses}`,
        statLabel: t.dateKey,
        targetTab: "arcade",
      };
    },
  },
  {
    id: "macro-trend",
    category: "macro",
    requires: `≥${MACRO_TREND_MIN_SCORED} macro-scored games and a recent-vs-career move of ≥${MACRO_TREND_MIN_DELTA}pts.`,
    timely: false,
    weight: 40,
    eligible: (ctx) => ctx.macroDelta !== null,
    build: (ctx) => {
      const delta = ctx.macroDelta!;
      const up = delta > 0;
      const recent = Math.round(ctx.macroRecentAvg ?? 0);
      const career = Math.round(ctx.macroCareerAvg ?? 0);
      return {
        id: "macro-trend",
        category: "macro",
        tone: up ? "positive" : "warning",
        kicker: "Macro trend",
        title: up
          ? "Your macro is sharpening"
          : "Your macro has slipped a notch",
        body: `Recent macro score averages ${recent}, against ${career} career. ${
          up
            ? "The mechanical work is paying off."
            : "A worker-cut check on the last few replays should find the leak."
        }`,
        stat: `${up ? "+" : ""}${Math.round(delta)}`,
        statLabel: "recent vs career",
        targetTab: "macro",
      };
    },
  },
];

/* ──────────────── selection ──────────────── */

/**
 * Pick today's cards, deterministically for (user, day):
 *
 *   1. Timely cards (session / streak / mmr — "right now" signals) win
 *      up to TIMELY_MAX slots by weight, one per category. The seeded
 *      shuffle breaks weight ties so even the timely mix rotates when
 *      two cards compete.
 *   2. Evergreen cards fill the remaining slots from a seeded shuffle
 *      with category dedupe — a different mix every day.
 *
 * A thin corpus simply yields fewer cards; zero eligible cards yields
 * an empty strip (the component hides itself). Nothing is synthesised.
 */
export function selectDailyPulse(
  dateKey: string,
  games: ReadonlyArray<ArcadeGame>,
  opts: {
    userId?: string;
    tz?: string;
    mapPool?: ReadonlyArray<string>;
    count?: number;
  } = {},
): DailyPulseSelection {
  const userId = opts.userId ?? "anonymous";
  const tz = opts.tz ?? "UTC";
  const count = opts.count ?? DAILY_PULSE_COUNT;
  const context = buildPulseContext(games, dateKey, tz, opts.mapPool ?? []);
  const eligible = PULSE_POOL.filter((spec) => spec.eligible(context));
  // "#pulse" namespace decorrelates this stream from the quest shuffle
  // that seeds with the bare (userId, dateKey) pair.
  const rng = mulberry32(dailySeed(userId, `${dateKey}#pulse`));

  const seen = new Set<PulseCategory>();
  const cards: PulseCard[] = [];

  const timely = shuffle(
    eligible.filter((s) => s.timely),
    rng,
  ).sort((a, b) => b.weight - a.weight); // stable → rng breaks ties
  for (const spec of timely) {
    if (cards.length >= Math.min(TIMELY_MAX, count)) break;
    if (seen.has(spec.category)) continue;
    seen.add(spec.category);
    cards.push(spec.build(context));
  }

  const evergreen = shuffle(
    eligible.filter((s) => !s.timely),
    rng,
  );
  for (const spec of evergreen) {
    if (cards.length >= count) break;
    if (seen.has(spec.category)) continue;
    seen.add(spec.category);
    cards.push(spec.build(context));
  }

  return { dateKey, context, cards };
}
