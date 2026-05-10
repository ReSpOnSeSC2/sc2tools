"use client";

import { useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { pct1, wrColor } from "@/lib/format";
import { QuizCard } from "../../shells/QuizCard";
import { IconFor } from "../../icons";
import { pickN, registerMode } from "../../ArcadeEngine";
import type {
  ArcadeOpponent,
  GenerateInput,
  GenerateResult,
  Mode,
  ScoreResult,
} from "../../types";

type Q = {
  /** Source set in stable id order. */
  candidates: Array<Pick<ArcadeOpponent, "pulseId" | "name" | "winRate" | "wins" | "losses" | "games">>;
  /** True ranking — pulseIds in highest-WR-first order. */
  truth: string[];
};

type A = string[]; // user's ordering of pulseIds

const ID = "rivalry-ranker";
registerMode(ID, "multi-entity");

async function generate(input: GenerateInput): Promise<GenerateResult<Q>> {
  const eligible = input.data.opponents.filter((o) => o.games >= 4);
  if (eligible.length < 4) {
    return {
      ok: false,
      reason: "Need ≥4 opponents you've played at least 4 times each.",
    };
  }
  const sample = pickN(eligible, 4, input.rng);
  const truth = sample
    .slice()
    .sort((a, b) => b.winRate - a.winRate)
    .map((o) => o.pulseId);
  return { ok: true, minDataMet: true, question: { candidates: sample, truth } };
}

/**
 * Spearman-like distance: 0..1 where 1 = perfect order. Adjacent swaps
 * lose ~25% credit per swap on a 4-item list, which matches the spec's
 * "off-by-adjacent = partial".
 */
function score(q: Q, a: A): ScoreResult {
  if (!Array.isArray(a) || a.length !== q.truth.length) {
    return { raw: 0, xp: 0, outcome: "wrong" };
  }
  let totalDistance = 0;
  for (let i = 0; i < q.truth.length; i++) {
    const truthIdx = i;
    const userIdx = a.indexOf(q.truth[i]);
    if (userIdx < 0) return { raw: 0, xp: 0, outcome: "wrong" };
    totalDistance += Math.abs(truthIdx - userIdx);
  }
  // Max distance for n=4 is 8 (perfect reverse).
  const maxDistance = (q.truth.length * q.truth.length) / 2;
  const raw = Math.max(0, 1 - totalDistance / maxDistance);
  const outcome: ScoreResult["outcome"] =
    raw >= 0.99 ? "correct" : raw >= 0.5 ? "partial" : "wrong";
  return {
    raw,
    xp: Math.round(raw * 12),
    outcome,
    note:
      outcome === "correct"
        ? "Perfect order."
        : `${totalDistance} position${totalDistance === 1 ? "" : "s"} off.`,
  };
}

export const rivalryRanker: Mode<Q, A> = {
  id: ID,
  kind: "quiz",
  category: "matchups",
  difficulty: "medium",
  ttp: "medium",
  depthTag: "multi-entity",
  title: "Rivalry Ranker",
  blurb: "Drag four rivals into the right WR order. Arrow keys work too.",
  generate,
  score,
  render: (ctx) => <RivalryRankerRender ctx={ctx} />,
};

function RivalryRankerRender({
  ctx,
}: {
  ctx: Parameters<Mode<Q, A>["render"]>[0];
}) {
  const initial = useMemo(
    () => ctx.question.candidates.map((c) => c.pulseId),
    [ctx.question.candidates],
  );
  const [order, setOrder] = useState<string[]>(initial);
  const draggingRef = useRef<string | null>(null);

  const move = (from: number, to: number) => {
    if (to < 0 || to >= order.length || to === from) return;
    const next = order.slice();
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    setOrder(next);
  };

  const onDrop = (toIdx: number) => {
    const fromId = draggingRef.current;
    draggingRef.current = null;
    if (!fromId) return;
    const fromIdx = order.indexOf(fromId);
    if (fromIdx >= 0) move(fromIdx, toIdx);
  };

  const submit = () => {
    if (ctx.revealed) return;
    ctx.onAnswer(order);
  };

  const truthMap = new Map(
    ctx.question.candidates.map((c) => [c.pulseId, c]),
  );

  const reveal = ctx.score ? (
    <div className="space-y-2 text-caption">
      <p className={ctx.score.outcome === "correct" ? "text-success" : ctx.score.outcome === "partial" ? "text-warning" : "text-danger"}>
        {ctx.score.note}
      </p>
      <ol className="space-y-1">
        {ctx.question.truth.map((pid, i) => {
          const c = truthMap.get(pid)!;
          return (
            <li
              key={pid}
              className="flex items-center justify-between rounded border border-border bg-bg-surface px-2 py-1"
            >
              <span>
                <span className="mr-2 font-mono tabular-nums text-text-dim">#{i + 1}</span>
                <span className="text-text">{c.name}</span>
              </span>
              <span
                className="font-mono tabular-nums"
                style={{ color: wrColor(c.winRate, c.games) }}
              >
                {pct1(c.winRate)}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  ) : null;

  return (
    <QuizCard
      icon={IconFor(ID)}
      title={rivalryRanker.title}
      depthLabel="Multi-entity ranking"
      isDaily={ctx.isDaily}
      revealed={ctx.revealed}
      question={
        <span>
          Drag (or use the ↑/↓ buttons) to order from{" "}
          <span className="font-semibold text-warning">highest</span> to lowest WR vs you.
        </span>
      }
      answers={
        <div className="space-y-2">
          <ul className="space-y-2" aria-label="Rivalry ranker">
            {order.map((pid, i) => {
              const c = truthMap.get(pid)!;
              return (
                <li
                  key={pid}
                  draggable={!ctx.revealed}
                  onDragStart={() => {
                    draggingRef.current = pid;
                  }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => onDrop(i)}
                  className="flex items-center gap-2 rounded-lg border border-border bg-bg-surface px-3 py-2"
                >
                  <span className="font-mono tabular-nums text-text-dim">#{i + 1}</span>
                  <span className="flex-1 truncate text-body text-text">{c.name}</span>
                  <span className="text-caption text-text-dim">{c.games} g</span>
                  <button
                    type="button"
                    aria-label={`Move ${c.name} up`}
                    onClick={() => move(i, i - 1)}
                    disabled={ctx.revealed || i === 0}
                    className="inline-flex h-9 w-9 items-center justify-center rounded border border-border bg-bg-elevated text-text disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    <ArrowUp className="h-4 w-4" aria-hidden />
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${c.name} down`}
                    onClick={() => move(i, i + 1)}
                    disabled={ctx.revealed || i === order.length - 1}
                    className="inline-flex h-9 w-9 items-center justify-center rounded border border-border bg-bg-elevated text-text disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    <ArrowDown className="h-4 w-4" aria-hidden />
                  </button>
                </li>
              );
            })}
          </ul>
          {!ctx.revealed ? (
            <button
              type="button"
              onClick={submit}
              className="inline-flex min-h-[44px] w-full items-center justify-center rounded-md bg-accent px-4 text-caption font-semibold uppercase tracking-wider text-bg hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
            >
              Submit ranking
            </button>
          ) : null}
        </div>
      }
      reveal={reveal}
    />
  );
}
