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
 * trailing run), and each round picks one of two questions:
 *
 *   • "their-longest-vs-you" — pick the rival with the longest
 *     historical win streak against you (= your longest L-streak vs
 *     them).
 *   • "your-longest-vs-them" — pick the rival you've beaten the
 *     most consecutive times.
 *
 * Eligibility gate: ≥20 distinct opponents must carry a 3+ game
 * streak in at least one direction; below that we report
 * "Need more streak data" so the user knows the mode isn't broken,
 * it just doesn't have enough signal yet.
 */
type StreakVariant = "their-longest-vs-you" | "your-longest-vs-them";

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
  // Try both variants in shuffled order. The pool for "their" is
  // opponents who have at one point beaten you ≥3 in a row; the pool
  // for "your" is opponents you've beaten ≥3 in a row. If a variant
  // doesn't have 4 candidates in its pool we fall through to the
  // other one rather than emitting a degenerate sample.
  const variants: StreakVariant[] = shuffle(
    ["their-longest-vs-you", "your-longest-vs-them"],
    input.rng,
  );
  for (const variant of variants) {
    const pool = withStreak.filter((c) =>
      variant === "their-longest-vs-you"
        ? c.longestLoss >= STREAK_FLOOR
        : c.longestWin >= STREAK_FLOOR,
    );
    if (pool.length < 4) continue;
    const sample = shuffle(pool, input.rng).slice(0, 4);
    const metric = (c: Candidate) =>
      variant === "their-longest-vs-you" ? c.longestLoss : c.longestWin;
    const maxInSample = sample.reduce((m, c) => Math.max(m, metric(c)), 0);
    const correctIndex = sample.findIndex((c) => metric(c) === maxInSample);
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

function metricFor(q: Q, c: Candidate): number {
  return q.variant === "their-longest-vs-you" ? c.longestLoss : c.longestWin;
}

function maxMetric(q: Q): number {
  let m = 0;
  for (const c of q.candidates) {
    const v = metricFor(q, c);
    if (v > m) m = v;
  }
  return m;
}

function score(q: Q, a: A): ScoreResult {
  const picked = q.candidates[a];
  const max = maxMetric(q);
  const correct = !!picked && metricFor(q, picked) === max;
  const leaders = q.candidates.filter((c) => metricFor(q, c) === max);
  const label =
    q.variant === "their-longest-vs-you"
      ? `${max} straight against you`
      : `${max} straight by you`;
  const note =
    leaders.length === 1
      ? `Top streak: ${leaders[0].name} — ${label}.`
      : `${leaders.length} rivals tied on ${label}.`;
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

function questionFor(variant: StreakVariant) {
  if (variant === "your-longest-vs-them") {
    return (
      <span>
        One of these rivals is the player you&apos;ve had your{" "}
        <span className="font-semibold text-warning">longest win streak</span>{" "}
        against. Which?
      </span>
    );
  }
  return (
    <span>
      One of these rivals once put together their{" "}
      <span className="font-semibold text-warning">longest win streak</span>{" "}
      against you. Which?
    </span>
  );
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

  const metric = (c: Candidate) =>
    ctx.question.variant === "their-longest-vs-you" ? c.longestLoss : c.longestWin;
  const maxAmongShown = ctx.question.candidates.reduce(
    (m, c) => (metric(c) > m ? metric(c) : m),
    0,
  );
  const leaders = ctx.question.candidates.filter(
    (c) => metric(c) === maxAmongShown,
  );
  const failCopy =
    leaders.length === 1
      ? `It was ${leaders[0].name} on ${maxAmongShown} straight.`
      : `${leaders.length} rivals are tied on ${maxAmongShown} straight — any of them counts.`;

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
              <span className={metric(c) > 0 ? "text-warning" : "text-text-dim"}>
                {metric(c)}W
              </span>{" "}
              <span className="text-text-dim">({c.games} games)</span>
              {metric(c) === maxAmongShown ? (
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
      question={questionFor(ctx.question.variant)}
      answers={ctx.question.candidates.map((c, i) => (
        <QuizAnswerButton
          key={c.pulseId}
          index={i}
          selected={picked === i}
          correct={
            ctx.revealed
              ? metric(c) === maxAmongShown
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
