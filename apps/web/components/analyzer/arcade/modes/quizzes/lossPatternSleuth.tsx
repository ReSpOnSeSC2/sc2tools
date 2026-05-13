"use client";

import { useState, type ReactNode } from "react";
import { QuizAnswerButton, QuizCard } from "../../shells/QuizCard";
import { IconFor } from "../../icons";
import { outcome, pickQuizSlate, registerMode, shuffle } from "../../ArcadeEngine";
import type {
  ArcadeGame,
  GenerateInput,
  GenerateResult,
  Mode,
  ScoreResult,
} from "../../types";

/**
 * Loss-Pattern Sleuth — three angles on what your history looks like in
 * the wake of a defeat. The mode picks one variant per round through a
 * deterministic RNG rotation; daily mode therefore stays stable per user
 * per day, but Quick Play sees variety.
 *
 *   "next-build"     — Most-common build you reach for after losing to race X.
 *   "bounce-back"    — Win-rate bucket on the very next game after losing to race X.
 *   "worst-vs-race"  — Which of your builds has the most losses against race X.
 *
 * The three share a discriminated-union ``Q`` so the engine treats them as
 * one mode (one card, one register, one daily slot). Each variant carries
 * its own ``options`` / ``truth`` / reveal-detail bag — the render layer
 * branches on ``variant`` to fill in the prompt + reveal panel.
 *
 * Gating: every variant requires a race the user has ≥10 losses to (the
 * historical gate from the original mode) plus its own per-variant signal
 * test (≥4 distinct builds for the histogram variants, ≥10 decided next-
 * games for the bounce-back rate). When the chosen variant fails its
 * gate, generate() falls through to the next variant; only when all three
 * fail does the mode surface its empty-state.
 */

export type LossPatternVariant = "next-build" | "bounce-back" | "worst-vs-race";

type Race = "P" | "T" | "Z";

const BOUNCE_BACK_BUCKETS = [
  "Under 30%",
  "30 – 50%",
  "50 – 65%",
  "65%+",
] as const;
type BounceBackBucket = (typeof BOUNCE_BACK_BUCKETS)[number];

const MIN_LOSSES_PER_RACE = 10;
const MIN_NEXT_GAMES_FOR_BOUNCE_BACK = 10;

interface NextBuildQ {
  variant: "next-build";
  raceLetter: Race;
  options: string[];
  truth: string;
  /** Per-option count of next-build occurrences, for the reveal list. */
  countsByOption: Record<string, number>;
}

interface BounceBackQ {
  variant: "bounce-back";
  raceLetter: Race;
  options: ReadonlyArray<string>;
  truth: BounceBackBucket;
  /** Raw win-rate as a fraction in [0,1]. */
  truthValue: number;
  /** Number of decided next-games observed. */
  sample: number;
  /** Raw W/L breakdown of those next-games. */
  wins: number;
  losses: number;
}

interface WorstVsRaceQ {
  variant: "worst-vs-race";
  raceLetter: Race;
  options: string[];
  truth: string;
  /** Per-option loss counts vs the chosen race. */
  lossesByOption: Record<string, number>;
}

type Q = NextBuildQ | BounceBackQ | WorstVsRaceQ;
type A = string;

const ID = "loss-pattern-sleuth";
registerMode(ID, "conditional");

const FULL_RACE: Record<Race, string> = {
  P: "Protoss",
  T: "Terran",
  Z: "Zerg",
};

export function pickRaceWithLosses(
  matchups: GenerateInput["data"]["matchups"],
  rng: () => number,
): Race | null {
  // Roll up losses by opponent race so we can find one the user has
  // lost ≥10 times to. `oppRace` is already parsed off the API's
  // `name: "vs <R>"` rows by useArcadeData — see types.ts.
  const lossesByRace: Record<Race, number> = { P: 0, T: 0, Z: 0 };
  for (const m of matchups) {
    if (m.oppRace === "P" || m.oppRace === "T" || m.oppRace === "Z") {
      lossesByRace[m.oppRace] += m.losses;
    }
  }
  const eligible = (Object.keys(lossesByRace) as Race[]).filter(
    (r) => lossesByRace[r] >= MIN_LOSSES_PER_RACE,
  );
  if (!eligible.length) return null;
  return eligible[Math.floor(rng() * eligible.length)];
}

export function bucketForBounceBack(rate: number): BounceBackBucket {
  if (!Number.isFinite(rate) || rate < 0.3) return "Under 30%";
  if (rate < 0.5) return "30 – 50%";
  if (rate < 0.65) return "50 – 65%";
  return "65%+";
}

/**
 * Chronologically-sorted game list, oldest first. Mutates nothing.
 * Pulled into a helper so the three variant builders can share one
 * sort pass when called from generate().
 */
function chronoSort(games: ReadonlyArray<ArcadeGame>): ArcadeGame[] {
  return [...games].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );
}

export function buildNextBuildQuestion(
  chronoGames: ArcadeGame[],
  race: Race,
  rng: () => number,
): NextBuildQ | null {
  const counts: Record<string, number> = {};
  for (let i = 0; i < chronoGames.length - 1; i++) {
    const g = chronoGames[i];
    if (outcome(g) !== "L") continue;
    const opp = String(g.oppRace || "").charAt(0).toUpperCase();
    if (opp !== race) continue;
    const next = chronoGames[i + 1];
    const build = (next.myBuild || "").trim();
    if (!build) continue;
    counts[build] = (counts[build] || 0) + 1;
  }
  const candidates = Object.entries(counts).map(([build, count]) => ({
    build,
    count,
  }));
  if (candidates.length < 4) return null;
  const slate = pickQuizSlate(candidates, (c) => c.count, rng);
  if (!slate) return null;
  const sample = shuffle([slate.correct, ...slate.distractors], rng);
  const options = sample.map((s) => s.build);
  const countsByOption: Record<string, number> = {};
  for (const s of sample) countsByOption[s.build] = s.count;
  return {
    variant: "next-build",
    raceLetter: race,
    options,
    truth: slate.correct.build,
    countsByOption,
  };
}

export function buildBounceBackQuestion(
  chronoGames: ArcadeGame[],
  race: Race,
): BounceBackQ | null {
  let wins = 0;
  let losses = 0;
  for (let i = 0; i < chronoGames.length - 1; i++) {
    const g = chronoGames[i];
    if (outcome(g) !== "L") continue;
    const opp = String(g.oppRace || "").charAt(0).toUpperCase();
    if (opp !== race) continue;
    const next = chronoGames[i + 1];
    const o = outcome(next);
    if (o === "W") wins += 1;
    else if (o === "L") losses += 1;
    // Undecided next-games (rare; replay upload races) are skipped so
    // the rate stays a proper Bernoulli over decided outcomes.
  }
  const sample = wins + losses;
  if (sample < MIN_NEXT_GAMES_FOR_BOUNCE_BACK) return null;
  const rate = wins / sample;
  return {
    variant: "bounce-back",
    raceLetter: race,
    options: BOUNCE_BACK_BUCKETS,
    truth: bucketForBounceBack(rate),
    truthValue: rate,
    sample,
    wins,
    losses,
  };
}

export function buildWorstVsRaceQuestion(
  games: ReadonlyArray<ArcadeGame>,
  race: Race,
  rng: () => number,
): WorstVsRaceQ | null {
  // Histogram of losses-vs-race by myBuild. The build the user has lost
  // with most often is their tilt-build for that matchup; pickQuizSlate
  // requires ≥4 distinct builds with strictly-different counts so a
  // 4-option slate is well-defined.
  const counts: Record<string, number> = {};
  for (const g of games) {
    if (outcome(g) !== "L") continue;
    const opp = String(g.oppRace || "").charAt(0).toUpperCase();
    if (opp !== race) continue;
    const build = (g.myBuild || "").trim();
    if (!build) continue;
    counts[build] = (counts[build] || 0) + 1;
  }
  const candidates = Object.entries(counts).map(([build, losses]) => ({
    build,
    losses,
  }));
  if (candidates.length < 4) return null;
  const slate = pickQuizSlate(candidates, (c) => c.losses, rng);
  if (!slate) return null;
  const sample = shuffle([slate.correct, ...slate.distractors], rng);
  const options = sample.map((s) => s.build);
  const lossesByOption: Record<string, number> = {};
  for (const s of sample) lossesByOption[s.build] = s.losses;
  return {
    variant: "worst-vs-race",
    raceLetter: race,
    options,
    truth: slate.correct.build,
    lossesByOption,
  };
}

async function generate(input: GenerateInput): Promise<GenerateResult<Q>> {
  const race = pickRaceWithLosses(input.data.matchups, input.rng);
  if (!race) {
    return {
      ok: false,
      reason: "Need at least 10 losses to one race before this mode unlocks.",
    };
  }
  const chrono = chronoSort(input.data.games);
  // Variant rotation: randomise the try-order via the seeded RNG so the
  // daily seed pins a stable variant per user-day, Quick Play rotates.
  const variants: LossPatternVariant[] = shuffle(
    ["next-build", "bounce-back", "worst-vs-race"],
    input.rng,
  );
  for (const v of variants) {
    let q: Q | null = null;
    if (v === "next-build") {
      q = buildNextBuildQuestion(chrono, race, input.rng);
    } else if (v === "bounce-back") {
      q = buildBounceBackQuestion(chrono, race);
    } else {
      q = buildWorstVsRaceQuestion(input.data.games, race, input.rng);
    }
    if (q) {
      return { ok: true, minDataMet: true, question: q };
    }
  }
  return {
    ok: false,
    reason:
      "Not enough labelled post-loss data against that race yet — play a few more and the pattern will surface.",
  };
}

function score(q: Q, a: A): ScoreResult {
  const correct = a === q.truth;
  let note: string;
  if (q.variant === "next-build") {
    note = `After losing to ${FULL_RACE[q.raceLetter]}: ${q.truth} (${q.countsByOption[q.truth] || 0}×).`;
  } else if (q.variant === "bounce-back") {
    const pct = (q.truthValue * 100).toFixed(1);
    note = `Bounce-back vs ${FULL_RACE[q.raceLetter]}: ${pct}% across ${q.sample} games (${q.wins}W / ${q.losses}L).`;
  } else {
    note = `Tilt-build vs ${FULL_RACE[q.raceLetter]}: ${q.truth} has lost ${q.lossesByOption[q.truth] || 0} times.`;
  }
  return {
    raw: correct ? 1 : 0,
    xp: correct ? 14 : 0,
    outcome: correct ? "correct" : "wrong",
    note,
  };
}

export const lossPatternSleuth: Mode<Q, A> = {
  id: ID,
  kind: "quiz",
  category: "builds",
  difficulty: "hard",
  ttp: "fast",
  depthTag: "conditional",
  title: "Loss-Pattern Sleuth",
  blurb:
    "Three angles on what your history looks like in the wake of a defeat: tilt-build, bounce-back, blind-spot.",
  generate,
  score,
  render: (ctx) => <Render ctx={ctx} />,
};

export const __test = {
  buildNextBuildQuestion,
  buildBounceBackQuestion,
  buildWorstVsRaceQuestion,
  bucketForBounceBack,
  chronoSort,
  MIN_LOSSES_PER_RACE,
  MIN_NEXT_GAMES_FOR_BOUNCE_BACK,
};

function promptFor(q: Q): ReactNode {
  const raceName = FULL_RACE[q.raceLetter];
  if (q.variant === "next-build") {
    return (
      <span>
        After losing to a <span className="font-semibold">{raceName}</span>,
        which of these four builds did you reach for most often the next game?
      </span>
    );
  }
  if (q.variant === "bounce-back") {
    return (
      <span>
        When you lose to a <span className="font-semibold">{raceName}</span>,{" "}
        what does your{" "}
        <span className="font-semibold">win rate on the very next game</span>{" "}
        look like across the{" "}
        <span className="font-mono tabular-nums">{q.sample}</span> times we've seen
        that situation?
      </span>
    );
  }
  return (
    <span>
      Which of these builds has{" "}
      <span className="font-semibold">lost the most</span> against{" "}
      <span className="font-semibold">{raceName}</span> across your history?
    </span>
  );
}

function depthLabelFor(q: Q): string {
  if (q.variant === "next-build") return "Sequence-conditional build histogram";
  if (q.variant === "bounce-back") return "Sequence-conditional win-rate bucket";
  return "Per-race lossing-build histogram";
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
      title={lossPatternSleuth.title}
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
          <span className="truncate">{o}</span>
        </QuizAnswerButton>
      ))}
      reveal={reveal}
    />
  );
}

function Reveal({ q, score }: { q: Q; score: ScoreResult }) {
  const headline =
    score.outcome === "correct" ? (
      <p className="text-success">
        Right — the answer was{" "}
        <span className="font-semibold">{q.truth}</span>.
      </p>
    ) : (
      <p className="text-warning">
        The answer was{" "}
        <span className="font-semibold">{q.truth}</span>.
      </p>
    );
  return (
    <div className="space-y-2 text-caption text-text">
      {headline}
      {q.variant === "next-build" ? <NextBuildDetail q={q} /> : null}
      {q.variant === "bounce-back" ? <BounceBackDetail q={q} /> : null}
      {q.variant === "worst-vs-race" ? <WorstVsRaceDetail q={q} /> : null}
    </div>
  );
}

function NextBuildDetail({ q }: { q: NextBuildQ }) {
  return (
    <ul className="space-y-1">
      {q.options.map((o) => (
        <li
          key={o}
          className="flex items-center justify-between rounded border border-border bg-bg-surface px-2 py-1"
        >
          <span className={o === q.truth ? "text-text" : "text-text-muted truncate"}>
            {o}
          </span>
          <span className="font-mono tabular-nums text-text-dim">
            {(q.countsByOption[o] || 0).toLocaleString()}×
            {o === q.truth ? (
              <span className="ml-1 rounded bg-success/15 px-1.5 text-success">★</span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

function BounceBackDetail({ q }: { q: BounceBackQ }) {
  const pct = (q.truthValue * 100).toFixed(1);
  return (
    <p className="text-text-muted">
      You went{" "}
      <span className="font-mono tabular-nums text-text">{q.wins}W</span> –{" "}
      <span className="font-mono tabular-nums text-text">{q.losses}L</span> on
      the game right after losing to {FULL_RACE[q.raceLetter]} —{" "}
      <span className="font-mono tabular-nums text-text">{pct}%</span> across{" "}
      <span className="font-mono tabular-nums">{q.sample}</span> chances.
    </p>
  );
}

function WorstVsRaceDetail({ q }: { q: WorstVsRaceQ }) {
  return (
    <ul className="space-y-1">
      {q.options.map((o) => (
        <li
          key={o}
          className="flex items-center justify-between rounded border border-border bg-bg-surface px-2 py-1"
        >
          <span className={o === q.truth ? "text-text" : "text-text-muted truncate"}>
            {o}
          </span>
          <span className="font-mono tabular-nums text-text-dim">
            {(q.lossesByOption[o] || 0).toLocaleString()} L
            {o === q.truth ? (
              <span className="ml-1 rounded bg-warning/15 px-1.5 text-warning">⚠</span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
