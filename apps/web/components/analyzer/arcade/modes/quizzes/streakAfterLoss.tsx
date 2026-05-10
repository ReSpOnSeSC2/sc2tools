"use client";

import { useState } from "react";
import { pct1 } from "@/lib/format";
import { QuizAnswerButton, QuizCard } from "../../shells/QuizCard";
import { IconFor } from "../../icons";
import { outcome, registerMode } from "../../ArcadeEngine";
import type {
  GenerateInput,
  GenerateResult,
  Mode,
  ScoreResult,
} from "../../types";

type Bucket = "<25%" | "25-50%" | "50-75%" | ">75%";

const BUCKETS: Bucket[] = ["<25%", "25-50%", "50-75%", ">75%"];

type Q = {
  positions: number;
  wr: number;
  truth: Bucket;
};

type A = Bucket;

const ID = "streak-after-loss";
registerMode(ID, "conditional");

function bucketize(wr: number): Bucket {
  if (wr < 0.25) return "<25%";
  if (wr < 0.5) return "25-50%";
  if (wr < 0.75) return "50-75%";
  return ">75%";
}

async function generate(input: GenerateInput): Promise<GenerateResult<Q>> {
  const chrono = [...input.data.games].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );
  if (chrono.length < 12) {
    return { ok: false, reason: "Need at least 12 decided games to play this round." };
  }
  let positions = 0;
  let wins = 0;
  let losses = 0;
  for (let i = 3; i < chrono.length; i++) {
    if (
      outcome(chrono[i - 1]) === "L" &&
      outcome(chrono[i - 2]) === "L" &&
      outcome(chrono[i - 3]) === "L"
    ) {
      const o = outcome(chrono[i]);
      if (o === "W") {
        positions++;
        wins++;
      } else if (o === "L") {
        positions++;
        losses++;
      }
    }
  }
  if (positions < 5) {
    return {
      ok: false,
      reason: "Fewer than 5 times you've stacked 3 losses in a row — not enough signal.",
    };
  }
  const wr = wins / (wins + losses);
  return {
    ok: true,
    minDataMet: true,
    question: { positions, wr, truth: bucketize(wr) },
  };
}

function score(q: Q, a: A): ScoreResult {
  const correct = a === q.truth;
  return {
    raw: correct ? 1 : 0,
    xp: correct ? 12 : 0,
    outcome: correct ? "correct" : "wrong",
  };
}

export const streakAfterLoss: Mode<Q, A> = {
  id: ID,
  kind: "quiz",
  category: "streaks",
  difficulty: "medium",
  ttp: "fast",
  depthTag: "conditional",
  title: "Streak-after-Loss",
  blurb: "Three Ls in a row, then what? Pick the bucket your bounce-back WR lands in.",
  generate,
  score,
  render: (ctx) => <Render ctx={ctx} />,
};

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

  const reveal = ctx.score ? (
    <p className="text-caption text-text">
      WR after losing 3 straight: <span className="font-mono tabular-nums">{pct1(ctx.question.wr)}</span>{" "}
      across {ctx.question.positions} occurrences.{" "}
      {ctx.score.outcome === "correct" ? (
        <span className="text-success">Right bucket.</span>
      ) : (
        <span className="text-warning">It was {ctx.question.truth}.</span>
      )}
    </p>
  ) : null;

  return (
    <QuizCard
      icon={IconFor(ID)}
      title={streakAfterLoss.title}
      depthLabel="Loss-sequence conditional WR"
      isDaily={ctx.isDaily}
      revealed={ctx.revealed}
      onKeyAnswer={(i) => BUCKETS[i] && onPick(BUCKETS[i])}
      question={
        <span>
          After losing your last 3 games, what bucket does your{" "}
          <span className="font-semibold">next-game WR</span> fall into?
        </span>
      }
      answers={BUCKETS.map((b, i) => (
        <QuizAnswerButton
          key={b}
          index={i}
          selected={picked === b}
          correct={
            ctx.revealed
              ? b === ctx.question.truth
                ? true
                : picked === b
                  ? false
                  : null
              : null
          }
          onClick={() => onPick(b)}
          disabled={ctx.revealed}
        >
          {b}
        </QuizAnswerButton>
      ))}
      reveal={reveal}
    />
  );
}
