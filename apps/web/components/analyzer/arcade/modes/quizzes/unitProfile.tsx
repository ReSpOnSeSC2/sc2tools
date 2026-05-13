"use client";

import { useState, type ReactNode } from "react";
import { QuizAnswerButton, QuizCard } from "../../shells/QuizCard";
import { IconFor } from "../../icons";
import { pickN, registerMode, shuffle } from "../../ArcadeEngine";
import type {
  ArcadeUnitStats,
  GenerateInput,
  GenerateResult,
  Mode,
  ScoreResult,
} from "../../types";

const ID = "unit-profile";
registerMode(ID, "hidden-derivation");

/**
 * Unit Profile — four trivia variants over the user's recent-window
 * unit-production aggregate exposed by /v1/arcade/unit-stats:
 *
 *   "built"          — Which unit have you built the most of?
 *   "lost"           — How many units have you lost in total?
 *   "lost-per-game"  — On average, how many units have you lost per game?
 *   "diversity"      — How many distinct unit types do you build?
 *
 * The four angles share a discriminated-union ``Q`` so the engine picks
 * a single variant per round. Daily mode rolls a deterministic variant
 * via the seeded RNG; all four gate on the unit-stats endpoint returning
 * a non-trivial aggregate so a brand-new user doesn't see "the correct
 * answer is 0 units".
 */

export type UnitProfileVariant =
  | "built"
  | "lost"
  | "lost-per-game"
  | "diversity";

const BUILT_MIN_SCANNED = 25;
const LOST_MIN_GAMES = 10;
const DIVERSITY_MIN_DISTINCT = 6;

interface BuiltQ {
  variant: "built";
  options: string[];
  truth: string;
  /** Total count of the correct (most-built) unit. */
  truthValue: number;
  /** Per-option counts for the reveal panel. */
  countsByOption: Record<string, number>;
  scannedGames: number;
}

const LOST_BUCKETS = [
  "Under 500",
  "500 – 2,500",
  "2,500 – 10,000",
  "10,000+",
] as const;
type LostBucket = (typeof LOST_BUCKETS)[number];

interface LostQ {
  variant: "lost";
  options: ReadonlyArray<string>;
  truth: LostBucket;
  /** Σ of macroBreakdown.player_stats.me.units_lost across scanned games. */
  truthValue: number;
  scannedGames: number;
  lostGames: number;
}

const LOST_PER_GAME_BUCKETS = [
  "Under 10",
  "10 – 30",
  "30 – 75",
  "75+",
] as const;
type LostPerGameBucket = (typeof LOST_PER_GAME_BUCKETS)[number];

interface LostPerGameQ {
  variant: "lost-per-game";
  options: ReadonlyArray<string>;
  truth: LostPerGameBucket;
  /** Average units-lost per game (totalUnitsLost / lostGames). */
  truthValue: number;
  totalUnitsLost: number;
  lostGames: number;
}

const DIVERSITY_BUCKETS = [
  "Under 6",
  "6 – 12",
  "12 – 20",
  "20+",
] as const;
type DiversityBucket = (typeof DIVERSITY_BUCKETS)[number];

interface DiversityQ {
  variant: "diversity";
  options: ReadonlyArray<string>;
  truth: DiversityBucket;
  /** Number of distinct unit names with count > 0. */
  truthValue: number;
  scannedGames: number;
  /** Top-5 unit names by count, for the reveal panel. */
  topUnits: Array<{ name: string; count: number }>;
}

type Q = BuiltQ | LostQ | LostPerGameQ | DiversityQ;
type A = string;

export function bucketForUnitsLost(n: number): LostBucket {
  if (!Number.isFinite(n) || n < 500) return "Under 500";
  if (n < 2_500) return "500 – 2,500";
  if (n < 10_000) return "2,500 – 10,000";
  return "10,000+";
}

export function bucketForLostPerGame(avg: number): LostPerGameBucket {
  if (!Number.isFinite(avg) || avg < 10) return "Under 10";
  if (avg < 30) return "10 – 30";
  if (avg < 75) return "30 – 75";
  return "75+";
}

export function bucketForDiversity(distinct: number): DiversityBucket {
  if (!Number.isFinite(distinct) || distinct < 6) return "Under 6";
  if (distinct < 12) return "6 – 12";
  if (distinct < 20) return "12 – 20";
  return "20+";
}

/**
 * Pick the user's top-built unit + 3 distractor units. Distractors
 * are sampled from the next-most-built units so the question is
 * answerable but not trivial — the order matters (we want
 * "Marine vs Marauder vs Reaper", not "Marine vs Pylon"). If the
 * user only ever builds one kind of unit we fall back to lower-count
 * names; below 4 distinct unit names the variant is rejected.
 *
 * Pure: deterministic for a given RNG seed, so daily mode is stable
 * across devices.
 */
export function buildBuiltQuestion(
  stats: ArcadeUnitStats,
  rng: () => number,
): BuiltQ | null {
  const entries = Object.entries(stats.builtByUnit || {}).filter(
    ([, v]) => Number.isFinite(v) && v > 0,
  );
  if (entries.length < 4) return null;
  entries.sort((a, b) => b[1] - a[1]);
  // Reject when the leader and the 4th-place candidate are tied —
  // there's no objectively "most-built" unit in that case and the
  // reveal would have to say "tied with X" which the bucket UI
  // doesn't support.
  if (entries[0][1] === entries[3][1]) return null;
  const correct = entries[0][0];
  const correctCount = entries[0][1];
  // Distractor pool: candidates with strictly lower count than the
  // leader. Pull 3 from the top of that pool (most-built losers)
  // before random-shuffling them into the 4-option slate.
  const losers = entries.slice(1).filter(([, c]) => c < correctCount);
  if (losers.length < 3) return null;
  const distractorPool = losers.slice(0, Math.max(3, Math.min(8, losers.length)));
  const distractors = pickN(distractorPool.map(([n]) => n), 3, rng);
  const options = shuffle([correct, ...distractors], rng);
  const countsByOption: Record<string, number> = {};
  for (const [name, count] of entries) countsByOption[name] = count;
  return {
    variant: "built",
    options,
    truth: correct,
    truthValue: correctCount,
    countsByOption: Object.fromEntries(
      options.map((o) => [o, countsByOption[o] || 0]),
    ),
    scannedGames: stats.scannedGames,
  };
}

export function buildLostQuestion(stats: ArcadeUnitStats): LostQ | null {
  if (stats.lostGames < LOST_MIN_GAMES) return null;
  const total = Number(stats.totalUnitsLost);
  if (!Number.isFinite(total) || total <= 0) return null;
  return {
    variant: "lost",
    options: LOST_BUCKETS,
    truth: bucketForUnitsLost(total),
    truthValue: total,
    scannedGames: stats.scannedGames,
    lostGames: stats.lostGames,
  };
}

export function buildLostPerGameQuestion(
  stats: ArcadeUnitStats,
): LostPerGameQ | null {
  if (stats.lostGames < LOST_MIN_GAMES) return null;
  const total = Number(stats.totalUnitsLost);
  if (!Number.isFinite(total) || total <= 0) return null;
  const avg = total / stats.lostGames;
  return {
    variant: "lost-per-game",
    options: LOST_PER_GAME_BUCKETS,
    truth: bucketForLostPerGame(avg),
    truthValue: avg,
    totalUnitsLost: total,
    lostGames: stats.lostGames,
  };
}

export function buildDiversityQuestion(
  stats: ArcadeUnitStats,
): DiversityQ | null {
  const entries = Object.entries(stats.builtByUnit || {}).filter(
    ([, v]) => Number.isFinite(v) && v > 0,
  );
  if (entries.length < DIVERSITY_MIN_DISTINCT) return null;
  entries.sort((a, b) => b[1] - a[1]);
  return {
    variant: "diversity",
    options: DIVERSITY_BUCKETS,
    truth: bucketForDiversity(entries.length),
    truthValue: entries.length,
    scannedGames: stats.scannedGames,
    topUnits: entries.slice(0, 5).map(([name, count]) => ({ name, count })),
  };
}

async function generate(input: GenerateInput): Promise<GenerateResult<Q>> {
  const stats = input.data.unitStats;
  if (!stats || stats.scannedGames < BUILT_MIN_SCANNED) {
    return {
      ok: false,
      reason:
        "Play more games — Unit Profile needs detailed build-log history before it can quiz you.",
    };
  }
  // Variant rotation: shuffle the 4 candidates via the seeded RNG and
  // return the first that gate-passes. Daily seed pins the variant
  // stably; Quick Play rotates across runs.
  const order = shuffle(
    ["built", "lost", "lost-per-game", "diversity"] as UnitProfileVariant[],
    input.rng,
  );
  for (const v of order) {
    let q: Q | null = null;
    if (v === "built") q = buildBuiltQuestion(stats, input.rng);
    else if (v === "lost") q = buildLostQuestion(stats);
    else if (v === "lost-per-game") q = buildLostPerGameQuestion(stats);
    else q = buildDiversityQuestion(stats);
    if (q) {
      return { ok: true, minDataMet: true, question: q };
    }
  }
  return {
    ok: false,
    reason:
      "Not enough distinct units / lost-game data yet — Unit Profile will unlock as you play more.",
  };
}

function score(q: Q, a: A): ScoreResult {
  const correct = a === q.truth;
  let note: string;
  if (q.variant === "built") {
    note = `Top-built: ${q.truth} (${q.truthValue.toLocaleString()} entries across your last ${q.scannedGames} games).`;
  } else if (q.variant === "lost") {
    note = `Total units lost: ${q.truthValue.toLocaleString()} across ${q.lostGames} games.`;
  } else if (q.variant === "lost-per-game") {
    note = `Avg units lost per game: ${q.truthValue.toFixed(1)} across ${q.lostGames} games (${q.totalUnitsLost.toLocaleString()} total).`;
  } else {
    note = `Distinct units built: ${q.truthValue.toLocaleString()} across your last ${q.scannedGames} games.`;
  }
  return {
    raw: correct ? 1 : 0,
    xp: correct ? 14 : 0,
    outcome: correct ? "correct" : "wrong",
    note,
  };
}

export const unitProfile: Mode<Q, A> = {
  id: ID,
  kind: "quiz",
  category: "builds",
  difficulty: "medium",
  ttp: "fast",
  depthTag: "hidden-derivation",
  title: "Unit Profile",
  blurb:
    "Four angles on the units in your own build-logs. How well do you know your own army?",
  generate,
  score,
  render: (ctx) => <Render ctx={ctx} />,
};

export const __test = {
  buildBuiltQuestion,
  buildLostQuestion,
  buildLostPerGameQuestion,
  buildDiversityQuestion,
  bucketForUnitsLost,
  bucketForLostPerGame,
  bucketForDiversity,
  BUILT_MIN_SCANNED,
  LOST_MIN_GAMES,
  DIVERSITY_MIN_DISTINCT,
};

function promptFor(q: Q): ReactNode {
  if (q.variant === "built") {
    return (
      <span>
        Which unit have you{" "}
        <span className="font-semibold">built the most of</span> across your last{" "}
        <span className="font-mono tabular-nums">{q.scannedGames}</span> games?
      </span>
    );
  }
  if (q.variant === "lost") {
    return (
      <span>
        Across <span className="font-mono tabular-nums">{q.lostGames}</span> of
        your recent games, roughly{" "}
        <span className="font-semibold">how many units have you lost</span> in
        total?
      </span>
    );
  }
  if (q.variant === "lost-per-game") {
    return (
      <span>
        On <span className="font-semibold">average</span>, roughly{" "}
        <span className="font-semibold">how many units do you lose per game</span>?{" "}
        (Across <span className="font-mono tabular-nums">{q.lostGames}</span> games
        with macro data.)
      </span>
    );
  }
  return (
    <span>
      Across your last{" "}
      <span className="font-mono tabular-nums">{q.scannedGames}</span> games,
      roughly{" "}
      <span className="font-semibold">
        how many distinct unit types have you built
      </span>{" "}
      at least once?
    </span>
  );
}

function depthLabelFor(q: Q): string {
  if (q.variant === "built") return "Cross-game buildLog tally";
  if (q.variant === "lost") return "Cross-game units-lost sum";
  if (q.variant === "lost-per-game") return "Cross-game units-lost average";
  return "Cross-game roster diversity";
}

function Render({
  ctx,
}: {
  ctx: Parameters<Mode<Q, A>["render"]>[0];
}) {
  const [picked, setPicked] = useState<A | null>(null);
  const onPick = (v: A) => {
    if (ctx.revealed) return;
    setPicked(v);
    ctx.onAnswer(v);
  };
  const reveal = ctx.score ? <Reveal q={ctx.question} score={ctx.score} /> : null;
  return (
    <QuizCard
      icon={IconFor(ID)}
      title={unitProfile.title}
      depthLabel={depthLabelFor(ctx.question)}
      isDaily={ctx.isDaily}
      revealed={ctx.revealed}
      onKeyAnswer={(i) => {
        const o = ctx.question.options[i];
        if (o) onPick(o);
      }}
      question={promptFor(ctx.question)}
      answers={ctx.question.options.map((o, i) => (
        <QuizAnswerButton
          key={o}
          index={i}
          selected={picked === o}
          correct={
            ctx.revealed
              ? o === ctx.question.truth
                ? true
                : picked === o
                  ? false
                  : null
              : null
          }
          onClick={() => onPick(o)}
          disabled={ctx.revealed}
        >
          {o}
        </QuizAnswerButton>
      ))}
      reveal={reveal}
    />
  );
}

function Reveal({ q, score }: { q: Q; score: ScoreResult }) {
  const headline = (
    <p>
      <span className="font-semibold">Answer:</span>{" "}
      <span className="font-mono tabular-nums text-success">{q.truth}</span>{" "}
      {score.outcome === "correct" ? (
        <span className="text-success">— right call.</span>
      ) : (
        <span className="text-warning">— it was {q.truth}.</span>
      )}
    </p>
  );
  return (
    <div className="space-y-2 text-caption text-text">
      {headline}
      {q.variant === "built" ? <BuiltDetail q={q} /> : null}
      {q.variant === "lost" ? <LostDetail q={q} /> : null}
      {q.variant === "lost-per-game" ? <LostPerGameDetail q={q} /> : null}
      {q.variant === "diversity" ? <DiversityDetail q={q} /> : null}
    </div>
  );
}

function BuiltDetail({ q }: { q: BuiltQ }) {
  return (
    <ul className="space-y-1" aria-label="Per-option build counts">
      {q.options.map((o) => (
        <li
          key={o}
          className="flex items-center justify-between rounded border border-border bg-bg-surface px-2 py-1"
        >
          <span className={o === q.truth ? "text-text" : "text-text-muted"}>{o}</span>
          <span className="font-mono tabular-nums text-text-dim">
            {(q.countsByOption[o] || 0).toLocaleString()}
          </span>
        </li>
      ))}
    </ul>
  );
}

function LostDetail({ q }: { q: LostQ }) {
  return (
    <p className="text-text-muted">
      Total over <span className="font-mono tabular-nums">{q.lostGames}</span>{" "}
      games with macro data:{" "}
      <span className="font-mono tabular-nums text-text">
        {q.truthValue.toLocaleString()}
      </span>{" "}
      units.
    </p>
  );
}

function LostPerGameDetail({ q }: { q: LostPerGameQ }) {
  return (
    <p className="text-text-muted">
      Average of{" "}
      <span className="font-mono tabular-nums text-text">
        {q.truthValue.toFixed(1)}
      </span>{" "}
      units per game —{" "}
      <span className="font-mono tabular-nums">{q.totalUnitsLost.toLocaleString()}</span>{" "}
      lost across{" "}
      <span className="font-mono tabular-nums">{q.lostGames}</span> games with
      macro data.
    </p>
  );
}

function DiversityDetail({ q }: { q: DiversityQ }) {
  return (
    <div className="space-y-1 text-text-muted">
      <p>
        You've built{" "}
        <span className="font-mono tabular-nums text-text">
          {q.truthValue.toLocaleString()}
        </span>{" "}
        distinct unit types across your last{" "}
        <span className="font-mono tabular-nums">{q.scannedGames}</span> games.
      </p>
      {q.topUnits.length ? (
        <ul className="space-y-1" aria-label="Top units">
          {q.topUnits.map((u) => (
            <li
              key={u.name}
              className="flex items-center justify-between rounded border border-border bg-bg-surface px-2 py-1"
            >
              <span className="truncate">{u.name}</span>
              <span className="font-mono tabular-nums text-text-dim">
                {u.count.toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
