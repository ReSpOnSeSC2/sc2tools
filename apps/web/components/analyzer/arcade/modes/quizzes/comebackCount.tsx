"use client";

import { useState, type ReactNode } from "react";
import { fmtDate } from "@/lib/format";
import { QuizAnswerButton, QuizCard } from "../../shells/QuizCard";
import { IconFor } from "../../icons";
import {
  outcome,
  registerMode,
  sessionize,
  type Session,
} from "../../ArcadeEngine";
import type {
  ArcadeGame,
  GenerateInput,
  GenerateResult,
  Mode,
  ScoreResult,
  ShareSummary,
} from "../../types";

const ID = "comeback-count";
registerMode(ID, "temporal");

/* ──────────── variant rotation ────────────
 *
 * Five angles on the same underlying definition of a "comeback
 * session" (≥3 games, first two are losses, final win-rate > 50%).
 * Daily mode pins the variant via day-of-year so two devices on the
 * same date see the same prompt. Quick Play rolls a variant via the
 * seeded RNG. Each variant has its own gate; the orchestrator walks
 * the list in pinned-first order and falls back to `count` (the most
 * permissive, always answerable once ≥5 sessions exist).
 */

export type ComebackVariant = "count" | "rate" | "recency" | "depth" | "matchup";

export const COMEBACK_ROTATION: ReadonlyArray<ComebackVariant> = [
  "count",
  "rate",
  "recency",
  "depth",
  "matchup",
];

export const VARIANT_LABEL: Record<ComebackVariant, string> = {
  count: "Comeback count",
  rate: "Comeback conversion rate",
  recency: "Most recent comeback",
  depth: "Deepest comeback",
  matchup: "Comeback matchup",
};

const VARIANT_DEPTH_LABEL: Record<ComebackVariant, string> = {
  count: "Per-session sequence count",
  rate: "Per-session sequence rate",
  recency: "Per-session sequence recency",
  depth: "Per-session loss-depth",
  matchup: "Per-session opponent grouping",
};

/* ──────────── buckets (pure, fully testable) ──────────── */

export const COUNT_BUCKETS = ["0", "1-2", "3-5", "6+"] as const;
export type CountBucket = (typeof COUNT_BUCKETS)[number];

export const RATE_BUCKETS = ["0–25%", "26–50%", "51–75%", "76–100%"] as const;
export type RateBucket = (typeof RATE_BUCKETS)[number];

export const RECENCY_BUCKETS = [
  "Last 7 days",
  "1–4 weeks ago",
  "1–3 months ago",
  "3+ months ago",
] as const;
export type RecencyBucket = (typeof RECENCY_BUCKETS)[number];

export const DEPTH_BUCKETS = [
  "2 losses",
  "3 losses",
  "4 losses",
  "5+ losses",
] as const;
export type DepthBucket = (typeof DEPTH_BUCKETS)[number];

export const MATCHUP_BUCKETS = [
  "vs Protoss",
  "vs Terran",
  "vs Zerg",
  "vs Random",
] as const;
export type MatchupBucket = (typeof MATCHUP_BUCKETS)[number];

export function countBucket(n: number): CountBucket {
  if (n === 0) return "0";
  if (n <= 2) return "1-2";
  if (n <= 5) return "3-5";
  return "6+";
}

export function rateBucket(ratio: number): RateBucket {
  if (ratio <= 0.25) return "0–25%";
  if (ratio <= 0.5) return "26–50%";
  if (ratio <= 0.75) return "51–75%";
  return "76–100%";
}

export function recencyBucket(iso: string, now: Date): RecencyBucket | null {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  const days = Math.floor((now.getTime() - t) / 86_400_000);
  // Clock skew (future-dated rows) snaps to "Last 7 days" so the bucket
  // is always defined for a known comeback.
  if (days <= 7) return "Last 7 days";
  if (days <= 28) return "1–4 weeks ago";
  if (days <= 90) return "1–3 months ago";
  return "3+ months ago";
}

export function depthBucket(n: number): DepthBucket {
  if (n <= 2) return "2 losses";
  if (n === 3) return "3 losses";
  if (n === 4) return "4 losses";
  return "5+ losses";
}

export function matchupBucket(
  race: "P" | "T" | "Z" | "R" | null,
): MatchupBucket {
  if (race === "P") return "vs Protoss";
  if (race === "T") return "vs Terran";
  if (race === "Z") return "vs Zerg";
  return "vs Random";
}

/* ──────────── analysis (shared across variants) ──────────── */

export interface ComebackSession {
  startDate: string;
  endDate: string;
  /** Leading losing-streak length before the first non-loss. Always ≥2. */
  initialLosses: number;
  wins: number;
  losses: number;
  /** Opp race of the very first game of the session, normalised. */
  firstOppRace: "P" | "T" | "Z" | "R" | null;
}

export interface ComebackAnalysis {
  sessions: Session[];
  /** Sessions of ≥3 games whose first two games were both losses. */
  zeroTwoStarts: Session[];
  /** Of those, the ones whose final win-rate is strictly > 50%. */
  comebacks: ComebackSession[];
}

function normRace(r: string | undefined): "P" | "T" | "Z" | "R" | null {
  const c = String(r || "").charAt(0).toUpperCase();
  if (c === "P" || c === "T" || c === "Z" || c === "R") return c;
  return null;
}

function leadingLossCount(games: ArcadeGame[]): number {
  let i = 0;
  for (; i < games.length; i++) {
    if (outcome(games[i]) !== "L") break;
  }
  return i;
}

export function analyzeComebacks(gamesAsc: ArcadeGame[]): ComebackAnalysis {
  const sessions = sessionize(gamesAsc);
  const zeroTwoStarts: Session[] = [];
  const comebacks: ComebackSession[] = [];
  for (const s of sessions) {
    if (s.games.length < 3) continue;
    if (outcome(s.games[0]) !== "L" || outcome(s.games[1]) !== "L") continue;
    zeroTwoStarts.push(s);
    let wins = 0;
    let losses = 0;
    for (const g of s.games) {
      const o = outcome(g);
      if (o === "W") wins++;
      else if (o === "L") losses++;
    }
    if (wins + losses === 0) continue;
    if (wins / (wins + losses) <= 0.5) continue;
    comebacks.push({
      startDate: s.startDate,
      endDate: s.endDate,
      initialLosses: leadingLossCount(s.games),
      wins,
      losses,
      firstOppRace: normRace(s.games[0].oppRace),
    });
  }
  return { sessions, zeroTwoStarts, comebacks };
}

/* ──────────── per-variant spec builders ──────────── */

interface VariantSpec {
  variant: ComebackVariant;
  buckets: ReadonlyArray<string>;
  truth: string;
  /** Numeric / iso truth value used in the reveal note. */
  truthValue: number | string;
  raceTally?: Record<MatchupBucket, number>;
  depthTally?: Record<DepthBucket, number>;
}

function specCount(a: ComebackAnalysis): VariantSpec {
  const n = a.comebacks.length;
  return {
    variant: "count",
    buckets: COUNT_BUCKETS,
    truth: countBucket(n),
    truthValue: n,
  };
}

function specRate(a: ComebackAnalysis): VariantSpec | null {
  if (a.zeroTwoStarts.length < 3) return null;
  const ratio = a.comebacks.length / a.zeroTwoStarts.length;
  return {
    variant: "rate",
    buckets: RATE_BUCKETS,
    truth: rateBucket(ratio),
    truthValue: ratio,
  };
}

function specRecency(a: ComebackAnalysis, now: Date): VariantSpec | null {
  if (!a.comebacks.length) return null;
  const latest = a.comebacks
    .slice()
    .sort(
      (x, y) =>
        new Date(y.endDate).getTime() - new Date(x.endDate).getTime(),
    )[0];
  const b = recencyBucket(latest.endDate, now);
  if (!b) return null;
  return {
    variant: "recency",
    buckets: RECENCY_BUCKETS,
    truth: b,
    truthValue: latest.endDate,
  };
}

function specDepth(a: ComebackAnalysis): VariantSpec | null {
  if (!a.comebacks.length) return null;
  const tally: Record<DepthBucket, number> = {
    "2 losses": 0,
    "3 losses": 0,
    "4 losses": 0,
    "5+ losses": 0,
  };
  let deepest = 0;
  for (const c of a.comebacks) {
    if (c.initialLosses < 2) continue;
    tally[depthBucket(c.initialLosses)] += 1;
    if (c.initialLosses > deepest) deepest = c.initialLosses;
  }
  if (deepest < 2) return null;
  return {
    variant: "depth",
    buckets: DEPTH_BUCKETS,
    truth: depthBucket(deepest),
    truthValue: deepest,
    depthTally: tally,
  };
}

function specMatchup(a: ComebackAnalysis): VariantSpec | null {
  if (!a.comebacks.length) return null;
  const tally: Record<MatchupBucket, number> = {
    "vs Protoss": 0,
    "vs Terran": 0,
    "vs Zerg": 0,
    "vs Random": 0,
  };
  for (const c of a.comebacks) {
    tally[matchupBucket(c.firstOppRace)] += 1;
  }
  // First-encountered wins on ties — canonical P→T→Z→R ordering
  // matches MATCHUP_BUCKETS so daily rolls are deterministic.
  let best: MatchupBucket = "vs Protoss";
  let bestCount = -1;
  for (const b of MATCHUP_BUCKETS) {
    if (tally[b] > bestCount) {
      best = b;
      bestCount = tally[b];
    }
  }
  if (bestCount <= 0) return null;
  return {
    variant: "matchup",
    buckets: MATCHUP_BUCKETS,
    truth: best,
    truthValue: bestCount,
    raceTally: tally,
  };
}

const BUILDERS: Record<
  ComebackVariant,
  (a: ComebackAnalysis, now: Date) => VariantSpec | null
> = {
  count: (a) => specCount(a),
  rate: (a) => specRate(a),
  recency: (a, now) => specRecency(a, now),
  depth: (a) => specDepth(a),
  matchup: (a) => specMatchup(a),
};

/* ──────────── variant selection ────────────
 *
 * For Daily mode the variant is pinned by day-of-year so devices
 * agree. For Quick Play the variant is rolled via the seeded RNG.
 * In both cases we return the *full* rotation with the chosen
 * variant first, so the orchestrator can fall through to the next
 * answerable variant when today's pinned one fails its gate.
 */

/** Day-of-year (UTC) for a yyyy-mm-dd seed. */
export function dayOfYear(daySeed: string): number {
  if (!daySeed) return 0;
  const t = new Date(`${daySeed}T00:00:00Z`).getTime();
  if (!Number.isFinite(t)) return 0;
  const start = new Date(`${daySeed.slice(0, 4)}-01-01T00:00:00Z`).getTime();
  return Math.floor((t - start) / 86_400_000);
}

export function variantOrderFor(input: {
  daySeed: string;
  rng: () => number;
}): ComebackVariant[] {
  const pinIdx = input.daySeed
    ? dayOfYear(input.daySeed) % COMEBACK_ROTATION.length
    : Math.floor(input.rng() * COMEBACK_ROTATION.length);
  const head = COMEBACK_ROTATION[pinIdx] ?? COMEBACK_ROTATION[0];
  const tail = COMEBACK_ROTATION.filter((v) => v !== head);
  return [head, ...tail];
}

/* ──────────── question payload ──────────── */

type Q = {
  variant: ComebackVariant;
  buckets: ReadonlyArray<string>;
  truth: string;
  truthValue: number | string;
  comebacks: ComebackSession[];
  /** Denominator for the rate variant; 0 elsewhere. */
  zeroTwoStartCount: number;
  raceTally?: Record<MatchupBucket, number>;
  depthTally?: Record<DepthBucket, number>;
};

type A = string;

/* ──────────── generate ──────────── */

async function generate(input: GenerateInput): Promise<GenerateResult<Q>> {
  const chrono = [...input.data.games].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );
  const analysis = analyzeComebacks(chrono);
  if (analysis.sessions.length < 5) {
    return { ok: false, reason: "Not enough distinct sessions yet." };
  }

  const now = new Date();
  const order = variantOrderFor({
    daySeed: input.daySeed,
    rng: input.rng,
  });

  for (const variant of order) {
    const spec = BUILDERS[variant](analysis, now);
    if (!spec) continue;
    return {
      ok: true,
      minDataMet: true,
      question: {
        variant: spec.variant,
        buckets: spec.buckets,
        truth: spec.truth,
        truthValue: spec.truthValue,
        comebacks: analysis.comebacks,
        zeroTwoStartCount: analysis.zeroTwoStarts.length,
        raceTally: spec.raceTally,
        depthTally: spec.depthTally,
      },
    };
  }
  // specCount is unconditionally answerable once sessions ≥5, so this
  // branch is for type-safety only.
  return { ok: false, reason: "No comeback variant could be generated." };
}

/* ──────────── score ──────────── */

const XP_BY_VARIANT: Record<ComebackVariant, number> = {
  count: 12,
  rate: 14,
  recency: 14,
  depth: 16,
  matchup: 14,
};

function noteFor(q: Q): string {
  switch (q.variant) {
    case "count": {
      const n = q.truthValue as number;
      return `${n} comeback session${n === 1 ? "" : "s"} (${q.truth}).`;
    }
    case "rate": {
      const r = q.truthValue as number;
      return `${Math.round(r * 100)}% conversion across ${q.zeroTwoStartCount} 0-2 starts.`;
    }
    case "recency":
      return `Most recent comeback: ${fmtDate(q.truthValue as string)}.`;
    case "depth":
      return `Deepest comeback opened with ${q.truthValue} straight losses.`;
    case "matchup": {
      const n = q.truthValue as number;
      return `${q.truth.replace("vs ", "")} appeared first ${n}× in your comeback sessions.`;
    }
  }
}

function score(q: Q, a: A): ScoreResult {
  const correct = a === q.truth;
  return {
    raw: correct ? 1 : 0,
    xp: correct ? XP_BY_VARIANT[q.variant] : 0,
    outcome: correct ? "correct" : "wrong",
    note: noteFor(q),
  };
}

function questionPlain(q: Q): string {
  switch (q.variant) {
    case "count":
      return "How many of your play sessions opened 0–2 but finished above 50%?";
    case "rate":
      return `Of the ${q.zeroTwoStartCount} sessions you opened 0–2, what share finished above 50%?`;
    case "recency":
      return "When did your most recent 0–2 → above-50% comeback happen?";
    case "depth":
      return "What was the deepest losing streak you ever climbed out of inside a single comeback session?";
    case "matchup":
      return "Across all your comebacks, which first-game opponent race appeared most often?";
  }
}

function share(q: Q, _a: A | null, _s: ScoreResult): ShareSummary {
  const headline = `${VARIANT_LABEL[q.variant]}: ${q.truth}`;
  const detail = noteFor(q);
  const answer: string[] = [headline, detail];
  if (q.variant === "count") {
    for (const c of q.comebacks.slice(0, 6)) {
      answer.push(`${fmtDate(c.startDate)} · ${c.wins}W / ${c.losses}L`);
    }
  } else if (q.variant === "rate") {
    const n = q.comebacks.length;
    const d = q.zeroTwoStartCount;
    const pct = d > 0 ? Math.round((n / d) * 100) : 0;
    answer.push(`${n} of ${d} 0-2 starts turned into comebacks (${pct}%).`);
  } else if (q.variant === "depth" && q.depthTally) {
    for (const b of DEPTH_BUCKETS) {
      const star = b === q.truth ? " ★" : "";
      answer.push(`${b} · ${q.depthTally[b]}${star}`);
    }
  } else if (q.variant === "matchup" && q.raceTally) {
    for (const b of MATCHUP_BUCKETS) {
      const star = b === q.truth ? " ★" : "";
      answer.push(`${b} · ${q.raceTally[b]}${star}`);
    }
  }
  return {
    question: questionPlain(q),
    answer,
  };
}

export const comebackCount: Mode<Q, A> = {
  id: ID,
  kind: "quiz",
  category: "sessions",
  difficulty: "medium",
  ttp: "fast",
  depthTag: "temporal",
  title: "Comeback Count",
  blurb:
    "Five angles on the sessions you opened 0–2 but finished above 50%. Daily rotation keeps it fresh.",
  generate,
  score,
  share,
  render: (ctx) => <Render ctx={ctx} />,
};

/* ──────────── render ──────────── */

function promptFor(q: Q): ReactNode {
  switch (q.variant) {
    case "count":
      return (
        <span>
          How many of your <span className="font-semibold">play sessions</span> opened 0–2 but
          finished above 50%?
        </span>
      );
    case "rate":
      return (
        <span>
          Of the <span className="font-mono tabular-nums">{q.zeroTwoStartCount}</span> sessions
          you <span className="font-semibold">opened 0–2</span>, what share finished above 50%?
        </span>
      );
    case "recency":
      return (
        <span>
          When did your <span className="font-semibold">most recent</span> 0–2 → above-50% comeback
          happen?
        </span>
      );
    case "depth":
      return (
        <span>
          What was the <span className="font-semibold">deepest losing streak</span> you ever
          climbed out of inside a single comeback session?
        </span>
      );
    case "matchup":
      return (
        <span>
          Across all your comebacks, which{" "}
          <span className="font-semibold">first-game opponent race</span> appeared most often?
        </span>
      );
  }
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
      title={comebackCount.title}
      depthLabel={VARIANT_DEPTH_LABEL[ctx.question.variant]}
      isDaily={ctx.isDaily}
      revealed={ctx.revealed}
      onKeyAnswer={(i) => {
        const b = ctx.question.buckets[i];
        if (b) onPick(b);
      }}
      question={promptFor(ctx.question)}
      answers={ctx.question.buckets.map((b, i) => (
        <QuizAnswerButton
          key={b}
          index={i}
          selected={picked === b}
          correct={
            ctx.revealed
              ? b === ctx.question.truth
                ? true
                : picked === b
                  ? false
                  : null
              : null
          }
          onClick={() => onPick(b)}
          disabled={ctx.revealed}
        >
          {b}
        </QuizAnswerButton>
      ))}
      reveal={reveal}
    />
  );
}

function Reveal({ q, score }: { q: Q; score: ScoreResult }) {
  const headline = (
    <p>
      <span className="font-semibold">{VARIANT_LABEL[q.variant]}:</span>{" "}
      <span className="font-mono tabular-nums text-success">{q.truth}</span>{" "}
      {score.outcome === "correct" ? (
        <span className="text-success">— right bucket.</span>
      ) : (
        <span className="text-warning">— it was {q.truth}.</span>
      )}
    </p>
  );

  let detail: ReactNode = null;
  if (q.variant === "count") detail = <CountDetail q={q} />;
  else if (q.variant === "rate") detail = <RateDetail q={q} />;
  else if (q.variant === "recency") detail = <RecencyDetail q={q} />;
  else if (q.variant === "depth") detail = <DepthDetail q={q} />;
  else if (q.variant === "matchup") detail = <MatchupDetail q={q} />;

  return (
    <div className="space-y-2 text-caption text-text">
      {headline}
      {detail}
    </div>
  );
}

function CountDetail({ q }: { q: Q }) {
  if (!q.comebacks.length) return null;
  return (
    <ul className="space-y-1" aria-label="Comeback sessions">
      {q.comebacks.slice(0, 6).map((c) => (
        <li
          key={c.startDate}
          className="flex items-center justify-between gap-2 rounded border border-border bg-bg-surface px-2 py-1 text-text-muted"
        >
          <span>{fmtDate(c.startDate)}</span>
          <span className="font-mono tabular-nums text-text-dim">
            {c.wins}W / {c.losses}L
          </span>
        </li>
      ))}
    </ul>
  );
}

function RateDetail({ q }: { q: Q }) {
  const n = q.comebacks.length;
  const d = q.zeroTwoStartCount;
  const pct = d > 0 ? Math.round((n / d) * 100) : 0;
  return (
    <p className="text-text-muted">
      <span className="font-mono tabular-nums text-text">{n}</span> of{" "}
      <span className="font-mono tabular-nums text-text">{d}</span> 0-2 starts turned into
      comebacks{" "}
      <span className="text-text-dim">({pct}%).</span>
    </p>
  );
}

function RecencyDetail({ q }: { q: Q }) {
  const date = q.truthValue as string;
  return (
    <p className="text-text-muted">
      Last comeback wrapped up <span className="font-mono">{fmtDate(date)}</span>.
    </p>
  );
}

function DepthDetail({ q }: { q: Q }) {
  if (!q.depthTally) return null;
  return (
    <ul className="space-y-1" aria-label="Comeback depth distribution">
      {DEPTH_BUCKETS.map((b) => (
        <li
          key={b}
          className="flex items-center justify-between rounded border border-border bg-bg-surface px-2 py-1"
        >
          <span className={b === q.truth ? "text-text" : "text-text-muted"}>{b}</span>
          <span className="font-mono tabular-nums text-text-dim">
            {q.depthTally![b]}
          </span>
        </li>
      ))}
    </ul>
  );
}

function MatchupDetail({ q }: { q: Q }) {
  if (!q.raceTally) return null;
  return (
    <ul className="space-y-1" aria-label="Comeback matchup distribution">
      {MATCHUP_BUCKETS.map((b) => (
        <li
          key={b}
          className="flex items-center justify-between rounded border border-border bg-bg-surface px-2 py-1"
        >
          <span className={b === q.truth ? "text-text" : "text-text-muted"}>{b}</span>
          <span className="font-mono tabular-nums text-text-dim">
            {q.raceTally![b]}
          </span>
        </li>
      ))}
    </ul>
  );
}
