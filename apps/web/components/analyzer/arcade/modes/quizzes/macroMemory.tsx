"use client";

import Link from "next/link";
import { useState } from "react";
import { fmtDate } from "@/lib/format";
import { QuizAnswerButton, QuizCard } from "../../shells/QuizCard";
import { IconFor } from "../../icons";
import { pickN, registerMode, shuffle } from "../../ArcadeEngine";
import type {
  GenerateInput,
  GenerateResult,
  Mode,
  ScoreResult,
} from "../../types";

type Q = {
  candidates: Array<{
    gameId: string;
    date: string;
    matchupLetter: string;
    opponentName: string;
    macroScore: number;
  }>;
  /** Index of the highest macro_score. */
  correctIndex: number;
};

type A = number;

const ID = "macro-memory";
registerMode(ID, "hidden-derivation");

async function generate(input: GenerateInput): Promise<GenerateResult<Q>> {
  const scored = input.data.games
    .filter((g) => typeof g.macro_score === "number" && Number.isFinite(g.macro_score))
    .map((g) => ({
      gameId: g.gameId,
      date: g.date,
      matchupLetter: matchupOf(g.myRace, g.oppRace),
      opponentName: g.opponent?.displayName || "(unknown)",
      macroScore: Number(g.macro_score),
    }));
  // Three distinct macro_score values are required.
  const distinct = new Map<number, typeof scored[number]>();
  for (const r of scored) {
    if (!distinct.has(r.macroScore)) distinct.set(r.macroScore, r);
  }
  const pool = Array.from(distinct.values());
  if (pool.length < 3) {
    return { ok: false, reason: "Not enough scored games yet to compare macro." };
  }
  const sample = pickN(pool, 3, input.rng);
  const sorted = sample.slice().sort((a, b) => b.macroScore - a.macroScore);
  const correct = sorted[0];
  const finalSample = shuffle(sample, input.rng);
  const correctIndex = finalSample.findIndex((c) => c.gameId === correct.gameId);
  return { ok: true, minDataMet: true, question: { candidates: finalSample, correctIndex } };
}

function matchupOf(my?: string, opp?: string): string {
  const a = String(my || "?").charAt(0).toUpperCase();
  const b = String(opp || "?").charAt(0).toUpperCase();
  return `${a}v${b}`;
}

function score(q: Q, a: A): ScoreResult {
  const correct = a === q.correctIndex;
  return {
    raw: correct ? 1 : 0,
    xp: correct ? 12 : 0,
    outcome: correct ? "correct" : "wrong",
  };
}

export const macroMemory: Mode<Q, A> = {
  id: ID,
  kind: "quiz",
  category: "macro",
  difficulty: "medium",
  ttp: "fast",
  depthTag: "hidden-derivation",
  title: "Macro Memory",
  blurb: "Three games, no scores shown. Pick the cleanest macro game.",
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

  const reveal = ctx.score ? (
    <div className="space-y-2 text-caption text-text">
      <p className={ctx.score.outcome === "correct" ? "text-success" : "text-warning"}>
        Best macro: <span className="font-mono tabular-nums">{ctx.question.candidates[ctx.question.correctIndex].macroScore}</span>
      </p>
      <ul className="space-y-1">
        {ctx.question.candidates.map((c, i) => (
          <li
            key={c.gameId}
            className="flex items-center justify-between rounded border border-border bg-bg-surface px-2 py-1"
          >
            <span className="truncate">
              {c.matchupLetter} vs {c.opponentName} — {fmtDate(c.date)}
            </span>
            <span className="font-mono tabular-nums text-text-muted">
              {c.macroScore}
              {i === ctx.question.correctIndex ? (
                <span className="ml-1 rounded bg-success/15 px-1.5 text-success">★</span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      <Link
        href={`/?game=${encodeURIComponent(ctx.question.candidates[ctx.question.correctIndex].gameId)}`}
        className="inline-flex min-h-[36px] items-center text-caption text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        Open winning game →
      </Link>
    </div>
  ) : null;

  return (
    <QuizCard
      icon={IconFor(ID)}
      title={macroMemory.title}
      depthLabel="Hidden derivation: macro_score blind compare"
      isDaily={ctx.isDaily}
      revealed={ctx.revealed}
      onKeyAnswer={onPick}
      question={
        <span>
          Three games, all scored. The macro score is hidden — pick the one with the{" "}
          <span className="font-semibold text-warning">cleanest macro</span>.
        </span>
      }
      answers={ctx.question.candidates.map((c, i) => (
        <QuizAnswerButton
          key={c.gameId}
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
              {c.matchupLetter} vs {c.opponentName}
            </span>
            <span className="text-caption text-text-dim">{fmtDate(c.date)}</span>
          </span>
        </QuizAnswerButton>
      ))}
      reveal={reveal}
    />
  );
}
