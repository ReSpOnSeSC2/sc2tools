"use client";

import { Fragment, useState } from "react";
import { pct1, wrColor } from "@/lib/format";
import { isBarcodeName } from "@/lib/sc2pulse";
import { QuizAnswerButton, QuizCard } from "../../shells/QuizCard";
import { IconFor } from "../../icons";
import { pickN, registerMode } from "../../ArcadeEngine";
import type {
  ArcadeOpponent,
  GenerateInput,
  GenerateResult,
  Mode,
  ScoreResult,
} from "../../types";

type Candidate = Pick<
  ArcadeOpponent,
  | "pulseId"
  | "pulseCharacterId"
  | "name"
  | "displayName"
  | "wins"
  | "losses"
  | "games"
  | "userWinRate"
  | "opponentWinRate"
>;

type Q = {
  candidates: Candidate[];
  /** Index in candidates with the highest OPPONENT WR vs the user. */
  correctIndex: number;
};

type A = number;

const ID = "opponent-bracket-pick";
registerMode(ID, "multi-entity");

/** Display name for a candidate — resolved sc2pulse name beats raw. */
function displayNameFor(c: Pick<Candidate, "name" | "displayName">): string {
  const resolved = c.displayName?.trim();
  if (resolved && resolved.length > 0) return resolved;
  return c.name;
}

/**
 * Eligible-opponent filter: drop entries that are unresolved barcodes
 * (smurf-name masking). Barcodes whose pulseCharacterId is set still
 * get through because we can show their resolved displayName instead
 * of the masked raw name.
 */
function eligibleForCandidatePool(o: ArcadeOpponent): boolean {
  if (o.games < 3) return false;
  const hasResolvedId =
    typeof o.pulseCharacterId === "string" && o.pulseCharacterId.trim().length > 0;
  if (hasResolvedId) return true;
  // No resolved id => keep only if the raw name reads as a human handle.
  return !isBarcodeName(o.name);
}

async function generate(input: GenerateInput): Promise<GenerateResult<Q>> {
  const eligible = input.data.opponents.filter(eligibleForCandidatePool);
  if (eligible.length < 4) {
    return {
      ok: false,
      reason: "Need ≥4 opponents you've played at least 3 times each.",
      cta: { label: "Play more games", href: "/" },
    };
  }
  const sample = pickN(eligible, 4, input.rng).map<Candidate>((o) => ({
    pulseId: o.pulseId,
    pulseCharacterId: o.pulseCharacterId,
    name: o.name,
    displayName: o.displayName,
    wins: o.wins,
    losses: o.losses,
    games: o.games,
    userWinRate: o.userWinRate,
    opponentWinRate: o.opponentWinRate,
  }));
  // The opponent with the HIGHEST opponentWinRate is the one who beats
  // the user most often — that is the right answer when the prompt is
  // "highest WR against you". Equivalently: the opponent whose
  // userWinRate is lowest.
  let bestIdx = 0;
  for (let i = 1; i < sample.length; i++) {
    if (sample[i].opponentWinRate > sample[bestIdx].opponentWinRate) bestIdx = i;
  }
  return {
    ok: true,
    minDataMet: true,
    question: { candidates: sample, correctIndex: bestIdx },
  };
}

function score(q: Q, a: A): ScoreResult {
  const correct = a === q.correctIndex;
  const c = q.candidates[q.correctIndex];
  return {
    raw: correct ? 1 : 0,
    xp: correct ? 10 : 0,
    outcome: correct ? "correct" : "wrong",
    note: correct
      ? "You spotted the opponent who beats you most often."
      : `Their WR vs you was ${pct1(c.opponentWinRate)} (${c.losses}-${c.wins}).`,
  };
}

export const opponentBracketPick: Mode<Q, A> = {
  id: ID,
  kind: "quiz",
  category: "matchups",
  difficulty: "easy",
  ttp: "fast",
  depthTag: "multi-entity",
  title: "Opponent Bracket Pick",
  blurb: "Four opponents enter, one has the BEST record against you. Pick them.",
  generate,
  score,
  render: (ctx) => <OpponentBracketRender ctx={ctx} />,
};

function OpponentBracketRender({
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
    <div className="space-y-2 text-caption">
      <p className={ctx.score.outcome === "correct" ? "text-success" : "text-warning"}>
        {ctx.score.note}
      </p>
      <ul className="space-y-1">
        {ctx.question.candidates.map((c, i) => (
          <li
            key={c.pulseId}
            className="flex items-center justify-between rounded border border-border bg-bg-surface px-2 py-1"
          >
            <span className="truncate text-text">{displayNameFor(c)}</span>
            <span
              className="font-mono tabular-nums"
              style={{ color: wrColor(c.opponentWinRate, c.games) }}
            >
              {pct1(c.opponentWinRate)}{" "}
              <span className="text-text-dim">({c.losses}-{c.wins})</span>
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
      title={opponentBracketPick.title}
      depthLabel="Multi-entity comparison"
      isDaily={ctx.isDaily}
      revealed={ctx.revealed}
      onKeyAnswer={(i) => onPick(i)}
      question={
        <Fragment>
          Four opponents you&apos;ve played at least 3 times each. Which one has the
          <span className="font-semibold text-warning"> highest WR against you</span>?
        </Fragment>
      }
      answers={ctx.question.candidates.map((c, i) => (
        <QuizAnswerButton
          key={c.pulseId}
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
            <span className="truncate text-body font-medium text-text">{displayNameFor(c)}</span>
            <span className="text-caption text-text-dim">{c.games} games played</span>
          </span>
        </QuizAnswerButton>
      ))}
      reveal={reveal}
    />
  );
}
