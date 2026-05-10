"use client";

import { useEffect, useMemo, useState } from "react";
import { GameStage } from "../../shells/GameStage";
import { IconFor } from "../../icons";
import { registerMode } from "../../ArcadeEngine";
import { useArcadeState } from "../../hooks/useArcadeState";
import type {
  BuildleProgress,
  GenerateInput,
  GenerateResult,
  Mode,
  ScoreResult,
} from "../../types";

const ID = "buildle";
registerMode(ID, "generative");

export type BuildleAxis = "race" | "techPath" | "openingUnit" | "firstAggression";

export type BuildleClueState = "match" | "near" | "miss";

export type BuildleClue = {
  axis: BuildleAxis;
  guessVal: string;
  truthVal: string;
  state: BuildleClueState;
};

type Q = {
  buildName: string;
  candidates: string[];
  features: BuildleFeatures;
  /** UI label for each axis. */
  axisLabels: Record<BuildleAxis, string>;
};

type A = string;

const MAX_GUESSES = 6;

export interface BuildleFeatures {
  race: string;
  techPath: "mech" | "bio" | "air" | "ground" | "hybrid";
  openingUnit: string;
  firstAggression: "<4 min" | "4–6 min" | "6–9 min" | "9+ min";
}

/* ──────────── feature derivation (pure) ──────────── */

const TECH_BUCKETS: Array<{ keyword: RegExp; bucket: BuildleFeatures["techPath"] }> = [
  { keyword: /\b(mech|tank|cyclone|hellbat|thor|battlecruiser)\b/i, bucket: "mech" },
  { keyword: /\b(bio|marine|marauder|ghost|stim)\b/i, bucket: "bio" },
  { keyword: /(\bair\b|sky|\bcarrier\b|carriers|tempest|broodlord|mutalisk|banshee|\bbc\b)/i, bucket: "air" },
  { keyword: /\b(roach|ling|zerg ground|zealot|stalker|immortal|hellion)\b/i, bucket: "ground" },
];

export function deriveTechPath(name: string, race?: string): BuildleFeatures["techPath"] {
  for (const t of TECH_BUCKETS) {
    if (t.keyword.test(name)) return t.bucket;
  }
  if (race === "Z") return "ground";
  if (race === "T") return "bio";
  if (race === "P") return "ground";
  return "hybrid";
}

/** Role buckets — adjacency for the "near" clue state on openingUnit. */
export type OpeningRole = "light" | "armored" | "caster";

const OPENING_KEYWORDS: Array<{ re: RegExp; unit: string; race: "T" | "Z" | "P"; role: OpeningRole }> = [
  { re: /reaper/i, unit: "Reaper", race: "T", role: "light" },
  { re: /hellion/i, unit: "Hellion", race: "T", role: "light" },
  { re: /marine/i, unit: "Marine", race: "T", role: "light" },
  { re: /marauder/i, unit: "Marauder", race: "T", role: "armored" },
  { re: /banshee/i, unit: "Banshee", race: "T", role: "armored" },
  { re: /widow|mine/i, unit: "Widow Mine", race: "T", role: "armored" },
  { re: /zergling|ling/i, unit: "Zergling", race: "Z", role: "light" },
  { re: /roach/i, unit: "Roach", race: "Z", role: "armored" },
  { re: /baneling/i, unit: "Baneling", race: "Z", role: "light" },
  { re: /mutalisk|muta/i, unit: "Mutalisk", race: "Z", role: "armored" },
  { re: /hydralisk|hydra/i, unit: "Hydralisk", race: "Z", role: "armored" },
  { re: /zealot/i, unit: "Zealot", race: "P", role: "light" },
  { re: /stalker/i, unit: "Stalker", race: "P", role: "armored" },
  { re: /adept/i, unit: "Adept", race: "P", role: "light" },
  { re: /void ?ray/i, unit: "Void Ray", race: "P", role: "armored" },
  { re: /oracle/i, unit: "Oracle", race: "P", role: "caster" },
];

/** Lookup unit → { race, role }. Used by "near" semantics on openingUnit. */
export function openingMeta(unit: string): { race: "T" | "Z" | "P"; role: OpeningRole } | null {
  for (const k of OPENING_KEYWORDS) {
    if (k.unit === unit) return { race: k.race, role: k.role };
  }
  return null;
}

export function deriveOpeningUnit(name: string, race?: string): string {
  for (const k of OPENING_KEYWORDS) if (k.re.test(name)) return k.unit;
  if (race === "Z") return "Zergling";
  if (race === "T") return "Marine";
  if (race === "P") return "Zealot";
  return "Worker";
}

export function deriveFirstAggression(name: string): BuildleFeatures["firstAggression"] {
  // Two-base timings ARE all-ins, but they hit at 4–6 min — checked
  // first so the broader cheese pattern doesn't claim them.
  if (/(\b2[-\s]?base|\btwo[-\s]?base|\btiming|\bdrop\b)/i.test(name)) return "4–6 min";
  if (/\b(rush|cheese|all[- ]?in|allin|proxy|cannon rush)\b/i.test(name)) return "<4 min";
  if (/\b(macro|fast expand|three[-\s]?base|3[-\s]?base)\b/i.test(name)) return "9+ min";
  return "6–9 min";
}

export function deriveFeatures(name: string, race?: string): BuildleFeatures {
  return {
    race: (race || "?").charAt(0).toUpperCase(),
    techPath: deriveTechPath(name, race?.charAt(0).toUpperCase()),
    openingUnit: deriveOpeningUnit(name, race?.charAt(0).toUpperCase()),
    firstAggression: deriveFirstAggression(name),
  };
}

/**
 * Tech-path adjacency. Builds in the same family count as "near" even
 * when they differ. Pairs (a, b) appear unordered — checked both ways.
 */
const TECH_ADJACENCY: ReadonlyArray<readonly [BuildleFeatures["techPath"], BuildleFeatures["techPath"]]> = [
  ["mech", "ground"],
  ["bio", "ground"],
  ["air", "hybrid"],
];

function techsAreAdjacent(
  a: BuildleFeatures["techPath"],
  b: BuildleFeatures["techPath"],
): boolean {
  for (const [x, y] of TECH_ADJACENCY) {
    if ((a === x && b === y) || (a === y && b === x)) return true;
  }
  return false;
}

/**
 * First-aggression timing adjacency. Adjacent windows are "near"
 * (a 5-minute timing guess vs a 4-minute truth still landed close).
 */
const TIMING_ORDER: ReadonlyArray<BuildleFeatures["firstAggression"]> = [
  "<4 min",
  "4–6 min",
  "6–9 min",
  "9+ min",
];

function timingsAreAdjacent(
  a: BuildleFeatures["firstAggression"],
  b: BuildleFeatures["firstAggression"],
): boolean {
  const i = TIMING_ORDER.indexOf(a);
  const j = TIMING_ORDER.indexOf(b);
  if (i < 0 || j < 0) return false;
  return Math.abs(i - j) === 1;
}

/**
 * Score a single axis. "match" if identical; "near" if same family
 * (tech), same race + role bucket (opening unit), or adjacent timing
 * (first aggression); "miss" otherwise. Race never goes near.
 */
export function clueFor(
  axis: BuildleAxis,
  guess: BuildleFeatures,
  truth: BuildleFeatures,
): BuildleClue {
  const guessVal = String(guess[axis]);
  const truthVal = String(truth[axis]);
  if (guessVal === truthVal) {
    return { axis, guessVal, truthVal, state: "match" };
  }
  let state: BuildleClueState = "miss";
  if (axis === "techPath") {
    if (techsAreAdjacent(guess.techPath, truth.techPath)) state = "near";
  } else if (axis === "firstAggression") {
    if (timingsAreAdjacent(guess.firstAggression, truth.firstAggression)) state = "near";
  } else if (axis === "openingUnit") {
    const a = openingMeta(guess.openingUnit);
    const b = openingMeta(truth.openingUnit);
    if (a && b && a.race === b.race && a.role === b.role) state = "near";
  }
  return { axis, guessVal, truthVal, state };
}

/* ──────────── generator + render ──────────── */

async function generate(input: GenerateInput): Promise<GenerateResult<Q>> {
  const eligible = input.data.builds.filter((b) => b.total >= 3);
  if (eligible.length < 4) {
    return {
      ok: false,
      reason: "Need ≥4 builds with at least 3 plays to play Buildle.",
    };
  }
  // Deterministic pick: most-played builds, ranked, then chosen by daily seed.
  const sorted = eligible
    .slice()
    .sort((a, b) => b.total - a.total)
    .slice(0, Math.min(eligible.length, 12));
  const idx = Math.floor(input.rng() * sorted.length);
  const pick = sorted[idx];
  const candidates = sorted.map((b) => b.name);
  const features = deriveFeatures(pick.name, pick.race);
  return {
    ok: true,
    minDataMet: true,
    question: {
      buildName: pick.name,
      candidates,
      features,
      axisLabels: {
        race: "Race",
        techPath: "Tech path",
        openingUnit: "Opening unit",
        firstAggression: "First aggression",
      },
    },
  };
}

function score(q: Q, a: A): ScoreResult {
  const correct = a === q.buildName;
  return {
    raw: correct ? 1 : 0,
    xp: correct ? 18 : 0,
    outcome: correct ? "correct" : "wrong",
  };
}

export const buildle: Mode<Q, A> = {
  id: ID,
  kind: "game",
  category: "builds",
  difficulty: "medium",
  ttp: "fast",
  depthTag: "generative",
  title: "Buildle",
  blurb: "Daily build of the day. Six guesses, four-axis clues, share like Wordle.",
  generate,
  score,
  render: (ctx) => <Render ctx={ctx} />,
};

function Render({
  ctx,
}: {
  ctx: Parameters<Mode<Q, A>["render"]>[0];
}) {
  const { state, update } = useArcadeState();
  const dayKey = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const stored: BuildleProgress | undefined = state.buildleByDay[dayKey];
  const guesses = stored?.guesses ?? [];
  const solved = stored?.solved ?? false;

  const [pick, setPick] = useState<string>("");

  useEffect(() => {
    if (!stored) {
      update((prev) => ({
        ...prev,
        buildleByDay: {
          ...prev.buildleByDay,
          [dayKey]: { buildName: ctx.question.buildName, guesses: [], solved: false },
        },
      }));
    }
  }, [stored, ctx.question.buildName, dayKey, update]);

  const submitGuess = (guess: string) => {
    if (!guess || guesses.length >= MAX_GUESSES || solved) return;
    update((prev) => {
      const cur = prev.buildleByDay[dayKey] ?? {
        buildName: ctx.question.buildName,
        guesses: [],
        solved: false,
      };
      const nextGuesses = [...cur.guesses, guess];
      const nextSolved = guess === ctx.question.buildName;
      return {
        ...prev,
        buildleByDay: {
          ...prev.buildleByDay,
          [dayKey]: {
            buildName: ctx.question.buildName,
            guesses: nextGuesses,
            solved: nextSolved,
          },
        },
      };
    });
    if (guess === ctx.question.buildName) {
      ctx.onAnswer(guess);
    } else if (guesses.length + 1 >= MAX_GUESSES) {
      ctx.onAnswer(guess); // exhausted attempts; reveal truth
    }
    setPick("");
  };

  const lines = guesses.map((g) => {
    const guessFeat = deriveFeatures(g, ctx.question.candidates.includes(g) ? undefined : undefined);
    const cluesByAxis: BuildleAxis[] = ["race", "techPath", "openingUnit", "firstAggression"];
    return {
      guess: g,
      clues: cluesByAxis.map((axis) =>
        clueFor(axis, guessFeat, ctx.question.features),
      ),
    };
  });

  const finished = solved || guesses.length >= MAX_GUESSES;
  const remaining = MAX_GUESSES - guesses.length;

  return (
    <GameStage
      icon={IconFor(ID)}
      title={buildle.title}
      depthLabel="Generative: 4-axis daily clue puzzle"
      hud={{
        score: solved ? `solved in ${guesses.length}` : `${guesses.length} / ${MAX_GUESSES}`,
        hint: finished ? "Card complete — comes back tomorrow" : `${remaining} guesses left`,
      }}
      isDaily={ctx.isDaily}
      body={
        <div className="space-y-3">
          <p className="text-caption text-text-muted">
            Guess the build. Each guess scores you across{" "}
            <span className="text-text">Race</span>,{" "}
            <span className="text-text">Tech path</span>,{" "}
            <span className="text-text">Opening unit</span>, and{" "}
            <span className="text-text">First aggression timing</span>.
          </p>
          <div
            className="flex flex-wrap items-center gap-3 rounded border border-border bg-bg-elevated p-2 text-caption"
            aria-label="Clue legend"
          >
            <span className="flex items-center gap-1.5">
              <span className="inline-flex h-5 w-5 items-center justify-center rounded bg-success/30 text-[10px] font-mono uppercase">
                ●
              </span>
              <span className="text-text">Exact match</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-flex h-5 w-5 items-center justify-center rounded bg-warning/30 text-[10px] font-mono uppercase">
                ●
              </span>
              <span className="text-text">Same family / adjacent timing</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-flex h-5 w-5 items-center justify-center rounded bg-bg-surface text-[10px] font-mono uppercase text-text-dim">
                ●
              </span>
              <span className="text-text">Not in this build</span>
            </span>
          </div>
          <ul className="space-y-1.5" aria-label="Buildle guesses">
            {lines.map((row, i) => (
              <li key={`${row.guess}-${i}`} className="space-y-1 rounded border border-border bg-bg-surface p-2">
                <div className="flex items-center justify-between text-caption">
                  <span className="truncate font-medium text-text">{row.guess}</span>
                  {row.guess === ctx.question.buildName ? (
                    <span className="rounded bg-success/15 px-1.5 text-success">Solved</span>
                  ) : null}
                </div>
                <div className="flex gap-1">
                  {row.clues.map((c) => (
                    <span
                      key={c.axis}
                      className={[
                        "inline-flex h-7 flex-1 items-center justify-center rounded text-[10px] font-mono uppercase tracking-wider",
                        c.state === "match"
                          ? "bg-success/30 text-text"
                          : c.state === "near"
                            ? "bg-warning/30 text-text"
                            : "bg-bg-elevated text-text-dim",
                      ].join(" ")}
                      title={`${ctx.question.axisLabels[c.axis]} — your guess: ${c.guessVal}, ${c.state === "match" ? "exact match" : c.state === "near" ? "close" : "miss"}`}
                      aria-label={`${ctx.question.axisLabels[c.axis]} — your guess: ${c.guessVal}, ${c.state}`}
                    >
                      {ctx.question.axisLabels[c.axis][0]}
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ul>
          {!finished ? (
            <div className="flex gap-2">
              <select
                aria-label="Guess a build"
                value={pick}
                onChange={(e) => setPick(e.target.value)}
                className="h-11 flex-1 rounded border border-border bg-bg-elevated px-2 text-body focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <option value="">— pick a build —</option>
                {ctx.question.candidates
                  .filter((c) => !guesses.includes(c))
                  .map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
              </select>
              <button
                type="button"
                onClick={() => submitGuess(pick)}
                disabled={!pick}
                className="inline-flex min-h-[44px] items-center rounded-md bg-accent px-4 text-caption font-semibold uppercase tracking-wider text-bg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
              >
                Guess
              </button>
            </div>
          ) : null}
          {finished && !solved ? (
            <p className="text-caption text-warning">
              The build was{" "}
              <span className="font-semibold text-text">{ctx.question.buildName}</span>.
            </p>
          ) : null}
        </div>
      }
    />
  );
}

/**
 * Build the Wordle-style emoji grid for sharing. Pure — pulled out so
 * a test can lock the format.
 */
export function buildleEmoji(
  guesses: string[],
  truth: string,
  features: BuildleFeatures,
  candidates: string[],
): string {
  const axes: BuildleAxis[] = ["race", "techPath", "openingUnit", "firstAggression"];
  const lines: string[] = [];
  for (const g of guesses) {
    const f = deriveFeatures(g, candidates.includes(g) ? undefined : undefined);
    const row = axes
      .map((a) => {
        const state = clueFor(a, f, features).state;
        if (state === "match") return "🟩";
        if (state === "near") return "🟨";
        return "⬜";
      })
      .join("");
    lines.push(row);
  }
  const header = `Buildle ${guesses.includes(truth) ? guesses.indexOf(truth) + 1 : "X"}/${MAX_GUESSES}`;
  return `${header}\n${lines.join("\n")}`;
}
