import { describe, expect, test } from "vitest";
import { sharedDay } from "@/lib/sharePrivacy";
import { compareReportCards, decodeReportComparison, encodeReportComparison } from "@/lib/instant/reportCardLink";
import { mulberry32 } from "../ArcadeEngine";
import { ALL_MODES, type AnyMode } from "../modes";
import { buildShareSummary } from "../shareSummary";
import type {
  ArcadeBuild,
  ArcadeDataset,
  ArcadeGame,
  ArcadeOpponent,
  GenerateInput,
  ScoreResult,
} from "../types";

/**
 * Share-card privacy contract for every Arcade mode.
 *
 * A share card is public once sent, and the opponents in a player's
 * history never agreed to be on one (lib/sharePrivacy.ts). This test plays
 * every mode against histories whose opponents carry sentinel names, ids
 * and ratings, then checks that no sentinel, and no time of day, reaches
 * the card's question or answer lines.
 *
 * It also proves it is looking in the right place: for each mode known to
 * handle opponent identity, at least one generated round must carry a
 * sentinel name in its in-app payload. If a mode stops doing so, the
 * fixture has gone stale and the "no leak" result would mean nothing.
 */

const DAY_MS = 86_400_000;
const NOW = Date.now();

/* ──────────── sentinel opponents ──────────── */

const displayName = (k: number) => `Zq9Name${k}`;
const rawName = (k: number) => `Zq9Raw${k}`;
const pulseId = (k: number) => `zq9pulse-${k}`;
const characterId = (k: number) => `99${1000 + k}77`;
const toonHandle = (k: number) => `9-S2-9-${880000 + k}`;
const exactMmr = (k: number) => 6901 + k * 3;

/** One six-game sitting per opponent; the letter is the player's result. */
const SITTINGS = ["WWWWWW", "LLWWWW", "WWWWLL", "LLLLLW", "LLLWWW"];
/** Two long rivalries: one dead even, one lopsided. */
const LONG_RIVALRIES = ["WLWLWLWLWL", "WWWWWLWWWW"];
const SITTING_COUNT = 24;
const OPPONENT_COUNT = SITTING_COUNT + LONG_RIVALRIES.length;

const RACES = ["Zerg", "Terran", "Protoss"] as const;
const MAPS = ["Goldenaura LE", "Hard Lead LE", "Oceanborn LE", "Site Delta LE"];
const BUILDS = [
  "PvZ - Stargate Opener",
  "PvT - Blink Stalkers",
  "PvP - Proxy Robo",
  "PvZ - Glaive Adepts",
  "PvT - Colossus Push",
  "PvP - Four Gate",
];
const OPP_STRATEGIES = [
  "Zerg - Roach Push",
  "Terran - Bio Timing",
  "Protoss - Oracle Opener",
  "Zerg - Hatch First Macro",
  "Terran - Mech",
];

const SENTINELS: string[] = [
  "Zq9Name",
  "Zq9Raw",
  "zq9pulse",
  "zq9game",
  "9-S2-9-",
  ...Array.from({ length: OPPONENT_COUNT }, (_, k) => characterId(k)),
];
const EXACT_MMR = new RegExp(
  `\\b(?:${Array.from({ length: OPPONENT_COUNT }, (_, k) => exactMmr(k)).join("|")})\\b`,
);
/** A time to the second ("9:14:32 PM"), which would single out one game. */
const CLOCK_TIME = /\b\d{1,2}:\d{2}:\d{2}\b/;

test("the replay comparison contains only the two selected game records", () => {
  const own = {
    totals: { games: 10, wins: 7, losses: 2, name: displayName(1), mmr: exactMmr(1) },
    matchups: [], opener: null, macro: null, account: toonHandle(1),
  };
  const shared = {
    totals: { games: 8, wins: 4, losses: 3, name: rawName(2), mmr: exactMmr(2) },
    matchups: [], opener: null, macro: null, gameId: "zq9game", date: "2026-10-01T08:02:03Z",
  };
  const expected = { first: { games: 10, wins: 7, losses: 2 }, second: { games: 8, wins: 4, losses: 3 } };
  const comparison = compareReportCards(own, shared);
  expect(comparison).toEqual(expected);
  if (!comparison) throw new Error("Missing comparison");
  const fragment = encodeReportComparison(comparison);
  expect(fragment).toMatch(/^[A-Za-z0-9_-]{1,59}$/);
  expect(decodeReportComparison(fragment!)).toEqual(expected);
});

function leaks(text: string): string[] {
  const found = SENTINELS.filter((s) => text.includes(s));
  const mmr = EXACT_MMR.exec(text);
  if (mmr) found.push(`opponent MMR ${mmr[0]}`);
  const clock = CLOCK_TIME.exec(text);
  if (clock) found.push(`time of day ${clock[0]}`);
  return found;
}

/* ──────────── fixtures ──────────── */

/**
 * How well the opponents are known:
 * - "named": every opponent is in the opponents list with a resolved name;
 * - "unresolved": no resolved names, so the app falls back to raw names;
 * - "unlisted": the opponents list is empty, so the app falls back to
 *   whatever the game rows carry (names and SC2Pulse ids).
 */
type Knowledge = "named" | "unresolved" | "unlisted";

function buildDataset(knowledge: Knowledge): ArcadeDataset {
  const games: ArcadeGame[] = [];
  const plan = [
    ...Array.from({ length: SITTING_COUNT }, (_, k) => SITTINGS[k % SITTINGS.length]),
    ...LONG_RIVALRIES,
  ];
  // One sitting a day, oldest first, ending two days ago so every game is
  // settled history for the modes that skip today's play. Each starts at
  // an odd second, so a leaked clock time is easy to tell from a duration.
  const firstDay = NOW - (plan.length + 2) * DAY_MS;
  plan.forEach((sitting, k) => {
    const race = RACES[k % RACES.length];
    const shownName = knowledge === "unresolved" ? rawName(k) : displayName(k);
    [...sitting].forEach((letter, i) => {
      const n = games.length;
      games.push({
        gameId: `zq9game-${n}`,
        date: new Date(firstDay + k * DAY_MS + i * 20 * 60_000 + 37_000).toISOString(),
        result: letter === "W" ? "Victory" : "Defeat",
        myToonHandle: "1-S2-1-4040404",
        myRace: "Protoss",
        oppRace: race,
        myMmr: 4000 + n,
        oppMmr: exactMmr(k),
        duration: 300 + ((n * 37) % 1200),
        map: MAPS[n % MAPS.length],
        myBuild: BUILDS[n % BUILDS.length],
        opp_strategy: OPP_STRATEGIES[k % OPP_STRATEGIES.length],
        oppPulseId: pulseId(k),
        opponent: {
          toonHandle: toonHandle(k),
          displayName: shownName,
          mmr: exactMmr(k),
          race,
          strategy: OPP_STRATEGIES[k % OPP_STRATEGIES.length],
          pulseId: pulseId(k),
          pulseCharacterId: characterId(k),
        },
        macro_score: 30 + (n % 60),
      });
    });
  });

  const tally = <K extends string>(keyOf: (g: ArcadeGame) => K) => {
    const out = new Map<K, { wins: number; losses: number; last: string }>();
    for (const g of games) {
      const row = out.get(keyOf(g)) ?? { wins: 0, losses: 0, last: g.date };
      if (g.result === "Victory") row.wins += 1;
      else row.losses += 1;
      row.last = g.date;
      out.set(keyOf(g), row);
    }
    return out;
  };

  const byOpponent = tally((g) => g.oppPulseId ?? "");
  const opponents: ArcadeOpponent[] =
    knowledge === "unlisted"
      ? []
      : plan.map((_, k) => {
          const row = byOpponent.get(pulseId(k))!;
          const total = row.wins + row.losses;
          return {
            pulseId: pulseId(k),
            pulseCharacterId: knowledge === "named" ? characterId(k) : null,
            name: rawName(k),
            displayName: knowledge === "named" ? displayName(k) : null,
            wins: row.wins,
            losses: row.losses,
            games: total,
            userWinRate: row.wins / total,
            opponentWinRate: row.losses / total,
            lastPlayed: row.last,
          };
        });

  const builds: ArcadeBuild[] = [...tally((g) => g.myBuild ?? "")].map(([name, row]) => ({
    name,
    total: row.wins + row.losses,
    wins: row.wins,
    losses: row.losses,
    winRate: row.wins / (row.wins + row.losses),
    race: "Protoss",
    lastPlayed: row.last,
  }));

  const wins = games.filter((g) => g.result === "Victory").length;
  return {
    sessionPolicy: { gapMinutes: 45, source: "preference", storedGapMinutes: 45 },
    games,
    opponents,
    builds,
    customBuilds: [],
    communityBuilds: [],
    matchups: [...tally((g) => g.oppRace ?? "")].map(([race, row]) => ({
      name: `vs ${race.charAt(0)}`,
      oppRace: race.charAt(0) as "P" | "T" | "Z",
      wins: row.wins,
      losses: row.losses,
      total: row.wins + row.losses,
      winRate: row.wins / (row.wins + row.losses),
    })),
    maps: [...tally((g) => g.map ?? "")].map(([map, row]) => ({
      map,
      wins: row.wins,
      losses: row.losses,
      total: row.wins + row.losses,
      winRate: row.wins / (row.wins + row.losses),
    })),
    summary: {
      totalGames: games.length,
      wins,
      losses: games.length - wins,
      winRate: wins / games.length,
    },
    mapPool: MAPS,
    unitStats: {
      scannedGames: 150,
      builtByUnit: {
        Probe: 4210,
        Zealot: 930,
        Stalker: 715,
        Immortal: 318,
        Sentry: 122,
        Colossus: 84,
        Archon: 61,
        Carrier: 43,
      },
      totalUnitsLost: 12480,
      lostGames: 140,
    },
  };
}

/* ──────────── playing a round ──────────── */

interface PlayedRound {
  /** The in-app payload, to prove the fixture reaches the mode. */
  question: Record<string, unknown>;
  inApp: string;
  /** Everything the share card would carry, one entry per answer tried. */
  cards: string[];
}

/** A right and a wrong answer in whatever shape the mode's question implies. */
function answersFor(question: unknown): unknown[] {
  const q = question as Record<string, unknown>;
  if (typeof q.correctIndex === "number") {
    return [q.correctIndex, q.correctIndex === 0 ? 1 : 0];
  }
  if (typeof q.lieIndex === "number") return [q.lieIndex, (q.lieIndex + 1) % 3];
  if (Array.isArray(q.truth)) return [q.truth, [...q.truth].reverse()];
  if (typeof q.truth === "string") return [q.truth, "not-the-answer"];
  if (Array.isArray(q.stack)) return [{ chain: 2 }, { chain: 0 }];
  if (Array.isArray(q.quotes)) {
    const picks = (q.quotes as Array<{ id: string }>)
      .slice(0, 2)
      .map((quote) => ({ id: quote.id, alloc: 50 }));
    return [{ picks }, null];
  }
  return [null];
}

/** Scoring is not under test here: a mode may reject a made-up answer. */
function scoreFor(mode: AnyMode, question: unknown, answer: unknown): ScoreResult {
  try {
    return mode.score(question, answer);
  } catch {
    return { raw: 0, xp: 0, outcome: "wrong" };
  }
}

async function playRounds(mode: AnyMode, data: ArcadeDataset): Promise<PlayedRound[]> {
  // 24 daily seeds walk every day-pinned variant (Group Census has 24,
  // Buildle 9, Comeback Count 5); 40 Quick Play seeds cover the randomly
  // chosen ones.
  const inputs: GenerateInput[] = [
    ...Array.from({ length: 24 }, (_, day) => ({
      rng: mulberry32(1000 + day),
      daySeed: `2026-01-${String(day + 1).padStart(2, "0")}`,
      tz: "UTC",
      data,
    })),
    ...Array.from({ length: 40 }, (_, seed) => ({
      rng: mulberry32(seed + 1),
      daySeed: "",
      tz: "UTC",
      data,
    })),
  ];
  const rounds: PlayedRound[] = [];
  for (const input of inputs) {
    const generated = await mode.generate(input);
    if (!generated.ok) continue;
    const share = mode.share;
    if (!share) throw new Error(`${mode.id} has no share()`);
    const cards = answersFor(generated.question).map((answer) => {
      const score = scoreFor(mode, generated.question, answer);
      const summary = share(generated.question, answer, score);
      // The runner must hand the card exactly what the mode decided.
      expect(buildShareSummary(mode, generated.question, answer, score)).toEqual(summary);
      return [summary.question, ...summary.answer].join("\n");
    });
    rounds.push({
      question: generated.question as Record<string, unknown>,
      inApp: JSON.stringify(generated.question),
      cards,
    });
  }
  return rounds;
}

/* ──────────── the contract ──────────── */

/** An opponent's resolved or raw name, as the app shows it. */
const IN_APP_NAME = /Zq9(?:Name|Raw)\d/;

/** Modes whose in-app round shows who the opponent was. */
const OPPONENT_FACING = [
  "opponent-bracket-pick",
  "rivalry-ranker",
  "active-streak-hunter",
  "streak-veto",
  "macro-memory",
  "group-census",
  "buildle",
  "two-truths-lie",
];

const MODES = ALL_MODES.map((mode) => [mode.id, mode] as const);

describe("Arcade share cards never identify an opponent", () => {
  const data = buildDataset("named");

  test("the fixture's sentinels are detectable", () => {
    expect(leaks(`vs ${displayName(3)} (${exactMmr(3)})`)).toEqual([
      "Zq9Name",
      `opponent MMR ${exactMmr(3)}`,
    ]);
    expect(leaks("11/7/2026, 9:14:37 PM · 4W / 2L")).toEqual(["time of day 9:14:37"]);
    // Durations and percentages are not times of day.
    expect(leaks("Rival A · 62.5% (5-3) · 11:40 on the clock · Nov 7, 2026")).toEqual([]);
    expect(OPPONENT_FACING.every((id) => ALL_MODES.some((m) => m.id === id))).toBe(true);
  });

  test.each(MODES)("%s", async (id, mode) => {
    const rounds = await playRounds(mode, data);
    expect(rounds.length, `${id} never generated a round from the fixture`).toBeGreaterThan(0);

    if (OPPONENT_FACING.includes(id)) {
      expect(
        rounds.some((round) => IN_APP_NAME.test(round.inApp)),
        `${id} no longer shows an opponent in the app; the fixture is stale`,
      ).toBe(true);
    }

    for (const round of rounds) {
      for (const card of round.cards) {
        expect(leaks(card), `${id} share card:\n${card}`).toEqual([]);
      }
    }
  });
});

describe.each(["unresolved", "unlisted"] as const)(
  "Arcade share cards with %s opponents",
  (knowledge) => {
    // With no resolved names the app falls back to raw names, and with no
    // opponents list to the names and SC2Pulse ids on the game rows. Fewer
    // modes can build a round here; whatever they build must still be clean.
    const data = buildDataset(knowledge);

    test("every round that can be built is clean, and some still show an opponent in the app", async () => {
      let rounds = 0;
      let showingAnOpponent = 0;
      for (const [id, mode] of MODES) {
        for (const round of await playRounds(mode, data)) {
          rounds += 1;
          if (/Zq9(?:Name|Raw)\d|zq9pulse/.test(round.inApp)) showingAnOpponent += 1;
          for (const card of round.cards) {
            expect(leaks(card), `${id} share card:\n${card}`).toEqual([]);
          }
        }
      }
      expect(rounds).toBeGreaterThan(100);
      expect(showingAnOpponent).toBeGreaterThan(20);
    });
  },
);

describe("Comeback Count dates its sessions to the day", () => {
  const mode = ALL_MODES.find((m) => m.id === "comeback-count")!;

  test("count and recency cards carry the day and never the time", async () => {
    const rounds = await playRounds(mode, buildDataset("named"));
    const counts = rounds.filter((r) => r.question.variant === "count");
    const recencies = rounds.filter((r) => r.question.variant === "recency");
    expect(counts.length).toBeGreaterThan(0);
    expect(recencies.length).toBeGreaterThan(0);

    for (const round of counts) {
      const comebacks = round.question.comebacks as Array<{ startDate: string }>;
      expect(comebacks.length).toBeGreaterThan(0);
      for (const card of round.cards) {
        for (const comeback of comebacks.slice(0, 6)) {
          expect(card).toContain(`${sharedDay(comeback.startDate)} · `);
        }
        expect(card).not.toMatch(CLOCK_TIME);
      }
    }
    for (const round of recencies) {
      const day = sharedDay(round.question.truthValue as string);
      for (const card of round.cards) {
        expect(card).toContain(`Most recent comeback: ${day}.`);
        expect(card).not.toMatch(CLOCK_TIME);
      }
    }
  });
});

describe("share summary fallback", () => {
  const namedNote: ScoreResult = {
    raw: 0,
    xp: 0,
    outcome: "wrong",
    note: "It was Zq9Name7 — your most recent loss.",
  };

  const stubMode = (share?: AnyMode["share"]): AnyMode =>
    ({
      id: "stub-mode",
      title: "Stub",
      blurb: "Pick the right one.",
      share,
    }) as unknown as AnyMode;

  test("a mode without share() gets the blurb and an outcome line, never the score note", () => {
    const summary = buildShareSummary(stubMode(), {}, 0, namedNote);
    expect(summary).toEqual({ question: "Pick the right one.", answer: ["Missed this one."] });
  });

  test("a share() that throws falls back the same way", () => {
    const summary = buildShareSummary(
      stubMode(() => {
        throw new Error("boom");
      }),
      {},
      0,
      { ...namedNote, outcome: "correct" },
    );
    expect(summary).toEqual({ question: "Pick the right one.", answer: ["Nailed it."] });
    expect(leaks(summary.answer.join("\n"))).toEqual([]);
  });

  test("each outcome has its own line, and no score means no outcome", () => {
    const line = (score: ScoreResult | null) =>
      buildShareSummary(stubMode(), {}, 0, score).answer;
    expect(line({ ...namedNote, outcome: "partial" })).toEqual(["Close, but not quite."]);
    expect(line(null)).toEqual(["I just played in Arcade."]);
  });
});
