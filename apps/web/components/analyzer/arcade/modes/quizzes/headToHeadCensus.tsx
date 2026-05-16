"use client";

import { useState, type ReactNode } from "react";
import { pct1 } from "@/lib/format";
import { QuizAnswerButton, QuizCard } from "../../shells/QuizCard";
import { IconFor } from "../../icons";
import { outcome, registerMode } from "../../ArcadeEngine";
import type {
  ArcadeGame,
  ArcadeOpponent,
  GenerateInput,
  GenerateResult,
  Mode,
  ScoreResult,
  ShareSummary,
} from "../../types";

/**
 * Head-to-Head Census — "of the opponents you played at least N times
 * in window W, how many do you hold WR-profile P against?"
 *
 * Twelve curated variants cycle the (WR profile × time window × min-
 * games) axes so daily content stays fresh and the user learns the
 * shape of their rivalry book across both recent (90d) and long-tail
 * (year, all-time) horizons.
 *
 * Pure modules:
 *   • groupByOpponent() walks the games array once per window.
 *   • matchingOpponents() applies the WR-profile predicate.
 *   • bucketize() collapses an exact count to a 4-bucket pick.
 * Render is a single React component that drives the QuizCard shell.
 */

const ID = "head-to-head-census";
registerMode(ID, "conditional");

/* ──────────── Variant model ──────────── */

export type WrProfile =
  | "perfect"
  | "winless"
  | "even"
  | "dominant"
  | "struggle";

export type TimeWindow = "90d" | "365d" | "all";
export type MinGames = 5 | 10 | 20;

export interface CensusVariant {
  wr: WrProfile;
  window: TimeWindow;
  minGames: MinGames;
}

export function variantKey(v: CensusVariant): string {
  return `${v.wr}:${v.window}:${v.minGames}`;
}

/**
 * Curated rotation. Order matters — it drives the day-of-year pin so
 * two devices on the same date see the same prompt. The list spans
 * (perfect | winless | even | dominant | struggle) × (90d | 365d |
 * all-time) × (5 | 10 | 20) but only enumerates the combinations that
 * stay meaningful on a typical ladder grinder's data — the perfect/
 * winless variants pair with smaller min-games thresholds because
 * "perfect on 20 games" is rare; the even variant pairs with larger
 * thresholds because exact 50% needs even totals.
 */
export const VARIANT_ROTATION: ReadonlyArray<CensusVariant> = [
  { wr: "perfect", window: "365d", minGames: 5 },
  { wr: "winless", window: "365d", minGames: 5 },
  { wr: "perfect", window: "365d", minGames: 10 },
  { wr: "winless", window: "365d", minGames: 10 },
  { wr: "even", window: "365d", minGames: 10 },
  { wr: "even", window: "365d", minGames: 20 },
  { wr: "dominant", window: "365d", minGames: 10 },
  { wr: "struggle", window: "365d", minGames: 10 },
  { wr: "perfect", window: "90d", minGames: 5 },
  { wr: "winless", window: "90d", minGames: 5 },
  { wr: "perfect", window: "all", minGames: 10 },
  { wr: "winless", window: "all", minGames: 10 },
];

export const BUCKETS = ["0", "1-2", "3-5", "6+"] as const;
export type Bucket = (typeof BUCKETS)[number];

export function bucketize(n: number): Bucket {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n <= 2) return "1-2";
  if (n <= 5) return "3-5";
  return "6+";
}

const WR_LABEL: Record<WrProfile, string> = {
  perfect: "100% WR (you've never lost)",
  winless: "0% WR (you've never won)",
  even: "exactly 50% WR",
  dominant: "≥70% WR (without being perfect)",
  struggle: "≤30% WR (without being winless)",
};

const WR_SHORT: Record<WrProfile, string> = {
  perfect: "100%",
  winless: "0%",
  even: "50%",
  dominant: "≥70%",
  struggle: "≤30%",
};

const WINDOW_LABEL: Record<TimeWindow, string> = {
  "90d": "past 90 days",
  "365d": "past year",
  all: "all-time",
};

const WINDOW_SHORT: Record<TimeWindow, string> = {
  "90d": "90d",
  "365d": "1y",
  all: "all-time",
};

/* ──────────── Per-opponent stats ──────────── */

export interface OppStats {
  pulseId: string;
  wins: number;
  losses: number;
  games: number;
  /** wins / (wins + losses). 0 when games=0. */
  winRate: number;
}

const ONE_DAY_MS = 86_400_000;

/**
 * Cutoff timestamp (ms since epoch) for a window. `null` means no lower
 * bound (all-time). Computed against the passed `now` so daily generates
 * are reproducible in tests.
 */
export function windowCutoff(window: TimeWindow, now: Date): number | null {
  if (window === "90d") return now.getTime() - 90 * ONE_DAY_MS;
  if (window === "365d") return now.getTime() - 365 * ONE_DAY_MS;
  return null;
}

/**
 * Group games by `oppPulseId`, counting only decided outcomes (W/L).
 * Games with no `oppPulseId` are dropped — without a stable id we
 * can't safely aggregate ("the same anonymous barcode" could span
 * many real accounts). `since` is an inclusive lower bound on the
 * game's `date`; `null` means include everything.
 */
export function groupByOpponent(
  games: ArcadeGame[],
  since: number | null,
): Map<string, OppStats> {
  const out = new Map<string, OppStats>();
  for (const g of games) {
    if (!g.oppPulseId) continue;
    const t = new Date(g.date).getTime();
    if (!Number.isFinite(t)) continue;
    if (since !== null && t < since) continue;
    const o = outcome(g);
    if (o === "U") continue;
    let row = out.get(g.oppPulseId);
    if (!row) {
      row = { pulseId: g.oppPulseId, wins: 0, losses: 0, games: 0, winRate: 0 };
      out.set(g.oppPulseId, row);
    }
    if (o === "W") row.wins += 1;
    else row.losses += 1;
    row.games = row.wins + row.losses;
    row.winRate = row.games > 0 ? row.wins / row.games : 0;
  }
  return out;
}

/**
 * Predicate for a single WR profile. "perfect" / "winless" require a
 * positive count on the dominant side (a single decided game is
 * enough); "dominant" / "struggle" require at least one game on the
 * minority side so they don't shadow perfect/winless.
 */
export function matchesProfile(s: OppStats, wr: WrProfile): boolean {
  if (wr === "perfect") return s.losses === 0 && s.wins > 0;
  if (wr === "winless") return s.wins === 0 && s.losses > 0;
  if (wr === "even") return s.wins === s.losses && s.games > 0;
  if (wr === "dominant") return s.winRate >= 0.7 && s.losses > 0;
  if (wr === "struggle") return s.winRate <= 0.3 && s.wins > 0;
  return false;
}

/** Pure filter — opponents that match the variant's profile and gate. */
export function matchingOpponents(
  stats: ReadonlyMap<string, OppStats>,
  variant: CensusVariant,
): OppStats[] {
  const out: OppStats[] = [];
  for (const s of stats.values()) {
    if (s.games < variant.minGames) continue;
    if (!matchesProfile(s, variant.wr)) continue;
    out.push(s);
  }
  return out;
}

/** Opponents that meet the minGames gate (the denominator in the prompt). */
export function qualifyingCount(
  stats: ReadonlyMap<string, OppStats>,
  variant: CensusVariant,
): number {
  let n = 0;
  for (const s of stats.values()) {
    if (s.games >= variant.minGames) n += 1;
  }
  return n;
}

/* ──────────── Variant rotation ──────────── */

/** Day-of-year (UTC) for a yyyy-mm-dd seed. */
export function dayOfYearUtc(daySeed: string): number {
  if (!daySeed) return 0;
  const t = new Date(`${daySeed}T00:00:00Z`).getTime();
  if (!Number.isFinite(t)) return 0;
  const start = new Date(`${daySeed.slice(0, 4)}-01-01T00:00:00Z`).getTime();
  return Math.floor((t - start) / ONE_DAY_MS);
}

/**
 * Order variants so the pinned head matches across devices for daily
 * content, with the remaining variants behind it in the rotation's
 * declared order so fallback is deterministic.
 */
export function variantOrderFor(input: {
  daySeed: string;
  rng: () => number;
}): CensusVariant[] {
  const all = VARIANT_ROTATION;
  const pinIdx = input.daySeed
    ? dayOfYearUtc(input.daySeed) % all.length
    : Math.floor(input.rng() * all.length);
  const head = all[pinIdx] ?? all[0];
  const tail = all.filter((_, i) => i !== pinIdx);
  return [head, ...tail];
}

/* ──────────── Question payload ──────────── */

interface MatchedOpponent {
  pulseId: string;
  /** Resolved display name when available (sc2pulse), else raw `name`. */
  displayName: string;
  wins: number;
  losses: number;
  games: number;
  winRate: number;
}

interface Q {
  variant: CensusVariant;
  buckets: ReadonlyArray<Bucket>;
  truth: Bucket;
  /** Exact count of matched opponents (before bucketing). */
  count: number;
  /** Opponents that meet the minGames gate in the window (denominator). */
  qualifying: number;
  /** Up to 6 matched opponents — sorted by game count, used in the reveal. */
  examples: MatchedOpponent[];
}

type A = Bucket;

/* ──────────── generate ──────────── */

/**
 * Permissive floor: at least this many decided games in the past year
 * before the quiz considers itself answerable. Below it, every variant
 * collapses to "0" and the quiz is boring.
 */
const YEAR_GAMES_FLOOR = 30;

async function generate(input: GenerateInput): Promise<GenerateResult<Q>> {
  // Cache group-by-opponent per window so we don't re-walk games for
  // each variant; the rotation can ask about up to three windows in
  // one pass on Quick Play fallback chains.
  const now = new Date();
  const statsCache = new Map<TimeWindow, Map<string, OppStats>>();
  const statsFor = (w: TimeWindow): Map<string, OppStats> => {
    const cached = statsCache.get(w);
    if (cached) return cached;
    const grouped = groupByOpponent(input.data.games, windowCutoff(w, now));
    statsCache.set(w, grouped);
    return grouped;
  };

  const yearStats = statsFor("365d");
  let yearTotal = 0;
  for (const s of yearStats.values()) yearTotal += s.games;
  if (yearTotal < YEAR_GAMES_FLOOR) {
    return {
      ok: false,
      reason: `Need ≥${YEAR_GAMES_FLOOR} decided games in the past year.`,
      cta: { label: "Play more games", href: "/" },
    };
  }

  const order = variantOrderFor({ daySeed: input.daySeed, rng: input.rng });
  const oppLookup = new Map(
    input.data.opponents.map((o) => [o.pulseId, o] as const),
  );

  for (const variant of order) {
    const stats = statsFor(variant.window);
    const qualifying = qualifyingCount(stats, variant);
    // Need at least one opponent meeting the minGames gate so the
    // question "of the N who qualify, how many are X?" is a real ask
    // rather than a trick question with a forced "0" answer.
    if (qualifying < 1) continue;
    const matches = matchingOpponents(stats, variant);
    return {
      ok: true,
      minDataMet: true,
      question: {
        variant,
        buckets: BUCKETS,
        truth: bucketize(matches.length),
        count: matches.length,
        qualifying,
        examples: buildExamples(matches, oppLookup),
      },
    };
  }
  return {
    ok: false,
    reason: "No qualifying opponents in any rotation window.",
  };
}

function displayNameOf(o: ArcadeOpponent | undefined): string {
  if (!o) return "(unknown)";
  const resolved = o.displayName?.trim();
  if (resolved) return resolved;
  return o.name || "(unknown)";
}

/** Sort matches by game count (heaviest rivalries first) for the reveal. */
function buildExamples(
  matches: OppStats[],
  oppLookup: ReadonlyMap<string, ArcadeOpponent>,
): MatchedOpponent[] {
  return matches
    .slice()
    .sort((a, b) => {
      if (b.games !== a.games) return b.games - a.games;
      const an = displayNameOf(oppLookup.get(a.pulseId));
      const bn = displayNameOf(oppLookup.get(b.pulseId));
      return an.localeCompare(bn);
    })
    .slice(0, 6)
    .map((s) => ({
      pulseId: s.pulseId,
      displayName: displayNameOf(oppLookup.get(s.pulseId)),
      wins: s.wins,
      losses: s.losses,
      games: s.games,
      winRate: s.winRate,
    }));
}

/* ──────────── score / share ──────────── */

function noteFor(q: Q): string {
  const v = q.variant;
  return `${q.count} opponent${q.count === 1 ? "" : "s"} of ${q.qualifying} who hit ≥${v.minGames} games ${WINDOW_LABEL[v.window]}.`;
}

function score(q: Q, a: A): ScoreResult {
  const correct = a === q.truth;
  return {
    raw: correct ? 1 : 0,
    xp: correct ? 12 : 0,
    outcome: correct ? "correct" : "wrong",
    note: noteFor(q),
  };
}

function questionPlain(q: Q): string {
  const v = q.variant;
  return `Over the ${WINDOW_LABEL[v.window]}, of the opponents you played at least ${v.minGames} times, how many do you have ${WR_LABEL[v.wr]} against?`;
}

function share(q: Q, _a: A | null, _s: ScoreResult): ShareSummary {
  const v = q.variant;
  const answer: string[] = [
    `${WR_SHORT[v.wr]} WR · ${WINDOW_SHORT[v.window]} · ≥${v.minGames}g → ${q.truth}`,
    noteFor(q),
  ];
  for (const e of q.examples) {
    answer.push(
      `${e.displayName} · ${e.wins}-${e.losses} (${pct1(e.winRate)})`,
    );
  }
  return { question: questionPlain(q), answer };
}

export const headToHeadCensus: Mode<Q, A> = {
  id: ID,
  kind: "quiz",
  category: "matchups",
  difficulty: "medium",
  ttp: "fast",
  depthTag: "conditional",
  title: "Head-to-Head Census",
  blurb:
    "How many of your rivals fit the win-rate profile? Pick the bucket — the rotation changes the WR band and window daily.",
  generate,
  score,
  share,
  render: (ctx) => <Render ctx={ctx} />,
};

/* ──────────── render ──────────── */

function promptFor(q: Q): ReactNode {
  const v = q.variant;
  return (
    <span>
      Over the <span className="font-semibold">{WINDOW_LABEL[v.window]}</span>,
      of the <span className="font-mono tabular-nums">{q.qualifying}</span>{" "}
      opponent{q.qualifying === 1 ? "" : "s"} you played at least{" "}
      <span className="font-mono tabular-nums">{v.minGames}</span> times, how
      many do you have a{" "}
      <span className="font-semibold text-warning">{WR_LABEL[v.wr]}</span>{" "}
      against?
    </span>
  );
}

function depthLabelFor(q: Q): string {
  const v = q.variant;
  return `${WINDOW_SHORT[v.window]} · ≥${v.minGames}g · ${WR_SHORT[v.wr]}`;
}

function Render({
  ctx,
}: {
  ctx: Parameters<Mode<Q, A>["render"]>[0];
}) {
  const [picked, setPicked] = useState<A | null>(null);
  const onPick = (b: A) => {
    if (ctx.revealed) return;
    setPicked(b);
    ctx.onAnswer(b);
  };
  const reveal = ctx.score ? (
    <Reveal q={ctx.question} score={ctx.score} />
  ) : null;
  return (
    <QuizCard
      icon={IconFor(ID)}
      title={headToHeadCensus.title}
      depthLabel={depthLabelFor(ctx.question)}
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
      <span className="font-semibold">Answer:</span>{" "}
      <span className="font-mono tabular-nums text-success">{q.truth}</span>{" "}
      <span className="text-text-dim">({q.count} exact)</span>{" "}
      {score.outcome === "correct" ? (
        <span className="text-success">— right bucket.</span>
      ) : (
        <span className="text-warning">— bracket was {q.truth}.</span>
      )}
    </p>
  );
  return (
    <div className="space-y-2 text-caption text-text">
      {headline}
      <p className="text-text-muted">{noteFor(q)}</p>
      {q.examples.length > 0 ? (
        <ul className="space-y-1" aria-label="Matching opponents">
          {q.examples.map((e) => (
            <li
              key={e.pulseId}
              className="flex items-center justify-between gap-2 rounded border border-border bg-bg-surface px-2 py-1"
            >
              <span className="truncate text-text">{e.displayName}</span>
              <span className="font-mono tabular-nums text-text-dim">
                {e.wins}-{e.losses} ({pct1(e.winRate)})
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-text-dim">No opponents matched this profile.</p>
      )}
    </div>
  );
}
