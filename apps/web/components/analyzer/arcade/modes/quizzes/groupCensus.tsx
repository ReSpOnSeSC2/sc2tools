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
 * Group Census — "of the [opponents | maps | builds] you played at least
 * N times in window W, how many do you hold WR-profile P against?"
 *
 * This is the merged successor to the separate Head-to-Head Census and
 * Map Mastery Census quizzes. Folding both into a single mode lets us
 * cycle a richer rotation (3 group kinds × WR profile × window × min-
 * games) without dilluting the daily picker with two near-identical
 * tiles. A third group kind — Build Mastery — was added at the same
 * time, drawing on game-level `myBuild` to ask the same census question
 * about the user's build orders.
 *
 * Pure modules:
 *   • groupGames()      walks the games array once per (kind, window) key.
 *   • matchingGroups()  applies the WR-profile predicate.
 *   • bucketize()       collapses an exact count to a 4-bucket pick.
 * Render is a single React component that drives the QuizCard shell.
 */

const ID = "group-census";
registerMode(ID, "conditional");

/* ──────────── Variant model ──────────── */

export type GroupKind = "opponent" | "map" | "build";

export type WrProfile =
  | "perfect"
  | "winless"
  | "even"
  | "dominant"
  | "struggle";

export type TimeWindow = "90d" | "365d" | "all";
export type MinGames = 5 | 10 | 20;

export interface CensusVariant {
  kind: GroupKind;
  wr: WrProfile;
  window: TimeWindow;
  minGames: MinGames;
}

export function variantKey(v: CensusVariant): string {
  return `${v.kind}:${v.wr}:${v.window}:${v.minGames}`;
}

/**
 * Curated rotation. Order matters — it drives the day-of-year pin so
 * two devices on the same date see the same prompt. The list cycles
 * (opponent | map | build) × (perfect | winless | even | dominant |
 * struggle) × (90d | 365d | all) × (5 | 10 | 20) — but only those
 * combinations that stay meaningful on a typical ladder grinder's
 * data. "even on 20 games" pairs with the longer windows; "perfect on
 * 20 games" is rare so the perfect/winless variants pair with smaller
 * gates; the build kind skips "winless" (a build you've gone 0-5+ on is
 * usually shelved before it gets there, so the slot collapses to "0").
 */
export const VARIANT_ROTATION: ReadonlyArray<CensusVariant> = [
  { kind: "opponent", wr: "perfect", window: "365d", minGames: 5 },
  { kind: "map", wr: "perfect", window: "365d", minGames: 5 },
  { kind: "build", wr: "perfect", window: "365d", minGames: 5 },
  { kind: "opponent", wr: "winless", window: "365d", minGames: 5 },
  { kind: "map", wr: "winless", window: "365d", minGames: 5 },
  { kind: "opponent", wr: "perfect", window: "365d", minGames: 10 },
  { kind: "map", wr: "dominant", window: "365d", minGames: 10 },
  { kind: "build", wr: "dominant", window: "365d", minGames: 10 },
  { kind: "opponent", wr: "winless", window: "365d", minGames: 10 },
  { kind: "opponent", wr: "even", window: "365d", minGames: 10 },
  { kind: "map", wr: "even", window: "365d", minGames: 10 },
  { kind: "opponent", wr: "dominant", window: "365d", minGames: 10 },
  { kind: "opponent", wr: "struggle", window: "365d", minGames: 10 },
  { kind: "build", wr: "struggle", window: "365d", minGames: 5 },
  { kind: "opponent", wr: "even", window: "365d", minGames: 20 },
  { kind: "opponent", wr: "perfect", window: "90d", minGames: 5 },
  { kind: "map", wr: "dominant", window: "90d", minGames: 5 },
  { kind: "build", wr: "dominant", window: "90d", minGames: 5 },
  { kind: "opponent", wr: "winless", window: "90d", minGames: 5 },
  { kind: "opponent", wr: "perfect", window: "all", minGames: 10 },
  { kind: "map", wr: "perfect", window: "all", minGames: 10 },
  { kind: "build", wr: "perfect", window: "all", minGames: 10 },
  { kind: "opponent", wr: "dominant", window: "all", minGames: 20 },
  { kind: "map", wr: "dominant", window: "all", minGames: 20 },
];

export const BUCKETS = ["0", "1-2", "3-5", "6+"] as const;
export type Bucket = (typeof BUCKETS)[number];

export function bucketize(n: number): Bucket {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n <= 2) return "1-2";
  if (n <= 5) return "3-5";
  return "6+";
}

/* ──────────── Kind-aware labels ──────────── */

interface KindCopy {
  /** Plural noun used in the prompt: "opponents", "maps", "builds". */
  pluralNoun: string;
  /** Singular noun: "opponent", "map", "build". */
  singularNoun: string;
  /** "play"-verb phrasing: "you played", "you played on", "you played with". */
  playedVerb: string;
  /** Trailing preposition matching the WR-on-vs-against grammar. */
  prep: string;
  /** Reveal-list aria-label for screen readers. */
  matchedLabel: string;
}

const KIND_COPY: Record<GroupKind, KindCopy> = {
  opponent: {
    pluralNoun: "opponents",
    singularNoun: "opponent",
    playedVerb: "you played",
    prep: "against",
    matchedLabel: "Matching opponents",
  },
  map: {
    pluralNoun: "maps",
    singularNoun: "map",
    playedVerb: "you played on",
    prep: "on",
    matchedLabel: "Matching maps",
  },
  build: {
    pluralNoun: "builds",
    singularNoun: "build",
    playedVerb: "you played with",
    prep: "with",
    matchedLabel: "Matching builds",
  },
};

const WR_FULL: Record<WrProfile, string> = {
  perfect: "100% WR (never lost)",
  winless: "0% WR (never won)",
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

const KIND_SHORT: Record<GroupKind, string> = {
  opponent: "opp",
  map: "map",
  build: "build",
};

/* ──────────── Per-group stats ──────────── */

export interface GroupStats {
  /** Stable key — pulse id, map name, or build name. */
  key: string;
  /** Human-readable label for the reveal pane. */
  displayName: string;
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
 * Walk games once and bucket each into a group keyed by `kind`. Skips
 * undecided outcomes, missing/invalid dates, and games whose required
 * field for the kind is absent (no `oppPulseId`, no `map`, no `myBuild`).
 *
 * `since` is an inclusive lower bound on the game's `date`; `null` means
 * include everything.
 *
 * `opponents` is needed only for the "opponent" kind so we can lift the
 * sc2pulse `displayName` (preferred over the raw `name`); maps + builds
 * use the field value itself as the display name.
 */
export function groupGames(
  kind: GroupKind,
  games: ArcadeGame[],
  since: number | null,
  opponents: ReadonlyArray<ArcadeOpponent>,
): Map<string, GroupStats> {
  const oppLookup =
    kind === "opponent"
      ? new Map(opponents.map((o) => [o.pulseId, o] as const))
      : null;
  const out = new Map<string, GroupStats>();
  for (const g of games) {
    const key = keyFor(kind, g);
    if (!key) continue;
    const t = new Date(g.date).getTime();
    if (!Number.isFinite(t)) continue;
    if (since !== null && t < since) continue;
    const o = outcome(g);
    if (o === "U") continue;
    let row = out.get(key);
    if (!row) {
      row = {
        key,
        displayName: displayNameFor(kind, key, oppLookup),
        wins: 0,
        losses: 0,
        games: 0,
        winRate: 0,
      };
      out.set(key, row);
    }
    if (o === "W") row.wins += 1;
    else row.losses += 1;
    row.games = row.wins + row.losses;
    row.winRate = row.games > 0 ? row.wins / row.games : 0;
  }
  return out;
}

function keyFor(kind: GroupKind, g: ArcadeGame): string | null {
  if (kind === "opponent") return g.oppPulseId || null;
  if (kind === "map") {
    const m = typeof g.map === "string" ? g.map.trim() : "";
    return m || null;
  }
  // build
  const b = typeof g.myBuild === "string" ? g.myBuild.trim() : "";
  return b || null;
}

function displayNameFor(
  kind: GroupKind,
  key: string,
  oppLookup: ReadonlyMap<string, ArcadeOpponent> | null,
): string {
  if (kind === "opponent" && oppLookup) {
    const o = oppLookup.get(key);
    if (o) {
      const resolved = o.displayName?.trim();
      if (resolved) return resolved;
      if (o.name) return o.name;
    }
    return "(unknown)";
  }
  return key;
}

/**
 * Predicate for a single WR profile. "perfect" / "winless" require a
 * positive count on the dominant side (a single decided game is
 * enough); "dominant" / "struggle" require at least one game on the
 * minority side so they don't shadow perfect/winless.
 */
export function matchesProfile(s: GroupStats, wr: WrProfile): boolean {
  if (wr === "perfect") return s.losses === 0 && s.wins > 0;
  if (wr === "winless") return s.wins === 0 && s.losses > 0;
  if (wr === "even") return s.wins === s.losses && s.games > 0;
  if (wr === "dominant") return s.winRate >= 0.7 && s.losses > 0;
  if (wr === "struggle") return s.winRate <= 0.3 && s.wins > 0;
  return false;
}

/** Pure filter — groups that match the variant's profile and gate. */
export function matchingGroups(
  stats: ReadonlyMap<string, GroupStats>,
  variant: CensusVariant,
): GroupStats[] {
  const out: GroupStats[] = [];
  for (const s of stats.values()) {
    if (s.games < variant.minGames) continue;
    if (!matchesProfile(s, variant.wr)) continue;
    out.push(s);
  }
  return out;
}

/** Groups that meet the minGames gate (the denominator in the prompt). */
export function qualifyingCount(
  stats: ReadonlyMap<string, GroupStats>,
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

interface MatchedGroup {
  key: string;
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
  /** Exact count of matched groups (before bucketing). */
  count: number;
  /** Groups that meet the minGames gate in the window (denominator). */
  qualifying: number;
  /** Up to 6 matched groups — sorted by game count, used in the reveal. */
  examples: MatchedGroup[];
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
  // Cache group-by-(kind, window) so we don't re-walk games for each
  // variant; the rotation can ask about up to three windows × three
  // kinds in one pass on Quick Play fallback chains.
  const now = new Date();
  const cache = new Map<string, Map<string, GroupStats>>();
  const statsFor = (
    kind: GroupKind,
    w: TimeWindow,
  ): Map<string, GroupStats> => {
    const ck = `${kind}:${w}`;
    const hit = cache.get(ck);
    if (hit) return hit;
    const grouped = groupGames(
      kind,
      input.data.games,
      windowCutoff(w, now),
      input.data.opponents,
    );
    cache.set(ck, grouped);
    return grouped;
  };

  // Floor measured on opponent games over the past year — same series
  // the original head-to-head census gated on. This also implicitly
  // covers maps + builds: if a user has 30+ year games they almost
  // always have map data, and any build data depends on whether the
  // analyser captured `myBuild` for them at all.
  const yearStats = statsFor("opponent", "365d");
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
  for (const variant of order) {
    const stats = statsFor(variant.kind, variant.window);
    const qualifying = qualifyingCount(stats, variant);
    // Need at least one group meeting the minGames gate so the
    // question "of the N who qualify, how many are X?" is a real ask
    // rather than a trick question with a forced "0" answer.
    if (qualifying < 1) continue;
    const matches = matchingGroups(stats, variant);
    return {
      ok: true,
      minDataMet: true,
      question: {
        variant,
        buckets: BUCKETS,
        truth: bucketize(matches.length),
        count: matches.length,
        qualifying,
        examples: buildExamples(matches),
      },
    };
  }
  return {
    ok: false,
    reason: "No qualifying groups in any rotation window.",
  };
}

/** Sort matches by game count (heaviest first) for the reveal. */
function buildExamples(matches: GroupStats[]): MatchedGroup[] {
  return matches
    .slice()
    .sort((a, b) => {
      if (b.games !== a.games) return b.games - a.games;
      return a.displayName.localeCompare(b.displayName);
    })
    .slice(0, 6)
    .map((s) => ({
      key: s.key,
      displayName: s.displayName,
      wins: s.wins,
      losses: s.losses,
      games: s.games,
      winRate: s.winRate,
    }));
}

/* ──────────── score / share ──────────── */

function noteFor(q: Q): string {
  const v = q.variant;
  const noun =
    q.count === 1
      ? KIND_COPY[v.kind].singularNoun
      : KIND_COPY[v.kind].pluralNoun;
  return `${q.count} ${noun} of ${q.qualifying} that hit ≥${v.minGames} games ${WINDOW_LABEL[v.window]}.`;
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
  const c = KIND_COPY[v.kind];
  return `Over the ${WINDOW_LABEL[v.window]}, of the ${c.pluralNoun} ${c.playedVerb} at least ${v.minGames} times, how many do you have ${WR_FULL[v.wr]} ${c.prep}?`;
}

function share(q: Q, _a: A | null, _s: ScoreResult): ShareSummary {
  const v = q.variant;
  const answer: string[] = [
    `${KIND_SHORT[v.kind]} · ${WR_SHORT[v.wr]} WR · ${WINDOW_SHORT[v.window]} · ≥${v.minGames}g → ${q.truth}`,
    noteFor(q),
  ];
  for (const e of q.examples) {
    answer.push(
      `${e.displayName} · ${e.wins}-${e.losses} (${pct1(e.winRate)})`,
    );
  }
  return { question: questionPlain(q), answer };
}

export const groupCensus: Mode<Q, A> = {
  id: ID,
  kind: "quiz",
  category: "matchups",
  difficulty: "medium",
  ttp: "fast",
  depthTag: "conditional",
  title: "Group Census",
  blurb:
    "How many of your opponents, maps, or builds fit the WR profile? Pick the bucket — the rotation changes the group, window, and band daily.",
  generate,
  score,
  share,
  render: (ctx) => <Render ctx={ctx} />,
};

/* ──────────── render ──────────── */

function promptFor(q: Q): ReactNode {
  const v = q.variant;
  const c = KIND_COPY[v.kind];
  const noun =
    q.qualifying === 1 ? c.singularNoun : c.pluralNoun;
  return (
    <span>
      Over the <span className="font-semibold">{WINDOW_LABEL[v.window]}</span>,
      of the <span className="font-mono tabular-nums">{q.qualifying}</span>{" "}
      {noun} {c.playedVerb} at least{" "}
      <span className="font-mono tabular-nums">{v.minGames}</span> times, how
      many do you have a{" "}
      <span className="font-semibold text-warning">{WR_FULL[v.wr]}</span>{" "}
      {c.prep}?
    </span>
  );
}

function depthLabelFor(q: Q): string {
  const v = q.variant;
  return `${KIND_SHORT[v.kind]} · ${WINDOW_SHORT[v.window]} · ≥${v.minGames}g · ${WR_SHORT[v.wr]}`;
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
      title={groupCensus.title}
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
  const c = KIND_COPY[q.variant.kind];
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
        <ul className="space-y-1" aria-label={c.matchedLabel}>
          {q.examples.map((e) => (
            <li
              key={e.key}
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
        <p className="text-text-dim">No {c.pluralNoun} matched this profile.</p>
      )}
    </div>
  );
}

/** Exposed for unit tests that exercise the example sort order. */
export { buildExamples };
