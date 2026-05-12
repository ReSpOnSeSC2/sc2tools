"use client";

import { useState, type ReactNode } from "react";
import { QuizAnswerButton, QuizCard } from "../../shells/QuizCard";
import { IconFor } from "../../icons";
import { pickN, registerMode, shuffle } from "../../ArcadeEngine";
import type {
  ArcadeUnitStats,
  GenerateInput,
  GenerateResult,
  Mode,
  ScoreResult,
} from "../../types";

const ID = "unit-profile";
registerMode(ID, "hidden-derivation");

/**
 * Unit Profile — two trivia variants over the user's all-time
 * (recent-window-bounded) unit-production aggregate exposed by
 * /v1/arcade/unit-stats:
 *
 *   "built"  — Which unit have you built the most of?
 *   "lost"   — How many units have you lost in total?
 *
 * The two angles share a question payload type ``Q`` so the engine
 * picks a single variant per round. Daily mode rolls a deterministic
 * variant via the seeded RNG; both gate on the unit-stats endpoint
 * returning a non-trivial aggregate (≥25 scanned games for the
 * "built" variant, ≥10 lost-game contributions for the "lost" one)
 * so a brand-new user doesn't see "the correct answer is 0 units".
 */

export type UnitProfileVariant = "built" | "lost";

const BUILT_MIN_SCANNED = 25;
const LOST_MIN_GAMES = 10;

interface BuiltQ {
  variant: "built";
  options: string[];
  truth: string;
  /** Total count of the correct (most-built) unit. */
  truthValue: number;
  /** Per-option counts for the reveal panel. */
  countsByOption: Record<string, number>;
  scannedGames: number;
}

const LOST_BUCKETS = [
  "Under 500",
  "500 – 2,500",
  "2,500 – 10,000",
  "10,000+",
] as const;
type LostBucket = (typeof LOST_BUCKETS)[number];

interface LostQ {
  variant: "lost";
  options: ReadonlyArray<string>;
  truth: LostBucket;
  /** Σ of macroBreakdown.player_stats.me.units_lost across scanned games. */
  truthValue: number;
  scannedGames: number;
  lostGames: number;
}

type Q = BuiltQ | LostQ;
type A = string;

export function bucketForUnitsLost(n: number): LostBucket {
  if (!Number.isFinite(n) || n < 500) return "Under 500";
  if (n < 2_500) return "500 – 2,500";
  if (n < 10_000) return "2,500 – 10,000";
  return "10,000+";
}

/**
 * Pick the user's top-built unit + 3 distractor units. Distractors
 * are sampled from the next-most-built units so the question is
 * answerable but not trivial — the order matters (we want
 * "Marine vs Marauder vs Reaper", not "Marine vs Pylon"). If the
 * user only ever builds one kind of unit we fall back to lower-count
 * names; below 4 distinct unit names the variant is rejected.
 *
 * Pure: deterministic for a given RNG seed, so daily mode is stable
 * across devices.
 */
export function buildBuiltQuestion(
  stats: ArcadeUnitStats,
  rng: () => number,
): BuiltQ | null {
  const entries = Object.entries(stats.builtByUnit || {}).filter(
    ([, v]) => Number.isFinite(v) && v > 0,
  );
  if (entries.length < 4) return null;
  entries.sort((a, b) => b[1] - a[1]);
  // Reject when the leader and the 4th-place candidate are tied —
  // there's no objectively "most-built" unit in that case and the
  // reveal would have to say "tied with X" which the bucket UI
  // doesn't support.
  if (entries[0][1] === entries[3][1]) return null;
  const correct = entries[0][0];
  const correctCount = entries[0][1];
  // Distractor pool: candidates with strictly lower count than the
  // leader. Pull 3 from the top of that pool (most-built losers)
  // before random-shuffling them into the 4-option slate.
  const losers = entries.slice(1).filter(([, c]) => c < correctCount);
  if (losers.length < 3) return null;
  const distractorPool = losers.slice(0, Math.max(3, Math.min(8, losers.length)));
  const distractors = pickN(distractorPool.map(([n]) => n), 3, rng);
  const options = shuffle([correct, ...distractors], rng);
  const countsByOption: Record<string, number> = {};
  for (const [name, count] of entries) countsByOption[name] = count;
  return {
    variant: "built",
    options,
    truth: correct,
    truthValue: correctCount,
    countsByOption: Object.fromEntries(
      options.map((o) => [o, countsByOption[o] || 0]),
    ),
    scannedGames: stats.scannedGames,
  };
}

export function buildLostQuestion(
  stats: ArcadeUnitStats,
): LostQ | null {
  if (stats.lostGames < LOST_MIN_GAMES) return null;
  const total = Number(stats.totalUnitsLost);
  if (!Number.isFinite(total) || total <= 0) return null;
  return {
    variant: "lost",
    options: LOST_BUCKETS,
    truth: bucketForUnitsLost(total),
    truthValue: total,
    scannedGames: stats.scannedGames,
    lostGames: stats.lostGames,
  };
}

async function generate(input: GenerateInput): Promise<GenerateResult<Q>> {
  const stats = input.data.unitStats;
  if (!stats || stats.scannedGames < BUILT_MIN_SCANNED) {
    return {
      ok: false,
      reason:
        "Play more games — Unit Profile needs detailed build-log history before it can quiz you.",
    };
  }
  // Variant selection: daily seed pins it, Quick Play rolls. We try
  // each variant in order and fall through to the next when the
  // chosen one doesn't gate-pass.
  const rollBuiltFirst = input.rng() < 0.5;
  const order: UnitProfileVariant[] = rollBuiltFirst
    ? ["built", "lost"]
    : ["lost", "built"];
  for (const v of order) {
    const q =
      v === "built"
        ? buildBuiltQuestion(stats, input.rng)
        : buildLostQuestion(stats);
    if (q) {
      return { ok: true, minDataMet: true, question: q };
    }
  }
  return {
    ok: false,
    reason:
      "Not enough distinct units / lost-game data yet — Unit Profile will unlock as you play more.",
  };
}

function score(q: Q, a: A): ScoreResult {
  const correct = a === q.truth;
  return {
    raw: correct ? 1 : 0,
    xp: correct ? 14 : 0,
    outcome: correct ? "correct" : "wrong",
    note:
      q.variant === "built"
        ? `Top-built: ${q.truth} (${q.truthValue.toLocaleString()} entries across your last ${q.scannedGames} games).`
        : `Total units lost: ${q.truthValue.toLocaleString()} across ${q.lostGames} games.`,
  };
}

export const unitProfile: Mode<Q, A> = {
  id: ID,
  kind: "quiz",
  category: "builds",
  difficulty: "medium",
  ttp: "fast",
  depthTag: "hidden-derivation",
  title: "Unit Profile",
  blurb:
    "Two angles on the units in your own build-logs. How well do you know your own army?",
  generate,
  score,
  render: (ctx) => <Render ctx={ctx} />,
};

export const __test = {
  buildBuiltQuestion,
  buildLostQuestion,
  bucketForUnitsLost,
  BUILT_MIN_SCANNED,
  LOST_MIN_GAMES,
};

function promptFor(q: Q): ReactNode {
  if (q.variant === "built") {
    return (
      <span>
        Which unit have you{" "}
        <span className="font-semibold">built the most of</span> across your last{" "}
        <span className="font-mono tabular-nums">{q.scannedGames}</span> games?
      </span>
    );
  }
  return (
    <span>
      Across <span className="font-mono tabular-nums">{q.lostGames}</span> of
      your recent games, roughly{" "}
      <span className="font-semibold">how many units have you lost</span> in
      total?
    </span>
  );
}

function depthLabelFor(q: Q): string {
  return q.variant === "built"
    ? "Cross-game buildLog tally"
    : "Cross-game units-lost sum";
}

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
  const reveal = ctx.score ? <Reveal q={ctx.question} score={ctx.score} /> : null;
  return (
    <QuizCard
      icon={IconFor(ID)}
      title={unitProfile.title}
      depthLabel={depthLabelFor(ctx.question)}
      isDaily={ctx.isDaily}
      revealed={ctx.revealed}
      onKeyAnswer={(i) => {
        const o = ctx.question.options[i];
        if (o) onPick(o);
      }}
      question={promptFor(ctx.question)}
      answers={ctx.question.options.map((o, i) => (
        <QuizAnswerButton
          key={o}
          index={i}
          selected={picked === o}
          correct={
            ctx.revealed
              ? o === ctx.question.truth
                ? true
                : picked === o
                  ? false
                  : null
              : null
          }
          onClick={() => onPick(o)}
          disabled={ctx.revealed}
        >
          {o}
        </QuizAnswerButton>
      ))}
      reveal={reveal}
    />
  );
}

function Reveal({ q, score }: { q: Q; score: ScoreResult }) {
  const headline = (
    <p>
      <span className="font-semibold">Answer:</span>{" "}
      <span className="font-mono tabular-nums text-success">{q.truth}</span>{" "}
      {score.outcome === "correct" ? (
        <span className="text-success">— right call.</span>
      ) : (
        <span className="text-warning">— it was {q.truth}.</span>
      )}
    </p>
  );
  return (
    <div className="space-y-2 text-caption text-text">
      {headline}
      {q.variant === "built" ? <BuiltDetail q={q} /> : <LostDetail q={q} />}
    </div>
  );
}

function BuiltDetail({ q }: { q: BuiltQ }) {
  return (
    <ul className="space-y-1" aria-label="Per-option build counts">
      {q.options.map((o) => (
        <li
          key={o}
          className="flex items-center justify-between rounded border border-border bg-bg-surface px-2 py-1"
        >
          <span className={o === q.truth ? "text-text" : "text-text-muted"}>{o}</span>
          <span className="font-mono tabular-nums text-text-dim">
            {(q.countsByOption[o] || 0).toLocaleString()}
          </span>
        </li>
      ))}
    </ul>
  );
}

function LostDetail({ q }: { q: LostQ }) {
  return (
    <p className="text-text-muted">
      Total over <span className="font-mono tabular-nums">{q.lostGames}</span>{" "}
      games with macro data:{" "}
      <span className="font-mono tabular-nums text-text">
        {q.truthValue.toLocaleString()}
      </span>{" "}
      units.
    </p>
  );
}
