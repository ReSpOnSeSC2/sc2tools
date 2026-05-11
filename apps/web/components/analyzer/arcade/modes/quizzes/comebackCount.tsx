"use client";

import { useState } from "react";
import { fmtDate } from "@/lib/format";
import { QuizAnswerButton, QuizCard } from "../../shells/QuizCard";
import { IconFor } from "../../icons";
import { outcome, registerMode, sessionize } from "../../ArcadeEngine";
import type {
  GenerateInput,
  GenerateResult,
  Mode,
  ScoreResult,
} from "../../types";

type Bucket = "0" | "1-2" | "3-5" | "6+";

const BUCKETS: Bucket[] = ["0", "1-2", "3-5", "6+"];

type Q = {
  comebackDates: string[];
  count: number;
  truth: Bucket;
};

type A = Bucket;

const ID = "comeback-count";
registerMode(ID, "temporal");

function bucketize(n: number): Bucket {
  if (n === 0) return "0";
  if (n <= 2) return "1-2";
  if (n <= 5) return "3-5";
  return "6+";
}

async function generate(input: GenerateInput): Promise<GenerateResult<Q>> {
  const chrono = [...input.data.games].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );
  const sessions = sessionize(chrono);
  if (sessions.length < 5) {
    return { ok: false, reason: "Not enough distinct sessions yet." };
  }
  const comebackDates: string[] = [];
  for (const s of sessions) {
    if (s.games.length < 3) continue;
    if (outcome(s.games[0]) !== "L" || outcome(s.games[1]) !== "L") continue;
    let wins = 0;
    let losses = 0;
    for (const g of s.games) {
      const o = outcome(g);
      if (o === "W") wins++;
      else if (o === "L") losses++;
    }
    if (wins + losses === 0) continue;
    if (wins / (wins + losses) > 0.5) {
      comebackDates.push(s.startDate);
    }
  }
  return {
    ok: true,
    minDataMet: true,
    question: {
      comebackDates,
      count: comebackDates.length,
      truth: bucketize(comebackDates.length),
    },
  };
}

function score(q: Q, a: A): ScoreResult {
  const correct = a === q.truth;
  return {
    raw: correct ? 1 : 0,
    xp: correct ? 12 : 0,
    outcome: correct ? "correct" : "wrong",
    note: `${q.count} comeback session${q.count === 1 ? "" : "s"} (${q.truth}).`,
  };
}

export const comebackCount: Mode<Q, A> = {
  id: ID,
  kind: "quiz",
  category: "sessions",
  difficulty: "medium",
  ttp: "fast",
  depthTag: "temporal",
  title: "Comeback Count",
  blurb: "Sessions you opened 0–2 but finished above 50%. How many?",
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
    <div className="space-y-2 text-caption text-text">
      <p>
        Comebacks: <span className="font-mono tabular-nums text-success">{ctx.question.count}</span>{" "}
        {ctx.score.outcome === "correct" ? (
          <span className="text-success">— right bucket.</span>
        ) : (
          <span className="text-warning">— it was {ctx.question.truth}.</span>
        )}
      </p>
      {ctx.question.comebackDates.length ? (
        <ul className="space-y-1">
          {ctx.question.comebackDates.slice(0, 6).map((d) => (
            <li
              key={d}
              className="rounded border border-border bg-bg-surface px-2 py-1 text-text-muted"
            >
              {fmtDate(d)}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  ) : null;

  return (
    <QuizCard
      icon={IconFor(ID)}
      title={comebackCount.title}
      depthLabel="Per-session sequence count"
      isDaily={ctx.isDaily}
      revealed={ctx.revealed}
      onKeyAnswer={(i) => BUCKETS[i] && onPick(BUCKETS[i])}
      question={
        <span>
          How many of your <span className="font-semibold">play sessions</span> opened 0–2 but
          finished above 50%?
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
