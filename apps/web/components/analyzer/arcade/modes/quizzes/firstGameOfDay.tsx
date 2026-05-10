"use client";

import { useState } from "react";
import { pct1 } from "@/lib/format";
import { QuizAnswerButton, QuizCard } from "../../shells/QuizCard";
import { IconFor } from "../../icons";
import { outcome, registerMode, sessionize } from "../../ArcadeEngine";
import type {
  GenerateInput,
  GenerateResult,
  Mode,
  ScoreResult,
} from "../../types";

type Q = {
  firstGameWr: number;
  overallWr: number;
  sessionsCount: number;
  /** "higher" | "lower" | "within" — true relation. */
  truth: "higher" | "lower" | "within";
};

type A = "higher" | "lower" | "within";

const ID = "first-game-of-day";
registerMode(ID, "conditional");

async function generate(input: GenerateInput): Promise<GenerateResult<Q>> {
  const chrono = [...input.data.games].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );
  if (chrono.length < 20) {
    return { ok: false, reason: "Need ≥20 games before this one is meaningful." };
  }
  const sessions = sessionize(chrono);
  if (sessions.length < 5) {
    return {
      ok: false,
      reason: "Not enough distinct play sessions yet. Spread your games across days.",
    };
  }
  let firstWins = 0;
  let firstLosses = 0;
  for (const s of sessions) {
    const o = outcome(s.games[0]);
    if (o === "W") firstWins++;
    else if (o === "L") firstLosses++;
  }
  if (firstWins + firstLosses === 0) {
    return { ok: false, reason: "First-game outcomes were all undecided." };
  }
  const firstGameWr = firstWins / (firstWins + firstLosses);
  let overallWins = 0;
  let overallLosses = 0;
  for (const g of chrono) {
    const o = outcome(g);
    if (o === "W") overallWins++;
    else if (o === "L") overallLosses++;
  }
  const overallWr = overallWins / (overallWins + overallLosses);
  const diff = firstGameWr - overallWr;
  const truth: Q["truth"] =
    Math.abs(diff) <= 0.02 ? "within" : diff > 0 ? "higher" : "lower";
  return {
    ok: true,
    minDataMet: true,
    question: {
      firstGameWr,
      overallWr,
      sessionsCount: sessions.length,
      truth,
    },
  };
}

function score(q: Q, a: A): ScoreResult {
  const correct = a === q.truth;
  return {
    raw: correct ? 1 : 0,
    xp: correct ? 10 : 0,
    outcome: correct ? "correct" : "wrong",
  };
}

export const firstGameOfDay: Mode<Q, A> = {
  id: ID,
  kind: "quiz",
  category: "sessions",
  difficulty: "easy",
  ttp: "fast",
  depthTag: "conditional",
  title: "First-Game-of-Day",
  blurb: "Are you a fast starter or a slow burn? Compare session openers to your overall WR.",
  generate,
  score,
  render: (ctx) => <Render ctx={ctx} />,
};

const OPTIONS: A[] = ["higher", "lower", "within"];
const LABELS: Record<A, string> = {
  higher: "Higher than overall",
  lower: "Lower than overall",
  within: "Within ±2% of overall",
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
    <div className="space-y-2 text-caption text-text">
      <p className={ctx.score.outcome === "correct" ? "text-success" : "text-warning"}>
        First-game WR <span className="font-mono tabular-nums">{pct1(ctx.question.firstGameWr)}</span>{" "}
        vs overall <span className="font-mono tabular-nums">{pct1(ctx.question.overallWr)}</span>{" "}
        across {ctx.question.sessionsCount} sessions.
      </p>
    </div>
  ) : null;

  return (
    <QuizCard
      icon={IconFor(ID)}
      title={firstGameOfDay.title}
      depthLabel="Session-conditional WR"
      isDaily={ctx.isDaily}
      revealed={ctx.revealed}
      onKeyAnswer={(i) => OPTIONS[i] && onPick(OPTIONS[i])}
      question={
        <span>
          A &quot;session&quot; is games separated by ≥4 hours. Is your{" "}
          <span className="font-semibold">first-game-of-session WR</span> higher than, lower than,
          or within ±2% of your overall WR?
        </span>
      }
      answers={OPTIONS.slice(0, 3).map((v, i) => (
        <QuizAnswerButton
          key={v}
          index={i}
          selected={picked === v}
          correct={
            ctx.revealed
              ? v === ctx.question.truth
                ? true
                : picked === v
                  ? false
                  : null
              : null
          }
          onClick={() => onPick(v)}
          disabled={ctx.revealed}
        >
          {LABELS[v]}
        </QuizAnswerButton>
      ))}
      reveal={reveal}
    />
  );
}
