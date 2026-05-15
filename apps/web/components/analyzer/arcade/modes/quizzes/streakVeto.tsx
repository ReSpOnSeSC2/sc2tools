"use client";

import { useMemo, useState } from "react";
import { fmtDate } from "@/lib/format";
import { QuizAnswerButton, QuizCard } from "../../shells/QuizCard";
import { IconFor } from "../../icons";
import {
  pickN,
  registerMode,
  shuffle,
  streakVetoRuns,
} from "../../ArcadeEngine";
import type {
  GenerateInput,
  GenerateResult,
  Mode,
  ScoreResult,
} from "../../types";

type Q = {
  candidates: Array<{
    runStartId: string;
    runLength: number;
    endedById: string;
    endedByDate: string;
    opponentName: string;
  }>;
  /** Index of the streak with the longest length. */
  correctIndex: number;
};

type A = number;

const ID = "streak-veto";
registerMode(ID, "temporal");

/** A single W between two losses isn't a "streak"; require ≥3 to count. */
const STREAK_FLOOR = 3;

async function generate(input: GenerateInput): Promise<GenerateResult<Q>> {
  // Reverse to chronological order (API gives newest-first).
  const chrono = [...input.data.games].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );
  const runs = streakVetoRuns(chrono).filter((r) => r.length >= STREAK_FLOOR);
  if (runs.length < 3) {
    return {
      ok: false,
      reason: `We need at least 3 winning streaks of ${STREAK_FLOOR}+ games ended by losses to play this round.`,
    };
  }
  // A run can be the "answer" only if at least two strictly shorter runs
  // exist as fillers — otherwise the candidate set wouldn't have a unique
  // longest. Picking the answer at random from this pool (rather than
  // always forcing the all-time max) is what keeps the same opponent from
  // appearing every round.
  const eligibleAnswers = runs.filter(
    (r) => runs.filter((other) => other.length < r.length).length >= 2,
  );
  if (eligibleAnswers.length === 0) {
    return {
      ok: false,
      reason: "Not enough variety in streak lengths yet — keep playing.",
    };
  }
  const answer = pickN(eligibleAnswers, 1, input.rng)[0];
  const shorter = runs.filter((r) => r.length < answer.length);
  const filler = pickN(shorter, 2, input.rng);
  const sample = shuffle([answer, ...filler], input.rng);
  // Lookup the opponent name on the ending loss.
  const byId = new Map(chrono.map((g) => [g.gameId, g]));
  const candidates = sample.map((r) => ({
    runStartId: r.startId,
    runLength: r.length,
    endedById: r.endedById,
    endedByDate: r.endedByDate,
    opponentName:
      byId.get(r.endedById)?.opponent?.displayName || "(unknown opponent)",
  }));
  const correctIndex = candidates.findIndex((c) => c.endedById === answer.endedById);
  return { ok: true, minDataMet: true, question: { candidates, correctIndex } };
}

function score(q: Q, a: A): ScoreResult {
  const correct = a === q.correctIndex;
  const longest = q.candidates[q.correctIndex];
  return {
    raw: correct ? 1 : 0,
    xp: correct ? 12 : 0,
    outcome: correct ? "correct" : "wrong",
    note: `Longest streak (${longest.runLength}W) broken by ${longest.opponentName}.`,
  };
}

export const streakVeto: Mode<Q, A> = {
  id: ID,
  kind: "quiz",
  category: "streaks",
  difficulty: "medium",
  ttp: "fast",
  depthTag: "temporal",
  title: "Streak Veto",
  blurb: "Three losses, three streaks. Which loss broke your longest run?",
  generate,
  score,
  render: (ctx) => <Render ctx={ctx} />,
};

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

  const reveal = useMemo(
    () =>
      ctx.score ? (
        <div className="space-y-2 text-caption">
          <p className={ctx.score.outcome === "correct" ? "text-success" : "text-warning"}>
            {ctx.score.outcome === "correct"
              ? "Correct — that loss broke your longest run."
              : `It was the ${ctx.question.candidates[ctx.question.correctIndex].runLength}-game streak.`}
          </p>
          <ul className="space-y-1">
            {ctx.question.candidates.map((c, i) => (
              <li
                key={c.endedById}
                className="flex items-center justify-between rounded border border-border bg-bg-surface px-2 py-1 text-text"
              >
                <span className="truncate">
                  Loss vs <span className="font-medium">{c.opponentName}</span> on{" "}
                  {fmtDate(c.endedByDate)}
                </span>
                <span className="font-mono tabular-nums text-warning">{c.runLength}W</span>
                {i === ctx.question.correctIndex ? (
                  <span className="ml-1 rounded bg-success/15 px-1.5 text-success">★</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null,
    [ctx.score, ctx.question],
  );

  return (
    <QuizCard
      icon={IconFor(ID)}
      title={streakVeto.title}
      depthLabel="Temporal walk over win-streak runs"
      isDaily={ctx.isDaily}
      revealed={ctx.revealed}
      onKeyAnswer={onPick}
      question={
        <span>
          Three of your losses each ended a different winning streak. Pick the one that ended the{" "}
          <span className="font-semibold text-warning">longest</span> streak.
        </span>
      }
      answers={ctx.question.candidates.map((c, i) => (
        <QuizAnswerButton
          key={c.endedById}
          index={i}
          selected={picked === i}
          correct={
            ctx.revealed
              ? i === ctx.question.correctIndex
                ? true
                : picked === i
                  ? false
                  : null
              : null
          }
          onClick={() => onPick(i)}
          disabled={ctx.revealed}
        >
          <span className="flex flex-col">
            <span className="truncate text-body font-medium text-text">
              vs {c.opponentName}
            </span>
            <span className="text-caption text-text-dim">{fmtDate(c.endedByDate)}</span>
          </span>
        </QuizAnswerButton>
      ))}
      reveal={reveal}
    />
  );
}
