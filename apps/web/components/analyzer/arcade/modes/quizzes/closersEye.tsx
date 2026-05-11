"use client";

import { useState } from "react";
import { fmtMinutes } from "@/lib/format";
import { QuizAnswerButton, QuizCard } from "../../shells/QuizCard";
import { IconFor } from "../../icons";
import {
  isCannonRush,
  outcome,
  pickN,
  registerMode,
  shuffle,
} from "../../ArcadeEngine";
import type {
  GenerateInput,
  GenerateResult,
  Mode,
  ScoreResult,
} from "../../types";

type Q = {
  candidates: Array<{ build: string; meanWinSec: number; wins: number }>;
  /** Index of the build with the smallest mean win duration. */
  correctIndex: number;
};

type A = number;

const ID = "closers-eye";
registerMode(ID, "hidden-derivation");

/** Per-build minimum wins required to enter the mean-win-length pool.
 *
 *  Originally 5. Dropped to 3 because the auto-classifier (which is what
 *  populates ArcadeGame.myBuild) emits granular per-game bucket names —
 *  "Reaper FE (Macro Transition)", "Reaper FE (Banshee Switch)", etc.
 *  A typical 50-game ranked account spreads across 8–12 such buckets,
 *  so no single bucket clears 5 wins and the mode shows "Not enough
 *  data" even when there's clearly enough activity to compare closers.
 *
 *  Confirmed via the structured logging cycle (see PR description
 *  Decision (b)): for the affected account, every distinct build name
 *  cleared 3 wins but only the top two cleared 5. Lowering the floor
 *  brings the mode in line with the spec target of "playable for a
 *  user with ~50 ranked games and 2–3 main builds."
 *
 *  Cross-referencing user-assigned custom-build slugs would let us
 *  collapse the granular auto-classifier buckets back into named
 *  buckets, but the games payload doesn't expose that linkage today
 *  (no game→customBuildSlug field on ArcadeGame). Tracked as a
 *  follow-up API surface change rather than blocking this fix.
 */
const MIN_WINS_PER_BUILD = 3;

/**
 * Compute mean win-length per build from the user's games. Excludes any
 * build whose name contains "cannon rush" (case-insensitive). Each
 * build needs ≥MIN_WINS_PER_BUILD wins to qualify.
 */
export function meanWinLengths(
  games: GenerateInput["data"]["games"],
): Array<{ build: string; meanWinSec: number; wins: number }> {
  const acc = new Map<string, { sum: number; count: number }>();
  for (const g of games) {
    if (outcome(g) !== "W") continue;
    const build = (g.myBuild || "").trim();
    if (!build || isCannonRush(build)) continue;
    const dur = Number(g.duration);
    if (!Number.isFinite(dur) || dur <= 0) continue;
    const cur = acc.get(build) || { sum: 0, count: 0 };
    cur.sum += dur;
    cur.count += 1;
    acc.set(build, cur);
  }
  const out: Array<{ build: string; meanWinSec: number; wins: number }> = [];
  for (const [build, { sum, count }] of acc.entries()) {
    if (count < MIN_WINS_PER_BUILD) continue;
    out.push({ build, meanWinSec: sum / count, wins: count });
  }
  return out;
}

async function generate(input: GenerateInput): Promise<GenerateResult<Q>> {
  const eligible = meanWinLengths(input.data.games);
  if (eligible.length < 4) {
    return {
      ok: false,
      reason:
        "Need ≥4 builds with at least 3 wins each (cannon rush excluded). Keep grinding.",
    };
  }
  const sorted = eligible.slice().sort((a, b) => a.meanWinSec - b.meanWinSec);
  const fastest = sorted[0];
  const fillers = pickN(sorted.slice(1), 3, input.rng);
  const sample = shuffle([fastest, ...fillers], input.rng);
  const correctIndex = sample.findIndex((c) => c.build === fastest.build);
  return {
    ok: true,
    minDataMet: true,
    question: { candidates: sample, correctIndex },
  };
}

function score(q: Q, a: A): ScoreResult {
  const correct = a === q.correctIndex;
  const closer = q.candidates[q.correctIndex];
  return {
    raw: correct ? 1 : 0,
    xp: correct ? 14 : 0,
    outcome: correct ? "correct" : "wrong",
    note: `Closer: ${closer.build} at ${fmtMinutes(closer.meanWinSec)} avg.`,
  };
}

export const closersEye: Mode<Q, A> = {
  id: ID,
  kind: "quiz",
  category: "builds",
  difficulty: "hard",
  ttp: "fast",
  depthTag: "hidden-derivation",
  title: "Closer's Eye",
  blurb: "Which of your builds closes the door on opponents fastest? (Cannon-rush excluded.)",
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
        Closer was{" "}
        <span className="font-semibold">
          {ctx.question.candidates[ctx.question.correctIndex].build}
        </span>{" "}
        at {fmtMinutes(ctx.question.candidates[ctx.question.correctIndex].meanWinSec)} avg.
      </p>
      <ul className="space-y-1">
        {ctx.question.candidates.map((c, i) => (
          <li
            key={c.build}
            className="flex items-center justify-between rounded border border-border bg-bg-surface px-2 py-1"
          >
            <span className="truncate">{c.build}</span>
            <span className="font-mono tabular-nums text-text-dim">
              {fmtMinutes(c.meanWinSec)} ({c.wins}W)
              {i === ctx.question.correctIndex ? (
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
      title={closersEye.title}
      depthLabel="Hidden derivation: mean win-length per build"
      isDaily={ctx.isDaily}
      revealed={ctx.revealed}
      onKeyAnswer={onPick}
      question={
        <span>
          Of these four builds (each with ≥3 wins, cannon rush excluded), which has the{" "}
          <span className="font-semibold text-warning">shortest average win length</span>?
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
          <span className="flex flex-col">
            <span className="truncate text-body font-medium text-text">{c.build}</span>
            <span className="text-caption text-text-dim">{c.wins} wins recorded</span>
          </span>
        </QuizAnswerButton>
      ))}
      reveal={reveal}
    />
  );
}
