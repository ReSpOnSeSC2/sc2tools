"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { dailySeed, mulberry32 } from "../ArcadeEngine";
import { GAMES, QUIZZES, type AnyMode } from "../modes";
import type { ArcadeDataset, GenerateInput } from "../types";
import { useDailySeed } from "./useDailySeed";

/**
 * useEligibleDailyPicks — probe every quiz and game with the current
 * daily seed + real dataset, then deterministically pick one of each
 * from the eligible subset.
 *
 * The previous Today picker used the daily RNG to index the full
 * 10-mode quiz catalog blindly. When the seed landed on a mode whose
 * generate() returned ok:false (e.g. Streak Hunter without enough
 * streak-bearing opponents in the user's history), the surface
 * rendered an empty card. This hook fixes that by asking every mode whether it can build
 * a round today and only picking from the survivors. Probes hit the
 * same generate() the runner will call, so eligibility is exact rather
 * than heuristic.
 */
export interface DailyPicks {
  quiz: AnyMode | null;
  game: AnyMode | null;
  eligibleQuizIds: string[];
  eligibleGameIds: string[];
  probing: boolean;
  /** Number of catalog slots skipped past to land on the chosen quiz. */
  quizSkips: number;
  gameSkips: number;
}

const EMPTY: DailyPicks = {
  quiz: null,
  game: null,
  eligibleQuizIds: [],
  eligibleGameIds: [],
  probing: true,
  quizSkips: 0,
  gameSkips: 0,
};

export function useEligibleDailyPicks(dataset: ArcadeDataset | null): DailyPicks {
  const seed = useDailySeed();
  const [snapshot, setSnapshot] = useState<{ corpusKey: string | null; picks: DailyPicks }>({ corpusKey: null, picks: EMPTY });
  const warnedRef = useRef<Set<string>>(new Set());

  // Keep the existing corpus-size trigger. Policy changes are a separate
  // eligibility input and must not replace an eligible independent round.
  const corpusKey = useMemo(() => {
    if (!dataset) return `${seed.userId}::${seed.day}::${seed.tz}::null`;
    return [seed.userId, seed.day, seed.tz, dataset.games.length,
      dataset.opponents.length, dataset.builds.length, dataset.matchups.length,
      dataset.maps.length].join("::");
  }, [seed.userId, seed.day, seed.tz, dataset]);
  const policy = dataset?.sessionPolicy;
  const memoKey = [corpusKey, policy?.gapMinutes ?? "unavailable",
    policy?.source ?? "", policy?.storedGapMinutes ?? ""].join("::");

  useEffect(() => {
    if (!dataset) {
      setSnapshot({ corpusKey, picks: EMPTY });
      return;
    }
    let cancelled = false;
    setSnapshot(previous => previous.corpusKey !== corpusKey
      ? { corpusKey, picks: EMPTY }
      : previous.picks.probing ? previous
        : { corpusKey, picks: { ...previous.picks, probing: true } });
    void runProbeAndPick({
      dataset,
      day: seed.day,
      tz: seed.tz,
      userId: seed.userId,
      warned: warnedRef.current,
    }).then(next => {
      if (cancelled) return;
      setSnapshot(previous => ({ corpusKey, picks: retainIndependentPicks(
        previous.corpusKey === corpusKey ? previous.picks : EMPTY, next,
      ) }));
    });
    return () => { cancelled = true; };
    // memoKey covers the owner/day/tz, existing corpus shape and policy scalars.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memoKey]);

  // Owner/day/corpus transitions cannot expose the previous selection while
  // the replacement probe is waiting for its effect or generators.
  return snapshot.corpusKey === corpusKey ? snapshot.picks : EMPTY;
}

function retainIndependentPicks(previous: DailyPicks, next: DailyPicks): DailyPicks {
  const keepQuiz = previous.quiz && !["first-game-of-day", "comeback-count"].includes(previous.quiz.id)
    && next.eligibleQuizIds.includes(previous.quiz.id);
  const keepGame = previous.game && next.eligibleGameIds.includes(previous.game.id);
  return { ...next,
    ...(keepQuiz ? { quiz: previous.quiz, quizSkips: previous.quizSkips } : {}),
    ...(keepGame ? { game: previous.game, gameSkips: previous.gameSkips } : {}),
  };
}

async function runProbeAndPick(args: {
  dataset: ArcadeDataset;
  day: string;
  tz: string;
  userId: string;
  warned: Set<string>;
}): Promise<DailyPicks> {
  const { dataset, day, tz, userId, warned } = args;
  const [quizResults, gameResults] = await Promise.all([
    Promise.all(QUIZZES.map((m) => probeMode(m, dataset, day, tz, userId, warned))),
    Promise.all(GAMES.map((m) => probeMode(m, dataset, day, tz, userId, warned))),
  ]);
  const eligibleQuizIds = QUIZZES.filter((_, i) => quizResults[i]).map((m) => m.id);
  const eligibleGameIds = GAMES.filter((_, i) => gameResults[i]).map((m) => m.id);

  const pickerRng = mulberry32(dailySeed(userId, day));
  const { mode: quiz, skips: quizSkips } = pickFromEligible(QUIZZES, eligibleQuizIds, pickerRng);
  const { mode: game, skips: gameSkips } = pickFromEligible(GAMES, eligibleGameIds, pickerRng);

  return {
    quiz,
    game,
    eligibleQuizIds,
    eligibleGameIds,
    probing: false,
    quizSkips,
    gameSkips,
  };
}

async function probeMode(
  mode: AnyMode,
  data: ArcadeDataset,
  day: string,
  tz: string,
  userId: string,
  warned: Set<string>,
): Promise<boolean> {
  // Fresh RNG per probe so one mode's draws don't perturb the picker.
  const input: GenerateInput = {
    rng: mulberry32(dailySeed(userId, day)),
    daySeed: day,
    tz,
    data,
  };
  try {
    const out = await mode.generate(input);
    return out.ok === true;
  } catch (err) {
    if (!warned.has(mode.id)) {
      warned.add(mode.id);
      console.warn(`[arcade] mode "${mode.id}" probe threw — marked ineligible.`, err);
    }
    return false;
  }
}

function pickFromEligible(
  catalog: AnyMode[],
  eligibleIds: string[],
  rng: () => number,
): { mode: AnyMode | null; skips: number } {
  if (catalog.length === 0 || eligibleIds.length === 0) {
    // Drain one rng() call so the second pick still indexes from a fresh draw.
    rng();
    return { mode: null, skips: 0 };
  }
  const eligibleSet = new Set(eligibleIds);
  const start = Math.floor(rng() * catalog.length);
  let skips = 0;
  for (let i = 0; i < catalog.length; i++) {
    const idx = (start + i) % catalog.length;
    const candidate = catalog[idx];
    if (eligibleSet.has(candidate.id)) {
      return { mode: candidate, skips };
    }
    skips += 1;
  }
  return { mode: null, skips };
}

/** Test-only re-export of the eligible-picker (prefixed `__` to flag). */
export const __pickFromEligible = pickFromEligible;
/** Test-only re-export of the per-mode probe. */
export const __probeMode = probeMode;
