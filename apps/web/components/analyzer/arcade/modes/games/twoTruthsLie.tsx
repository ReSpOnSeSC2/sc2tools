"use client";

import { useMemo, useState } from "react";
import { QuizAnswerButton, QuizCard } from "../../shells/QuizCard";
import { IconFor } from "../../icons";
import { pickN, registerMode, shuffle } from "../../ArcadeEngine";
import type {
  GenerateInput,
  GenerateResult,
  Mode,
  ScoreResult,
  ShareSummary,
} from "../../types";
import { buildFactPool } from "./twoTruthsLie.facts";

// Re-export the fact-pool entry point + shared helpers so existing test
// imports (and any future consumers) keep working without having to
// rewrite their import paths after the split.
export { buildFactPool } from "./twoTruthsLie.facts";

const ID = "two-truths-lie";
registerMode(ID, "cross-axis");

type Claim = {
  text: string;
  truthful: boolean;
  detail: string;
};

type Q = {
  claims: Claim[];
  lieIndex: number;
};

type A = number;

/**
 * Generate three multi-axis claims about the user — two true, one
 * false. Every claim must combine ≥2 axes (matchup × time-of-day,
 * game-length × race, build × map), so a single-tab sort never gives
 * the answer away. The "lie" is built by perturbing one true claim
 * into something the data clearly refutes; the engine refuses to ship
 * a round if it can't fabricate a clearly-false claim.
 *
 * Fact builders live in `twoTruthsLie.facts.ts` (basic) and
 * `twoTruthsLie.facts.census.ts` (boolean-existence claims drawn from
 * the same data the Group Census quiz uses). Both feed into the same
 * `buildFactPool` registry.
 */
async function generate(input: GenerateInput): Promise<GenerateResult<Q>> {
  if (input.data.games.length < 25) {
    return { ok: false, reason: "Need at least 25 games to weave claims from." };
  }
  const facts = buildFactPool(input.data);
  if (facts.length < 3) {
    return { ok: false, reason: "Couldn't find enough cross-axis facts." };
  }
  const truths = pickN(facts, 2, input.rng);
  // Construct a lie by inverting one fact.
  const remaining = facts.filter((f) => !truths.includes(f));
  const lieSource =
    remaining[Math.floor(input.rng() * remaining.length)] || facts[0];
  const lie: Claim = {
    text: lieSource.lieText,
    truthful: false,
    detail: lieSource.detail,
  };
  const claims = shuffle(
    [
      ...truths.map((t) => ({
        text: t.truthText,
        truthful: true,
        detail: t.detail,
      })),
      lie,
    ],
    input.rng,
  );
  const lieIndex = claims.findIndex((c) => !c.truthful);
  return { ok: true, minDataMet: true, question: { claims, lieIndex } };
}

function score(q: Q, a: A): ScoreResult {
  const correct = a === q.lieIndex;
  const lie = q.claims[q.lieIndex];
  return {
    raw: correct ? 1 : 0,
    xp: correct ? 16 : 0,
    outcome: correct ? "correct" : "wrong",
    note: `The lie: "${lie.text}"`,
  };
}

/**
 * Build the share lines for Two Truths & a Lie. Shares the full reveal
 * — outcome header plus all three claims with their TRUE/LIE labels —
 * rather than just the lie text, so the card carries the same context
 * the in-app reveal does. Each claim's supporting detail is appended
 * underneath so a reader who hasn't played sees the same evidence the
 * reveal panel shows.
 */
export function twoTruthsLieShareLines(q: Q, correct: boolean): string[] {
  const header = correct
    ? `Spotted the lie (claim #${q.lieIndex + 1}).`
    : `Missed the lie — it was claim #${q.lieIndex + 1}.`;
  return [
    header,
    ...q.claims.map(
      (c, i) => `${i + 1}. ${c.truthful ? "TRUE" : "LIE"} · ${c.text}`,
    ),
  ];
}

function share(q: Q, a: A | null, s: ScoreResult): ShareSummary {
  const correct = s.outcome === "correct";
  const header = correct
    ? `Spotted the lie (claim #${q.lieIndex + 1}).`
    : `Missed the lie — it was claim #${q.lieIndex + 1}.`;
  const answer: string[] = [header];
  for (let i = 0; i < q.claims.length; i++) {
    const c = q.claims[i];
    answer.push(`${i + 1}. ${c.truthful ? "TRUE" : "LIE"} · ${c.text}`);
    if (c.detail) answer.push(`   ${c.detail}`);
  }
  void a;
  return {
    question:
      "Three statements about you. Two are true, one is a lie. Spot the lie.",
    answer,
  };
}

export const twoTruthsLie: Mode<Q, A> = {
  id: ID,
  kind: "game",
  category: "matchups",
  difficulty: "hard",
  ttp: "medium",
  depthTag: "cross-axis",
  title: "Two Truths & a Lie",
  blurb: "Two true claims about you, one fake. Spot the lie.",
  generate,
  score,
  share,
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
        <div className="space-y-2 text-caption text-text">
          <p
            className={
              ctx.score.outcome === "correct"
                ? "text-success"
                : "text-warning"
            }
          >
            The lie was claim #{ctx.question.lieIndex + 1}.
          </p>
          <ul className="space-y-1">
            {ctx.question.claims.map((c, i) => (
              <li
                key={`${c.text}-${i}`}
                className="rounded border border-border bg-bg-surface px-2 py-1"
              >
                <div className="font-medium">
                  {c.truthful ? (
                    <span className="text-success">TRUE</span>
                  ) : (
                    <span className="text-danger">LIE</span>
                  )}{" "}
                  · {c.text}
                </div>
                <div className="text-text-dim">{c.detail}</div>
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
      title={twoTruthsLie.title}
      depthLabel="Cross-axis claims (two true, one false)"
      isDaily={ctx.isDaily}
      revealed={ctx.revealed}
      onKeyAnswer={onPick}
      question={
        <span>
          Three statements. Two are true, one is{" "}
          <span className="font-semibold text-danger">a lie</span>. Spot the lie.
        </span>
      }
      answers={ctx.question.claims.map((c, i) => (
        <QuizAnswerButton
          key={i}
          index={i}
          selected={picked === i}
          correct={
            ctx.revealed
              ? i === ctx.question.lieIndex
                ? true
                : picked === i
                  ? false
                  : null
              : null
          }
          onClick={() => onPick(i)}
          disabled={ctx.revealed}
        >
          {c.text}
        </QuizAnswerButton>
      ))}
      reveal={reveal}
    />
  );
}
