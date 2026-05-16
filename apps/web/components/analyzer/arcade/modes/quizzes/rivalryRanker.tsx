"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { pct1, wrColor } from "@/lib/format";
import { isBarcodeName } from "@/lib/sc2pulse";
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
  /** Source set in stable id order. */
  candidates: Candidate[];
  /**
   * True ranking — pulseIds ordered toughest-matchup-first (lowest
   * userWinRate at index 0, highest at the end). The prompt and reveal
   * are both phrased from the user's perspective.
   */
  truth: string[];
};

type A = string[]; // user's ordering of pulseIds

const ID = "rivalry-ranker";
registerMode(ID, "multi-entity");

function displayNameFor(c: Pick<Candidate, "name" | "displayName">): string {
  const resolved = c.displayName?.trim();
  if (resolved && resolved.length > 0) return resolved;
  return c.name;
}

function eligibleForCandidatePool(o: ArcadeOpponent): boolean {
  if (o.games < 4) return false;
  const hasResolvedId =
    typeof o.pulseCharacterId === "string" && o.pulseCharacterId.trim().length > 0;
  if (hasResolvedId) return true;
  return !isBarcodeName(o.name);
}

async function generate(input: GenerateInput): Promise<GenerateResult<Q>> {
  const eligible = input.data.opponents.filter(eligibleForCandidatePool);
  if (eligible.length < 4) {
    return {
      ok: false,
      reason: "Need ≥4 opponents you've played at least 4 times each.",
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
  // Toughest first = lowest userWinRate first.
  const truth = sample
    .slice()
    .sort((a, b) => a.userWinRate - b.userWinRate)
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
        ? "Your toughest matchup of the four is at #1."
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
  blurb: "Drag four rivals by your WR against them — toughest matchup first.",
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
  // Daily-rollover safety: a new question reference (e.g. mid-session
  // day flip) must reset the user's draft order so we never operate on
  // a stale pulseId from a previous round.
  useEffect(() => {
    setOrder(initial);
  }, [initial]);
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

  const truthMap = useMemo(
    () => new Map(ctx.question.candidates.map((c) => [c.pulseId, c])),
    [ctx.question.candidates],
  );

  const reveal = ctx.score ? (
    <div className="space-y-2 text-caption">
      <p className={ctx.score.outcome === "correct" ? "text-success" : ctx.score.outcome === "partial" ? "text-warning" : "text-danger"}>
        {ctx.score.note}
      </p>
      <ol className="space-y-1">
        {ctx.question.truth.map((pid, i) => {
          const c = truthMap.get(pid);
          if (!c) {
            // Defensive: candidates and truth are built from the same
            // sample, so a missing id means the question payload itself
            // is malformed. Render nothing for the row and warn once.
            if (typeof console !== "undefined") {
              console.warn(`[rivalry-ranker] truth pulseId not in candidates: ${pid}`);
            }
            return null;
          }
          return (
            <li
              key={pid}
              className="flex items-center justify-between rounded border border-border bg-bg-surface px-2 py-1"
            >
              <span>
                <span className="mr-2 font-mono tabular-nums text-text-dim">#{i + 1}</span>
                <span className="text-text">{displayNameFor(c)}</span>
              </span>
              <span
                className="font-mono tabular-nums"
                style={{ color: wrColor(c.userWinRate, c.games) }}
              >
                {pct1(c.userWinRate)}{" "}
                <span className="text-text-dim">({c.wins}-{c.losses})</span>
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
          Rank these rivals from your{" "}
          <span className="font-semibold text-warning">toughest</span> matchup (#1) to
          your easiest (#4). Drag, or use the ↑/↓ buttons.
        </span>
      }
      answers={
        <div className="space-y-2">
          <ul className="space-y-2" aria-label="Rivalry ranker">
            {order.map((pid, i) => {
              const c = truthMap.get(pid);
              if (!c) {
                // Drop unknown ids from the editor; the daily-rollover
                // useEffect will reseed `order` from the new candidate
                // set on the next tick.
                return null;
              }
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
                  <span className="flex-1 truncate text-body text-text">{displayNameFor(c)}</span>
                  <span className="text-caption text-text-dim">{c.games} g</span>
                  <button
                    type="button"
                    aria-label={`Move ${displayNameFor(c)} up`}
                    onClick={() => move(i, i - 1)}
                    disabled={ctx.revealed || i === 0}
                    className="inline-flex h-9 w-9 items-center justify-center rounded border border-border bg-bg-elevated text-text disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    <ArrowUp className="h-4 w-4" aria-hidden />
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${displayNameFor(c)} down`}
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
