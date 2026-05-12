"use client";

import { useState } from "react";
import { QuizAnswerButton, QuizCard } from "../../shells/QuizCard";
import { IconFor } from "../../icons";
import {
  longestLossStreak,
  longestWinStreak,
  registerMode,
  shuffle,
} from "../../ArcadeEngine";
import type {
  ArcadeGame,
  GenerateInput,
  GenerateResult,
  Mode,
  ScoreResult,
} from "../../types";

/**
 * Streak Hunter — pick the rival on the longest historical streak.
 *
 * The mode used to be "Active Streak Hunter" — it asked which rival
 * was currently on their longest unbroken win streak against you.
 * Two problems pushed the redesign:
 *
 *   1. With "active" required, the eligible pool collapsed to a
 *      handful of opponents and the same global leader (typically
 *      the player ahead on their most recent run-against-you) ended
 *      up as the correct answer round after round.
 *   2. The framing was one-sided — only opponent-vs-you streaks,
 *      never the user's streaks against rivals — which halved the
 *      possible answer space.
 *
 * The new mode looks at HISTORICAL longest streaks in either
 * direction (≥3-game runs anywhere in the chronology, not just the
 * trailing run), and each round picks one of FOUR phrasings so the
 * user sees real variety across the question text AND the metric:
 *
 *   • "their-win"  — "Which had the longest WIN streak against you?"
 *                    metric = the user's longest L-streak per opp
 *                    (= the opponent's longest W run vs the user)
 *   • "their-loss" — "Which had the longest LOSS streak against you?"
 *                    metric = the user's longest W-streak per opp
 *                    (= the opponent's longest L run vs the user)
 *   • "your-win"   — "Which did YOU have the longest WIN streak against?"
 *                    metric = the user's longest W-streak per opp
 *   • "your-loss"  — "Which did YOU have the longest LOSS streak against?"
 *                    metric = the user's longest L-streak per opp
 *
 * Note: their-win == your-loss in terms of metric (longestLoss), and
 * their-loss == your-win in terms of metric (longestWin). The
 * underlying answer pool collapses to two, but four phrasings keep
 * the question feeling varied round to round.
 *
 * Eligibility gate: ≥20 distinct opponents must carry a 3+ game
 * streak in at least one direction; below that we report
 * "Need more streak data" so the user knows the mode isn't broken,
 * it just doesn't have enough signal yet.
 */
export type StreakVariant =
  | "their-win"
  | "their-loss"
  | "your-win"
  | "your-loss";

/** All four variants — exported so tests can iterate exhaustively. */
export const STREAK_VARIANTS: StreakVariant[] = [
  "their-win",
  "their-loss",
  "your-win",
  "your-loss",
];

type Candidate = {
  pulseId: string;
  name: string;
  /** User's longest historical W-streak vs this opponent. */
  longestWin: number;
  /** User's longest historical L-streak vs this opponent
   *  (= opponent's longest W-streak from user POV). */
  longestLoss: number;
  games: number;
};

type Q = {
  variant: StreakVariant;
  candidates: Candidate[];
  /** Index of the candidate that satisfies the variant's question. */
  correctIndex: number;
};

type A = number;

const ID = "active-streak-hunter";
registerMode(ID, "temporal");

/** Streak length below which we consider an opponent uninteresting. */
const STREAK_FLOOR = 3;
/** Minimum number of streak-bearing opponents before the mode unlocks. */
const MIN_STREAK_OPPONENTS = 20;

/**
 * Which per-candidate field a variant ranks by. their-win and
 * your-loss both look at the user's longest L-streak (= opponent's
 * longest W run); their-loss and your-win both look at the user's
 * longest W-streak.
 */
function metricKeyFor(variant: StreakVariant): "longestWin" | "longestLoss" {
  switch (variant) {
    case "their-win":
    case "your-loss":
      return "longestLoss";
    case "their-loss":
    case "your-win":
      return "longestWin";
  }
}

function metricValue(c: Candidate, variant: StreakVariant): number {
  return c[metricKeyFor(variant)];
}

/** Outcome letter shown next to the streak count in the reveal. */
function metricLetter(variant: StreakVariant): "W" | "L" {
  // The letter reflects whose outcome is being counted in the
  // question text: "their WIN streak" / "your WIN streak" → "W";
  // "their LOSS streak" / "your LOSS streak" → "L".
  switch (variant) {
    case "their-win":
    case "your-win":
      return "W";
    case "their-loss":
    case "your-loss":
      return "L";
  }
}

/** Trailing prepositional phrase used in score-note copy. */
function streakDirectionTail(variant: StreakVariant): "against you" | "against them" {
  // "their-*" frames the streak from the opponent's perspective
  // (against the user); "your-*" frames it from the user's
  // perspective (against the opponent).
  switch (variant) {
    case "their-win":
    case "their-loss":
      return "against you";
    case "your-win":
    case "your-loss":
      return "against them";
  }
}

export async function generateStreakHunter(
  input: GenerateInput,
): Promise<GenerateResult<Q>> {
  const byOpp = groupByOpponent(input.data.games);
  const all: Candidate[] = [];
  for (const opp of input.data.opponents) {
    const games = byOpp.get(opp.pulseId);
    if (!games || games.length === 0) continue;
    all.push({
      pulseId: opp.pulseId,
      name: opp.name,
      longestWin: longestWinStreak(games),
      longestLoss: longestLossStreak(games),
      games: games.length,
    });
  }
  const withStreak = all.filter(
    (c) => c.longestWin >= STREAK_FLOOR || c.longestLoss >= STREAK_FLOOR,
  );
  if (withStreak.length < MIN_STREAK_OPPONENTS) {
    return {
      ok: false,
      reason: `Need more streak data — ${withStreak.length} of ${all.length} opponents have a ${STREAK_FLOOR}-game streak so far. (Need ≥${MIN_STREAK_OPPONENTS}.)`,
    };
  }
  // Try variants in shuffled order. Each variant's pool is the
  // subset of withStreak that has ≥3 in the relevant direction; if
  // a variant doesn't have 4 candidates in its pool we fall through
  // to the next rather than emitting a degenerate sample.
  const variants = shuffle(STREAK_VARIANTS, input.rng);
  for (const variant of variants) {
    const key = metricKeyFor(variant);
    const pool = withStreak.filter((c) => c[key] >= STREAK_FLOOR);
    if (pool.length < 4) continue;
    const sample = shuffle(pool, input.rng).slice(0, 4);
    const maxInSample = sample.reduce(
      (m, c) => Math.max(m, metricValue(c, variant)),
      0,
    );
    const correctIndex = sample.findIndex(
      (c) => metricValue(c, variant) === maxInSample,
    );
    return {
      ok: true,
      minDataMet: true,
      question: { variant, candidates: sample, correctIndex },
    };
  }
  return {
    ok: false,
    reason: `Need ≥4 opponents with a ${STREAK_FLOOR}-game streak in the same direction.`,
  };
}

/**
 * Group games by oppPulseId, ascending date. /v1/games results come
 * newest-first; reverse the per-opponent slice so streak helpers can
 * operate on chronological order.
 */
export function groupByOpponent(games: ArcadeGame[]): Map<string, ArcadeGame[]> {
  const out = new Map<string, ArcadeGame[]>();
  for (const g of games) {
    const id = g.oppPulseId;
    if (!id) continue;
    if (!out.has(id)) out.set(id, []);
    out.get(id)!.push(g);
  }
  for (const arr of out.values()) {
    arr.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  }
  return out;
}

function maxMetric(q: Q): number {
  let m = 0;
  for (const c of q.candidates) {
    const v = metricValue(c, q.variant);
    if (v > m) m = v;
  }
  return m;
}

function score(q: Q, a: A): ScoreResult {
  const picked = q.candidates[a];
  const max = maxMetric(q);
  const correct = !!picked && metricValue(picked, q.variant) === max;
  const leaders = q.candidates.filter(
    (c) => metricValue(c, q.variant) === max,
  );
  const letter = metricLetter(q.variant);
  const tail = streakDirectionTail(q.variant);
  const note =
    leaders.length === 1
      ? `Top streak: ${leaders[0].name} — ${max}${letter} ${tail}.`
      : `${leaders.length} rivals tied on ${max}${letter} ${tail}.`;
  return {
    raw: correct ? 1 : 0,
    xp: correct ? 12 : 0,
    outcome: correct ? "correct" : "wrong",
    note,
  };
}

export const activeStreakHunter: Mode<Q, A> = {
  id: ID,
  kind: "quiz",
  category: "streaks",
  difficulty: "medium",
  ttp: "fast",
  depthTag: "temporal",
  title: "Streak Hunter",
  blurb: "Spot the rival on the longest streak — theirs against you, or yours against them.",
  generate: generateStreakHunter,
  score,
  render: (ctx) => <Render ctx={ctx} />,
};

/**
 * Per-variant question copy. The switch is exhaustive over
 * StreakVariant — adding a fifth variant without extending this
 * function would fail typecheck (the return type is omitted so TS
 * infers a union and would catch the missing branch).
 */
function questionFor(variant: StreakVariant): React.ReactNode {
  switch (variant) {
    case "their-win":
      return (
        <span>
          Which of these opponents had the{" "}
          <span className="font-semibold text-warning">longest win streak</span>{" "}
          against you?
        </span>
      );
    case "their-loss":
      return (
        <span>
          Which of these opponents had the{" "}
          <span className="font-semibold text-warning">longest loss streak</span>{" "}
          against you?
        </span>
      );
    case "your-win":
      return (
        <span>
          Which of these opponents did you have the{" "}
          <span className="font-semibold text-warning">longest win streak</span>{" "}
          against?
        </span>
      );
    case "your-loss":
      return (
        <span>
          Which of these opponents did you have the{" "}
          <span className="font-semibold text-warning">longest loss streak</span>{" "}
          against?
        </span>
      );
  }
}

function Render({
  ctx,
}: {
  ctx: Parameters<Mode<Q, A>["render"]>[0];
}) {
  const [picked, setPicked] = useState<number | null>(null);
  const onPick = (i: number) => {
    if (ctx.revealed) return;
    setPicked(i);
    ctx.onAnswer(i);
  };

  const variant = ctx.question.variant;
  const letter = metricLetter(variant);
  const m = (c: Candidate) => metricValue(c, variant);
  const maxAmongShown = ctx.question.candidates.reduce(
    (best, c) => (m(c) > best ? m(c) : best),
    0,
  );
  const leaders = ctx.question.candidates.filter((c) => m(c) === maxAmongShown);
  const failCopy =
    leaders.length === 1
      ? `It was ${leaders[0].name} on ${maxAmongShown}${letter} straight.`
      : `${leaders.length} rivals are tied on ${maxAmongShown}${letter} straight — any of them counts.`;

  const reveal = ctx.score ? (
    <div className="space-y-2 text-caption">
      <p className={ctx.score.outcome === "correct" ? "text-success" : "text-warning"}>
        {ctx.score.outcome === "correct"
          ? "Sharp eye — you spotted the streak holder."
          : failCopy}
      </p>
      <ul className="space-y-1">
        {ctx.question.candidates.map((c) => (
          <li
            key={c.pulseId}
            className="flex items-center justify-between rounded border border-border bg-bg-surface px-2 py-1 text-text"
          >
            <span className="truncate">{c.name}</span>
            <span className="font-mono tabular-nums">
              <span className={m(c) > 0 ? "text-warning" : "text-text-dim"}>
                {m(c)}{letter}
              </span>{" "}
              <span className="text-text-dim">({c.games} games)</span>
              {m(c) === maxAmongShown ? (
                <span className="ml-1 rounded bg-success/15 px-1.5 text-success">★</span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  ) : null;

  return (
    <QuizCard
      icon={IconFor(ID)}
      title={activeStreakHunter.title}
      depthLabel="Historical streaks per opponent"
      isDaily={ctx.isDaily}
      revealed={ctx.revealed}
      onKeyAnswer={onPick}
      question={questionFor(variant)}
      answers={ctx.question.candidates.map((c, i) => (
        <QuizAnswerButton
          key={c.pulseId}
          index={i}
          selected={picked === i}
          correct={
            ctx.revealed
              ? m(c) === maxAmongShown
                ? true
                : picked === i
                  ? false
                  : null
              : null
          }
          onClick={() => onPick(i)}
          disabled={ctx.revealed}
        >
          <span className="truncate text-body font-medium text-text">{c.name}</span>
        </QuizAnswerButton>
      ))}
      reveal={reveal}
    />
  );
}
