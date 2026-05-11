"use client";

import { useState } from "react";
import { QuizAnswerButton, QuizCard } from "../../shells/QuizCard";
import { IconFor } from "../../icons";
import {
  activeWinStreak,
  pickN,
  registerMode,
  shuffle,
} from "../../ArcadeEngine";
import type {
  ArcadeGame,
  ArcadeOpponent,
  GenerateInput,
  GenerateResult,
  Mode,
  ScoreResult,
} from "../../types";

type Q = {
  candidates: Array<{
    pulseId: string;
    name: string;
    activeStreak: number;
    games: number;
  }>;
  /** Index of the candidate with the longest active win streak. */
  correctIndex: number;
};

type A = number;

const ID = "active-streak-hunter";
registerMode(ID, "temporal");

/**
 * Walk the user's full games list once, group by oppPulseId in
 * chronological order, and compute each opponent's CURRENT active win
 * streak (consecutive Ws starting from the most-recent game backward;
 * 0 if the most-recent game was a loss). Then pick 4 opponents — one
 * of which has the true longest streak — and ask the user to spot it.
 */
export async function generateActiveStreakHunter(
  input: GenerateInput,
): Promise<GenerateResult<Q>> {
  const byOpp = groupByOpponent(input.data.games);
  const eligible: Array<{
    pulseId: string;
    name: string;
    activeStreak: number;
    games: number;
  }> = [];
  for (const opp of input.data.opponents) {
    const games = byOpp.get(opp.pulseId);
    if (!games || games.length < 2) continue;
    eligible.push({
      pulseId: opp.pulseId,
      name: opp.name,
      activeStreak: activeWinStreak(games),
      games: games.length,
    });
  }
  // Need ≥4 eligible AND at least one nonzero streak so the answer is
  // not "they're all 0".
  const nonZero = eligible.filter((e) => e.activeStreak > 0);
  if (eligible.length < 4 || nonZero.length === 0) {
    return {
      ok: false,
      reason: "Not enough opponents with recent active streaks. Play a few more matches.",
    };
  }
  // Force-include the leader so the question is winnable; sample the
  // remaining 3 from the rest.
  const leader = eligible.reduce((best, e) =>
    e.activeStreak > best.activeStreak ? e : best,
  );
  const others = eligible.filter((e) => e.pulseId !== leader.pulseId);
  const filler = pickN(others, 3, input.rng);
  const sample = shuffle([leader, ...filler], input.rng);
  const correctIndex = sample.findIndex((s) => s.pulseId === leader.pulseId);
  return {
    ok: true,
    minDataMet: true,
    question: { candidates: sample, correctIndex },
  };
}

/**
 * Group games by oppPulseId, ascending date. Pre-existing /v1/games
 * results come newest-first; reverse the per-opponent slice so streak
 * helpers can operate on chronological order.
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

/**
 * Multiple opponents can be tied for the longest active win streak —
 * e.g. three rivals each riding a fresh 1-game win. The question text
 * ("which opponent is on their longest active streak") is satisfied by
 * any of them, so accept any candidate whose streak matches the max
 * shown to the user. Without this, the user could pick a factually-
 * correct tied rival and be told they were wrong.
 */
function maxStreak(q: Q): number {
  let m = -1;
  for (const c of q.candidates) if (c.activeStreak > m) m = c.activeStreak;
  return m;
}

function score(q: Q, a: A): ScoreResult {
  const picked = q.candidates[a];
  const correct = !!picked && picked.activeStreak === maxStreak(q);
  return {
    raw: correct ? 1 : 0,
    xp: correct ? 12 : 0,
    outcome: correct ? "correct" : "wrong",
  };
}

export const activeStreakHunter: Mode<Q, A> = {
  id: ID,
  kind: "quiz",
  category: "streaks",
  difficulty: "medium",
  ttp: "fast",
  depthTag: "temporal",
  title: "Active Streak Hunter",
  blurb: "Which rival is currently on their longest unbroken winning run against you?",
  generate: generateActiveStreakHunter,
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

  const maxAmongShown = ctx.question.candidates.reduce(
    (m, c) => (c.activeStreak > m ? c.activeStreak : m),
    -1,
  );
  const leaders = ctx.question.candidates.filter(
    (c) => c.activeStreak === maxAmongShown,
  );
  const failCopy =
    leaders.length === 1
      ? `It was ${leaders[0].name} on ${leaders[0].activeStreak} straight.`
      : `${leaders.length} rivals are tied on ${maxAmongShown} straight — any of them counts.`;

  const reveal = ctx.score ? (
    <div className="space-y-2 text-caption">
      <p className={ctx.score.outcome === "correct" ? "text-success" : "text-warning"}>
        {ctx.score.outcome === "correct"
          ? "Sharp eye — you spotted the active streak."
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
              <span className={c.activeStreak > 0 ? "text-warning" : "text-text-dim"}>
                {c.activeStreak}W
              </span>{" "}
              <span className="text-text-dim">({c.games} games)</span>
              {c.activeStreak === maxAmongShown ? (
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
      depthLabel="Temporal walk per opponent"
      isDaily={ctx.isDaily}
      revealed={ctx.revealed}
      onKeyAnswer={onPick}
      question={
        <span>
          One of these opponents is currently on their{" "}
          <span className="font-semibold text-warning">longest active win streak</span>{" "}
          against you. Which?
        </span>
      }
      answers={ctx.question.candidates.map((c, i) => (
        <QuizAnswerButton
          key={c.pulseId}
          index={i}
          selected={picked === i}
          correct={
            ctx.revealed
              ? c.activeStreak === maxAmongShown
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
            <span className="truncate text-body font-medium text-text">{c.name}</span>
            <span className="text-caption text-text-dim">
              {c.games} games tracked
            </span>
          </span>
        </QuizAnswerButton>
      ))}
      reveal={reveal}
    />
  );
}
