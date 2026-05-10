"use client";

import { useState } from "react";
import { QuizAnswerButton, QuizCard } from "../../shells/QuizCard";
import { IconFor } from "../../icons";
import { outcome, pickN, registerMode, shuffle } from "../../ArcadeEngine";
import type {
  GenerateInput,
  GenerateResult,
  Mode,
  ScoreResult,
} from "../../types";

type Q = {
  raceLetter: "P" | "T" | "Z";
  candidates: Array<{ build: string; count: number }>;
  /** Index of the modal next-build. */
  correctIndex: number;
};

type A = number;

const ID = "loss-pattern-sleuth";
registerMode(ID, "conditional");

export function pickRaceWithLosses(
  matchups: GenerateInput["data"]["matchups"],
  rng: () => number,
): "P" | "T" | "Z" | null {
  // Reduce matchup buckets ("PvT", "ZvP", "TvZ", ...) to losses-vs each
  // race so we can find one the user has lost ≥10 times to.
  const lossesByRace: Record<"P" | "T" | "Z", number> = { P: 0, T: 0, Z: 0 };
  for (const m of matchups) {
    if (typeof m.matchup !== "string" || m.matchup.length < 3) continue;
    const op = m.matchup.charAt(2).toUpperCase();
    if (op === "P" || op === "T" || op === "Z") {
      lossesByRace[op] += m.losses;
    }
  }
  const eligible = (Object.keys(lossesByRace) as Array<"P" | "T" | "Z">).filter(
    (r) => lossesByRace[r] >= 10,
  );
  if (!eligible.length) return null;
  return eligible[Math.floor(rng() * eligible.length)];
}

async function generate(input: GenerateInput): Promise<GenerateResult<Q>> {
  const race = pickRaceWithLosses(input.data.matchups, input.rng);
  if (!race) {
    return {
      ok: false,
      reason: "Need at least 10 losses to one race before this mode unlocks.",
    };
  }
  const chrono = [...input.data.games].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );
  const counts: Record<string, number> = {};
  for (let i = 0; i < chrono.length - 1; i++) {
    const g = chrono[i];
    if (outcome(g) !== "L") continue;
    const opp = String(g.oppRace || "").charAt(0).toUpperCase();
    if (opp !== race) continue;
    const next = chrono[i + 1];
    const build = (next.myBuild || "").trim();
    if (!build) continue;
    counts[build] = (counts[build] || 0) + 1;
  }
  const sorted = Object.entries(counts)
    .map(([build, count]) => ({ build, count }))
    .sort((a, b) => b.count - a.count);
  if (sorted.length < 4 || sorted[0].count === 0) {
    return {
      ok: false,
      reason: "Not enough labelled next-builds after losing to that race yet.",
    };
  }
  const top = sorted[0];
  const others = pickN(sorted.slice(1), 3, input.rng);
  const sample = shuffle([top, ...others], input.rng);
  const correctIndex = sample.findIndex((s) => s.build === top.build);
  return {
    ok: true,
    minDataMet: true,
    question: { raceLetter: race, candidates: sample, correctIndex },
  };
}

function score(q: Q, a: A): ScoreResult {
  const correct = a === q.correctIndex;
  return {
    raw: correct ? 1 : 0,
    xp: correct ? 14 : 0,
    outcome: correct ? "correct" : "wrong",
  };
}

const FULL_RACE: Record<Q["raceLetter"], string> = {
  P: "Protoss",
  T: "Terran",
  Z: "Zerg",
};

export const lossPatternSleuth: Mode<Q, A> = {
  id: ID,
  kind: "quiz",
  category: "builds",
  difficulty: "hard",
  ttp: "fast",
  depthTag: "conditional",
  title: "Loss-Pattern Sleuth",
  blurb: "After losing to one race, what build do you reach for most?",
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
        After losing to {FULL_RACE[ctx.question.raceLetter]}, you reached for{" "}
        <span className="font-semibold">
          {ctx.question.candidates[ctx.question.correctIndex].build}
        </span>{" "}
        most often.
      </p>
      <ul className="space-y-1">
        {ctx.question.candidates.map((c, i) => (
          <li
            key={c.build}
            className="flex items-center justify-between rounded border border-border bg-bg-surface px-2 py-1"
          >
            <span className="truncate">{c.build}</span>
            <span className="font-mono tabular-nums text-text-dim">{c.count}×</span>
            {i === ctx.question.correctIndex ? (
              <span className="ml-1 rounded bg-success/15 px-1.5 text-success">★</span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  ) : null;

  return (
    <QuizCard
      icon={IconFor(ID)}
      title={lossPatternSleuth.title}
      depthLabel="Sequence-conditional build histogram"
      isDaily={ctx.isDaily}
      revealed={ctx.revealed}
      onKeyAnswer={onPick}
      question={
        <span>
          After losing to a <span className="font-semibold">{FULL_RACE[ctx.question.raceLetter]}</span>,
          which build do you reach for most often the next game?
        </span>
      }
      answers={ctx.question.candidates.map((c, i) => (
        <QuizAnswerButton
          key={c.build}
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
          <span className="truncate">{c.build}</span>
        </QuizAnswerButton>
      ))}
      reveal={reveal}
    />
  );
}
