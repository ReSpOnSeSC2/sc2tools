"use client";

import { Fragment, useState } from "react";
import { pct1, wrColor } from "@/lib/format";
import { isBarcodeName } from "@/lib/sc2pulse";
import { QuizAnswerButton, QuizCard } from "../../shells/QuizCard";
import { IconFor } from "../../icons";
import {
  longestBrokenLossStreak,
  longestBrokenWinStreak,
  outcome,
  pickN,
  registerMode,
} from "../../ArcadeEngine";
import type {
  ArcadeGame,
  ArcadeOpponent,
  GenerateInput,
  GenerateResult,
  Mode,
  ScoreResult,
  ShareSummary,
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

/**
 * Variant axes — each one is a different question the mode can ask
 * about the same opponent set. The default ("highest-wr-vs-you")
 * matches the pre-variant behavior; the others add trivia depth
 * (most-faced rival, who you last beat / lost to, and streak-broker
 * variants that surface meaningful turning points in your history).
 */
export type OpponentBracketVariant =
  | "highest-wr-vs-you"
  | "most-faced"
  | "last-beaten"
  | "last-loss-to"
  | "broke-their-streak"
  | "they-broke-yours";

/** Streak runs shorter than this aren't interesting enough to anchor a question. */
const BROKEN_STREAK_FLOOR = 3;

type Q = {
  variant?: OpponentBracketVariant;
  candidates: Candidate[];
  /** Per-candidate variant-specific reveal labels, parallel to candidates. */
  metrics?: string[];
  /** Index in candidates that satisfies the variant's question. */
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
  // Pick a variant first, then try to resolve it against the sample.
  // Date-based variants need per-opponent game timestamps and a
  // qualifying win/loss in those timestamps; if they can't resolve
  // we fall back to the always-available "highest-wr-vs-you" variant.
  // Variants are randomized via the seeded rng so daily content
  // cycles deterministically across days but Quick Play feels varied.
  const order = shuffleVariants(input.rng);
  const lastGameByOpp = lastGameDates(input.data.games);
  const brokenByOpp = brokenStreakLengths(input.data.games);
  for (const variant of order) {
    const resolved = resolveVariant(variant, sample, lastGameByOpp, brokenByOpp);
    if (resolved) {
      return {
        ok: true,
        minDataMet: true,
        question: {
          variant,
          candidates: sample,
          metrics: resolved.metrics,
          correctIndex: resolved.correctIndex,
        },
      };
    }
  }
  // Should never get here — "highest-wr-vs-you" always resolves on a
  // 4-candidate sample.
  return {
    ok: false,
    reason: "Couldn't build a round from these opponents.",
  };
}

function score(q: Q, a: A): ScoreResult {
  const correct = a === q.correctIndex;
  const c = q.candidates[q.correctIndex];
  const v = q.variant ?? "highest-wr-vs-you";
  const correctNote: Record<OpponentBracketVariant, string> = {
    "highest-wr-vs-you": "You spotted the opponent who beats you most often.",
    "most-faced": "You named the opponent you've faced the most.",
    "last-beaten": "You named the opponent you most recently beat.",
    "last-loss-to": "You named the opponent who most recently beat you.",
    "broke-their-streak": "You named the rival whose run against you you snapped.",
    "they-broke-yours": "You named the rival who snapped your run against them.",
  };
  const missNote: Record<OpponentBracketVariant, string> = {
    "highest-wr-vs-you": `Their WR vs you was ${pct1(c.opponentWinRate)} (${c.losses}-${c.wins}).`,
    "most-faced": `It was ${displayNameFor(c)} with ${c.games} games played.`,
    "last-beaten": `It was ${displayNameFor(c)} — your most recent win.`,
    "last-loss-to": `It was ${displayNameFor(c)} — your most recent loss.`,
    "broke-their-streak": `It was ${displayNameFor(c)} — you ended their longest run against you.`,
    "they-broke-yours": `It was ${displayNameFor(c)} — they ended your longest run against them.`,
  };
  return {
    raw: correct ? 1 : 0,
    xp: correct ? 10 : 0,
    outcome: correct ? "correct" : "wrong",
    note: correct ? correctNote[v] : missNote[v],
  };
}

/* ──────────── Variant resolution ──────────── */

/**
 * Last user win / loss timestamp per opponent (ms since epoch), or
 * -Infinity when the opponent has never been beaten / never beat the
 * user. Returned in one pass over data.games so each variant can do
 * cheap candidate lookups.
 */
type LastDates = Map<string, { lastWin: number; lastLoss: number }>;

function lastGameDates(games: ArcadeGame[]): LastDates {
  const out: LastDates = new Map();
  for (const g of games) {
    if (!g.oppPulseId) continue;
    const t = new Date(g.date).getTime();
    if (!Number.isFinite(t)) continue;
    const o = outcome(g);
    if (o === "U") continue;
    const cur = out.get(g.oppPulseId) ?? {
      lastWin: -Infinity,
      lastLoss: -Infinity,
    };
    if (o === "W" && t > cur.lastWin) cur.lastWin = t;
    if (o === "L" && t > cur.lastLoss) cur.lastLoss = t;
    out.set(g.oppPulseId, cur);
  }
  return out;
}

/**
 * Per-opponent longest broken streak in either direction. "Broken"
 * means the run was followed by an opposing outcome — a 5-game L
 * streak that the user eventually snapped with a W counts; a still-
 * active L-streak with no terminating W doesn't. Used by the
 * "broke-their-streak" and "they-broke-yours" variants.
 */
type BrokenStreaks = Map<string, { brokenLoss: number; brokenWin: number }>;

function brokenStreakLengths(games: ArcadeGame[]): BrokenStreaks {
  const grouped = new Map<string, ArcadeGame[]>();
  for (const g of games) {
    if (!g.oppPulseId) continue;
    if (!grouped.has(g.oppPulseId)) grouped.set(g.oppPulseId, []);
    grouped.get(g.oppPulseId)!.push(g);
  }
  const out: BrokenStreaks = new Map();
  for (const [pid, list] of grouped) {
    const asc = list
      .slice()
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    out.set(pid, {
      brokenLoss: longestBrokenLossStreak(asc),
      brokenWin: longestBrokenWinStreak(asc),
    });
  }
  return out;
}

/**
 * Try to resolve a variant against this sample. Returns null if the
 * variant can't produce an unambiguous answer (e.g. nobody has any
 * recorded wins for "last-beaten"). Returns the correctIndex and
 * per-candidate display strings on success.
 */
function resolveVariant(
  variant: OpponentBracketVariant,
  sample: Candidate[],
  lastDates: LastDates,
  brokenStreaks: BrokenStreaks,
): { correctIndex: number; metrics: string[] } | null {
  if (variant === "highest-wr-vs-you") {
    let best = 0;
    for (let i = 1; i < sample.length; i++) {
      if (sample[i].opponentWinRate > sample[best].opponentWinRate) best = i;
    }
    return {
      correctIndex: best,
      metrics: sample.map(
        (c) => `${pct1(c.opponentWinRate)} (${c.losses}-${c.wins})`,
      ),
    };
  }
  if (variant === "most-faced") {
    let best = 0;
    for (let i = 1; i < sample.length; i++) {
      if (sample[i].games > sample[best].games) best = i;
    }
    // Need a clear leader to avoid ties.
    const tiedAtBest = sample.filter((c) => c.games === sample[best].games);
    if (tiedAtBest.length > 1) return null;
    return {
      correctIndex: best,
      metrics: sample.map((c) => `${c.games} games`),
    };
  }
  if (variant === "last-beaten" || variant === "last-loss-to") {
    const key = variant === "last-beaten" ? "lastWin" : "lastLoss";
    const ts = sample.map((c) => lastDates.get(c.pulseId)?.[key] ?? -Infinity);
    let best = -1;
    let bestT = -Infinity;
    let tied = false;
    for (let i = 0; i < ts.length; i++) {
      if (!Number.isFinite(ts[i])) continue;
      if (ts[i] > bestT) {
        bestT = ts[i];
        best = i;
        tied = false;
      } else if (ts[i] === bestT) {
        tied = true;
      }
    }
    if (best < 0 || tied) return null;
    return {
      correctIndex: best,
      metrics: ts.map((t) =>
        Number.isFinite(t) ? relativeDays(t) : "never",
      ),
    };
  }
  if (variant === "broke-their-streak" || variant === "they-broke-yours") {
    const key = variant === "broke-their-streak" ? "brokenLoss" : "brokenWin";
    const values = sample.map(
      (c) => brokenStreaks.get(c.pulseId)?.[key] ?? 0,
    );
    const max = values.reduce((m, v) => (v > m ? v : m), 0);
    // Need a meaningful broken streak (≥3) AND a clear leader.
    if (max < BROKEN_STREAK_FLOOR) return null;
    const tiedAtMax = values.filter((v) => v === max).length;
    if (tiedAtMax > 1) return null;
    const best = values.indexOf(max);
    const verb = variant === "broke-their-streak" ? "you broke" : "they broke";
    return {
      correctIndex: best,
      metrics: values.map((v) =>
        v >= BROKEN_STREAK_FLOOR
          ? `${v}-game streak ${verb}`
          : v > 0
            ? `${v}-game run`
            : "no run on record",
      ),
    };
  }
  return null;
}

function shuffleVariants(rng: () => number): OpponentBracketVariant[] {
  const all: OpponentBracketVariant[] = [
    "highest-wr-vs-you",
    "most-faced",
    "last-beaten",
    "last-loss-to",
    "broke-their-streak",
    "they-broke-yours",
  ];
  const out = all.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  // Always keep highest-wr-vs-you as a final fallback so resolveVariant
  // is guaranteed to succeed on a 4-candidate sample.
  if (out[out.length - 1] !== "highest-wr-vs-you") {
    const idx = out.indexOf("highest-wr-vs-you");
    [out[idx], out[out.length - 1]] = [out[out.length - 1], out[idx]];
  }
  return out;
}

/** Friendly "N days ago" / "today" / "yesterday" label for a timestamp. */
function relativeDays(t: number): string {
  const ms = Date.now() - t;
  const days = Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) {
    const w = Math.floor(days / 7);
    return w === 1 ? "1 week ago" : `${w} weeks ago`;
  }
  if (days < 365) {
    const m = Math.floor(days / 30);
    return m === 1 ? "1 month ago" : `${m} months ago`;
  }
  const y = Math.floor(days / 365);
  return y === 1 ? "1 year ago" : `${y} years ago`;
}

/* ──────────── Variant question text ──────────── */

function questionFor(variant: OpponentBracketVariant): React.ReactNode {
  if (variant === "most-faced") {
    return (
      <Fragment>
        Four opponents from your history. Which one have you
        <span className="font-semibold text-warning"> played the most</span>?
      </Fragment>
    );
  }
  if (variant === "last-beaten") {
    return (
      <Fragment>
        Four opponents from your history. Which one did you
        <span className="font-semibold text-warning"> most recently beat</span>?
      </Fragment>
    );
  }
  if (variant === "last-loss-to") {
    return (
      <Fragment>
        Four opponents from your history. Which one
        <span className="font-semibold text-warning"> most recently beat you</span>?
      </Fragment>
    );
  }
  if (variant === "broke-their-streak") {
    return (
      <Fragment>
        Four opponents from your history. Which one had the
        <span className="font-semibold text-warning"> longest streak against you that you broke</span>?
      </Fragment>
    );
  }
  if (variant === "they-broke-yours") {
    return (
      <Fragment>
        Four opponents from your history. Which one
        <span className="font-semibold text-warning"> broke your longest streak against them</span>?
      </Fragment>
    );
  }
  return (
    <Fragment>
      Four opponents you&apos;ve played at least 3 times each. Which one has the
      <span className="font-semibold text-warning"> highest WR against you</span>?
    </Fragment>
  );
}

function questionPlain(variant: OpponentBracketVariant): string {
  if (variant === "most-faced") {
    return "Four opponents from your history. Which one have you played the most?";
  }
  if (variant === "last-beaten") {
    return "Four opponents from your history. Which one did you most recently beat?";
  }
  if (variant === "last-loss-to") {
    return "Four opponents from your history. Which one most recently beat you?";
  }
  if (variant === "broke-their-streak") {
    return "Four opponents from your history. Which one had the longest streak against you that you broke?";
  }
  if (variant === "they-broke-yours") {
    return "Four opponents from your history. Which one broke your longest streak against them?";
  }
  return "Four opponents you've played at least 3 times each. Which one has the highest WR against you?";
}

function share(q: Q, a: A | null, s: ScoreResult): ShareSummary {
  const variant = q.variant ?? "highest-wr-vs-you";
  const correct = q.candidates[q.correctIndex];
  const fallbackMetrics = q.candidates.map(
    (c) => `${pct1(c.opponentWinRate)} (${c.losses}-${c.wins})`,
  );
  const metrics = q.metrics ?? fallbackMetrics;
  const userCorrect = a === q.correctIndex;
  const headline = userCorrect
    ? s.note ?? `It was ${displayNameFor(correct)}.`
    : `It was ${displayNameFor(correct)} — ${metrics[q.correctIndex]}.`;
  const rows = q.candidates.map((c, i) => {
    const star = i === q.correctIndex ? " ★" : "";
    return `${displayNameFor(c)} · ${metrics[i]}${star}`;
  });
  return {
    question: questionPlain(variant),
    answer: [headline, ...rows],
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
  share,
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

  const variant = ctx.question.variant ?? "highest-wr-vs-you";
  const fallbackMetrics = ctx.question.candidates.map(
    (c) => `${pct1(c.opponentWinRate)} (${c.losses}-${c.wins})`,
  );
  const metrics = ctx.question.metrics ?? fallbackMetrics;
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
              style={
                variant === "highest-wr-vs-you"
                  ? { color: wrColor(c.opponentWinRate, c.games) }
                  : undefined
              }
            >
              {metrics[i]}
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
      question={questionFor(variant)}
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
          {/* No subtitle: the games-played count would directly give
              away the "most-faced" variant's answer, so the button
              shows only the opponent's display name. All per-candidate
              metrics surface in the reveal after answering. */}
          <span className="truncate text-body font-medium text-text">
            {displayNameFor(c)}
          </span>
        </QuizAnswerButton>
      ))}
      reveal={reveal}
    />
  );
}
