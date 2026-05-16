"use client";

import { useState, type ReactNode } from "react";
import { pct1 } from "@/lib/format";
import { QuizAnswerButton, QuizCard } from "../../shells/QuizCard";
import { IconFor } from "../../icons";
import { outcome, registerMode } from "../../ArcadeEngine";
import type {
  ArcadeGame,
  GenerateInput,
  GenerateResult,
  Mode,
  ScoreResult,
  ShareSummary,
} from "../../types";

/**
 * Map Mastery Census — same census pattern as Head-to-Head, but applied
 * to maps. "Of the maps you've played at least N times in window W,
 * how many do you have win-rate profile P on?"
 *
 * Six variants cycle the (WR profile × time window × min-games) axes.
 * The data path mirrors HeadToHead's: walk games once per window,
 * group by `map`, predicate each map, collapse the count to a 4-bucket
 * pick. Skips games with no resolved `map` field.
 */

const ID = "map-mastery-census";
registerMode(ID, "conditional");

/* ──────────── Variant model ──────────── */

export type MapWrProfile = "perfect" | "winless" | "even" | "dominant";
export type MapWindow = "90d" | "365d" | "all";
export type MapMinGames = 5 | 10 | 20;

export interface MapVariant {
  wr: MapWrProfile;
  window: MapWindow;
  minGames: MapMinGames;
}

export function mapVariantKey(v: MapVariant): string {
  return `${v.wr}:${v.window}:${v.minGames}`;
}

export const MAP_VARIANT_ROTATION: ReadonlyArray<MapVariant> = [
  { wr: "perfect", window: "365d", minGames: 5 },
  { wr: "dominant", window: "365d", minGames: 10 },
  { wr: "winless", window: "365d", minGames: 5 },
  { wr: "even", window: "365d", minGames: 10 },
  { wr: "perfect", window: "all", minGames: 10 },
  { wr: "dominant", window: "all", minGames: 20 },
];

export const MAP_BUCKETS = ["0", "1-2", "3-5", "6+"] as const;
export type MapBucket = (typeof MAP_BUCKETS)[number];

export function mapBucketize(n: number): MapBucket {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n <= 2) return "1-2";
  if (n <= 5) return "3-5";
  return "6+";
}

const WR_LABEL: Record<MapWrProfile, string> = {
  perfect: "100% WR (never lost on it)",
  winless: "0% WR (never won on it)",
  even: "exactly 50% WR",
  dominant: "≥70% WR (without being perfect)",
};

const WR_SHORT: Record<MapWrProfile, string> = {
  perfect: "100%",
  winless: "0%",
  even: "50%",
  dominant: "≥70%",
};

const WINDOW_LABEL: Record<MapWindow, string> = {
  "90d": "past 90 days",
  "365d": "past year",
  all: "all-time",
};

const WINDOW_SHORT: Record<MapWindow, string> = {
  "90d": "90d",
  "365d": "1y",
  all: "all-time",
};

/* ──────────── Per-map stats ──────────── */

export interface MapStats {
  map: string;
  wins: number;
  losses: number;
  games: number;
  winRate: number;
}

const ONE_DAY_MS = 86_400_000;

export function mapWindowCutoff(window: MapWindow, now: Date): number | null {
  if (window === "90d") return now.getTime() - 90 * ONE_DAY_MS;
  if (window === "365d") return now.getTime() - 365 * ONE_DAY_MS;
  return null;
}

/**
 * Group games by `map`. Skips games with no `map` (legacy/unparsed
 * replays) and undecided outcomes. `since` is an inclusive ms lower
 * bound; `null` means include everything.
 */
export function groupByMap(
  games: ArcadeGame[],
  since: number | null,
): Map<string, MapStats> {
  const out = new Map<string, MapStats>();
  for (const g of games) {
    const m = typeof g.map === "string" ? g.map.trim() : "";
    if (!m) continue;
    const t = new Date(g.date).getTime();
    if (!Number.isFinite(t)) continue;
    if (since !== null && t < since) continue;
    const o = outcome(g);
    if (o === "U") continue;
    let row = out.get(m);
    if (!row) {
      row = { map: m, wins: 0, losses: 0, games: 0, winRate: 0 };
      out.set(m, row);
    }
    if (o === "W") row.wins += 1;
    else row.losses += 1;
    row.games = row.wins + row.losses;
    row.winRate = row.games > 0 ? row.wins / row.games : 0;
  }
  return out;
}

export function matchesMapProfile(s: MapStats, wr: MapWrProfile): boolean {
  if (wr === "perfect") return s.losses === 0 && s.wins > 0;
  if (wr === "winless") return s.wins === 0 && s.losses > 0;
  if (wr === "even") return s.wins === s.losses && s.games > 0;
  if (wr === "dominant") return s.winRate >= 0.7 && s.losses > 0;
  return false;
}

export function matchingMaps(
  stats: ReadonlyMap<string, MapStats>,
  variant: MapVariant,
): MapStats[] {
  const out: MapStats[] = [];
  for (const s of stats.values()) {
    if (s.games < variant.minGames) continue;
    if (!matchesMapProfile(s, variant.wr)) continue;
    out.push(s);
  }
  return out;
}

export function qualifyingMapCount(
  stats: ReadonlyMap<string, MapStats>,
  variant: MapVariant,
): number {
  let n = 0;
  for (const s of stats.values()) {
    if (s.games >= variant.minGames) n += 1;
  }
  return n;
}

/* ──────────── Variant rotation ──────────── */

function dayOfYearUtc(daySeed: string): number {
  if (!daySeed) return 0;
  const t = new Date(`${daySeed}T00:00:00Z`).getTime();
  if (!Number.isFinite(t)) return 0;
  const start = new Date(`${daySeed.slice(0, 4)}-01-01T00:00:00Z`).getTime();
  return Math.floor((t - start) / ONE_DAY_MS);
}

export function mapVariantOrderFor(input: {
  daySeed: string;
  rng: () => number;
}): MapVariant[] {
  const all = MAP_VARIANT_ROTATION;
  const pinIdx = input.daySeed
    ? dayOfYearUtc(input.daySeed) % all.length
    : Math.floor(input.rng() * all.length);
  const head = all[pinIdx] ?? all[0];
  const tail = all.filter((_, i) => i !== pinIdx);
  return [head, ...tail];
}

/* ──────────── Question payload ──────────── */

interface MatchedMap {
  map: string;
  wins: number;
  losses: number;
  games: number;
  winRate: number;
}

interface Q {
  variant: MapVariant;
  buckets: ReadonlyArray<MapBucket>;
  truth: MapBucket;
  count: number;
  qualifying: number;
  examples: MatchedMap[];
}

type A = MapBucket;

/* ──────────── generate ──────────── */

const YEAR_GAMES_FLOOR = 30;

async function generate(input: GenerateInput): Promise<GenerateResult<Q>> {
  const now = new Date();
  const statsCache = new Map<MapWindow, Map<string, MapStats>>();
  const statsFor = (w: MapWindow): Map<string, MapStats> => {
    const cached = statsCache.get(w);
    if (cached) return cached;
    const grouped = groupByMap(input.data.games, mapWindowCutoff(w, now));
    statsCache.set(w, grouped);
    return grouped;
  };

  const yearStats = statsFor("365d");
  let yearTotal = 0;
  for (const s of yearStats.values()) yearTotal += s.games;
  if (yearTotal < YEAR_GAMES_FLOOR) {
    return {
      ok: false,
      reason: `Need ≥${YEAR_GAMES_FLOOR} decided games on tracked maps in the past year.`,
      cta: { label: "Play more games", href: "/" },
    };
  }

  const order = mapVariantOrderFor({ daySeed: input.daySeed, rng: input.rng });
  for (const variant of order) {
    const stats = statsFor(variant.window);
    const qualifying = qualifyingMapCount(stats, variant);
    if (qualifying < 1) continue;
    const matches = matchingMaps(stats, variant);
    return {
      ok: true,
      minDataMet: true,
      question: {
        variant,
        buckets: MAP_BUCKETS,
        truth: mapBucketize(matches.length),
        count: matches.length,
        qualifying,
        examples: buildMapExamples(matches),
      },
    };
  }
  return {
    ok: false,
    reason: "No qualifying maps in any rotation window.",
  };
}

function buildMapExamples(matches: MapStats[]): MatchedMap[] {
  return matches
    .slice()
    .sort((a, b) => {
      if (b.games !== a.games) return b.games - a.games;
      return a.map.localeCompare(b.map);
    })
    .slice(0, 6)
    .map((s) => ({
      map: s.map,
      wins: s.wins,
      losses: s.losses,
      games: s.games,
      winRate: s.winRate,
    }));
}

/* ──────────── score / share ──────────── */

function noteFor(q: Q): string {
  const v = q.variant;
  return `${q.count} map${q.count === 1 ? "" : "s"} of ${q.qualifying} that hit ≥${v.minGames} games ${WINDOW_LABEL[v.window]}.`;
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
  return `Over the ${WINDOW_LABEL[v.window]}, of the maps you played at least ${v.minGames} times, how many do you have ${WR_LABEL[v.wr]} on?`;
}

function share(q: Q, _a: A | null, _s: ScoreResult): ShareSummary {
  const v = q.variant;
  const answer: string[] = [
    `${WR_SHORT[v.wr]} WR · ${WINDOW_SHORT[v.window]} · ≥${v.minGames}g → ${q.truth}`,
    noteFor(q),
  ];
  for (const e of q.examples) {
    answer.push(`${e.map} · ${e.wins}-${e.losses} (${pct1(e.winRate)})`);
  }
  return { question: questionPlain(q), answer };
}

export const mapMasteryCensus: Mode<Q, A> = {
  id: ID,
  kind: "quiz",
  category: "matchups",
  difficulty: "medium",
  ttp: "fast",
  depthTag: "conditional",
  title: "Map Mastery Census",
  blurb:
    "How many of your maps fit the win-rate profile? Pick the bucket — the rotation changes the WR band and window daily.",
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
      of the <span className="font-mono tabular-nums">{q.qualifying}</span> map
      {q.qualifying === 1 ? "" : "s"} you played at least{" "}
      <span className="font-mono tabular-nums">{v.minGames}</span> times, how
      many do you have a{" "}
      <span className="font-semibold text-warning">{WR_LABEL[v.wr]}</span>{" "}
      on?
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
      title={mapMasteryCensus.title}
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
        <ul className="space-y-1" aria-label="Matching maps">
          {q.examples.map((e) => (
            <li
              key={e.map}
              className="flex items-center justify-between gap-2 rounded border border-border bg-bg-surface px-2 py-1"
            >
              <span className="truncate text-text">{e.map}</span>
              <span className="font-mono tabular-nums text-text-dim">
                {e.wins}-{e.losses} ({pct1(e.winRate)})
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-text-dim">No maps matched this profile.</p>
      )}
    </div>
  );
}
