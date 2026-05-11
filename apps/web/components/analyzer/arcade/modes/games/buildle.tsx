"use client";

import { useEffect, useMemo, useState } from "react";
import { GameStage } from "../../shells/GameStage";
import { IconFor } from "../../icons";
import {
  fnv1a,
  mulberry32,
  outcome,
  registerMode,
  shuffle,
  todayKey,
} from "../../ArcadeEngine";
import { useArcadeState } from "../../hooks/useArcadeState";
import type {
  ArcadeGame,
  ArcadeOpponent,
  BuildleProgress,
  GenerateInput,
  GenerateResult,
  Mode,
  ScoreResult,
} from "../../types";

const ID = "buildle";
registerMode(ID, "generative");

/* ──────────── question rotation ──────────── */

/**
 * The 9-day rotation. Each calendar day rolls to exactly one type via
 * day-of-year mod 9, so two devices on the same date see the same
 * question type for the user.
 */
export type BuildleQuestionType =
  | "duration"
  | "result"
  | "datePlayed"
  | "timeOfDay"
  | "oppOpener"
  | "yourBuild"
  | "timesPlayedOpponent"
  | "careerWrVsOpponent"
  | "streakGoingIn";

export const ROTATION: ReadonlyArray<BuildleQuestionType> = [
  "duration",
  "result",
  "datePlayed",
  "timeOfDay",
  "oppOpener",
  "yourBuild",
  "timesPlayedOpponent",
  "careerWrVsOpponent",
  "streakGoingIn",
];

/** Display label for each question type — used in the title, hint, and share text. */
export const QUESTION_LABEL: Record<BuildleQuestionType, string> = {
  duration: "Game duration",
  result: "Win or Loss",
  datePlayed: "When did you play this?",
  timeOfDay: "Time of day",
  oppOpener: "Opponent's opener",
  yourBuild: "Your build",
  timesPlayedOpponent: "Times played this opponent",
  careerWrVsOpponent: "Career WR vs this opponent",
  streakGoingIn: "Streak going in",
};

/** Day-of-year (UTC) for an ISO yyyy-mm-dd string. */
export function dayOfYear(daySeed: string): number {
  if (!daySeed) return 0;
  const t = new Date(`${daySeed}T00:00:00Z`).getTime();
  if (!Number.isFinite(t)) return 0;
  const start = new Date(`${daySeed.slice(0, 4)}-01-01T00:00:00Z`).getTime();
  return Math.floor((t - start) / 86_400_000);
}

/** Question type for a given calendar day. */
export function questionTypeForDay(daySeed: string): BuildleQuestionType {
  if (!daySeed) return ROTATION[0];
  return ROTATION[dayOfYear(daySeed) % ROTATION.length];
}

/* ──────────── bucketing (pure, fully testable) ──────────── */

export const DURATION_BUCKETS = ["Under 5 min", "5–10 min", "10–15 min", "15+ min"] as const;
export type DurationBucket = (typeof DURATION_BUCKETS)[number];

export function durationBucket(seconds: number): DurationBucket {
  const m = seconds / 60;
  if (m < 5) return "Under 5 min";
  if (m < 10) return "5–10 min";
  if (m < 15) return "10–15 min";
  return "15+ min";
}

export const RESULT_BUCKETS = ["Win", "Loss"] as const;
export type ResultBucket = (typeof RESULT_BUCKETS)[number];

export function resultBucket(result: string): ResultBucket | null {
  const o = outcome({ result });
  if (o === "W") return "Win";
  if (o === "L") return "Loss";
  return null;
}

export const AGE_BUCKETS = [
  "Last 30 days",
  "1–3 months ago",
  "3–6 months ago",
  "6–12 months ago",
] as const;
export type AgeBucket = (typeof AGE_BUCKETS)[number];

/** Bucket for "how long ago" (ms diff between now and the game). */
export function ageBucket(gameDate: string, now: Date): AgeBucket | null {
  const t = new Date(gameDate).getTime();
  if (!Number.isFinite(t)) return null;
  const days = Math.floor((now.getTime() - t) / 86_400_000);
  if (days < 0) return null;
  if (days <= 30) return "Last 30 days";
  if (days <= 90) return "1–3 months ago";
  if (days <= 180) return "3–6 months ago";
  if (days <= 365) return "6–12 months ago";
  return null;
}

export const TIME_OF_DAY_BUCKETS = ["Morning", "Afternoon", "Evening", "Night"] as const;
export type TimeOfDayBucket = (typeof TIME_OF_DAY_BUCKETS)[number];

/** Local-clock buckets. 6a–12p morning, 12p–6p afternoon, 6p–12a evening, 12a–6a night. */
export function timeOfDayBucket(gameDate: string): TimeOfDayBucket | null {
  const d = new Date(gameDate);
  if (Number.isNaN(d.getTime())) return null;
  const h = d.getHours();
  if (h >= 6 && h < 12) return "Morning";
  if (h >= 12 && h < 18) return "Afternoon";
  if (h >= 18 && h < 24) return "Evening";
  return "Night";
}

export const TIMES_PLAYED_BUCKETS = ["1st time", "2–5", "6–15", "16+"] as const;
export type TimesPlayedBucket = (typeof TIMES_PLAYED_BUCKETS)[number];

export function timesPlayedBucket(count: number): TimesPlayedBucket {
  if (count <= 1) return "1st time";
  if (count <= 5) return "2–5";
  if (count <= 15) return "6–15";
  return "16+";
}

export const WR_BUCKETS = ["0–25%", "25–50%", "50–75%", "75–100%"] as const;
export type WrBucket = (typeof WR_BUCKETS)[number];

export function wrBucket(wr: number): WrBucket {
  if (wr < 0.25) return "0–25%";
  if (wr < 0.5) return "25–50%";
  if (wr < 0.75) return "50–75%";
  return "75–100%";
}

export const STREAK_BUCKETS = [
  "3+ win streak",
  "1–2 wins",
  "1–2 losses",
  "3+ loss streak",
] as const;
export type StreakBucket = (typeof STREAK_BUCKETS)[number];

/** Positive = wins in a row going in, negative = losses in a row. 0 = neutral. */
export function streakBucket(signed: number): StreakBucket {
  if (signed >= 3) return "3+ win streak";
  if (signed >= 1) return "1–2 wins";
  if (signed >= -2 && signed <= -1) return "1–2 losses";
  if (signed <= -3) return "3+ loss streak";
  // 0 → treat as "1–2 losses" boundary fallback so the bucket is always defined.
  return "1–2 losses";
}

/**
 * Walk backwards from a game's index. Count Ws contiguously (positive
 * streak) or Ls contiguously (negative). Undecided games are skipped.
 * Returns 0 only when no decided games precede.
 */
export function streakGoingIntoGame(gamesAsc: ArcadeGame[], idx: number): number {
  let signed = 0;
  let direction: "W" | "L" | null = null;
  for (let i = idx - 1; i >= 0; i--) {
    const o = outcome(gamesAsc[i]);
    if (o === "U") continue;
    if (direction === null) {
      direction = o;
      signed = o === "W" ? 1 : -1;
      continue;
    }
    if (o !== direction) break;
    signed += direction === "W" ? 1 : -1;
  }
  return signed;
}

/* ──────────── opener bucketing ──────────── */

/**
 * Race-aware buckets for the opp_strategy string. We project the raw
 * label onto a small fixed set of openers so options are mutually
 * exclusive and recognisable, and so similar phrasings collapse to the
 * same bucket ("ling-bane all-in" and "zergling baneling rush" both
 * land on "Ling-Bane all-in").
 */
const OPP_OPENERS: ReadonlyArray<{ re: RegExp; label: string; race?: "T" | "Z" | "P" }> = [
  // Zerg
  { re: /\bling[\s-]?bane|\bzergling\b.*\bbaneling\b|baneling.*ling/i, label: "Ling-Bane all-in", race: "Z" },
  { re: /\b12[\s-]?pool|\bpool\s*first|6[\s-]?pool/i, label: "Pool-first", race: "Z" },
  { re: /\broach\b/i, label: "Roach push", race: "Z" },
  { re: /\bmuta|mutalisk/i, label: "Mutalisk", race: "Z" },
  { re: /\bnydus|nidus/i, label: "Nydus", race: "Z" },
  { re: /\bhydra|hydralisk/i, label: "Hydra timing", race: "Z" },
  { re: /\bhatch[\s-]?first|3[\s-]?hatch/i, label: "Hatch-first macro", race: "Z" },
  // Terran
  { re: /\breaper\b/i, label: "Reaper expand", race: "T" },
  { re: /\bhellion|hellbat/i, label: "Hellion harass", race: "T" },
  { re: /\bbio\b|\bmarine\b/i, label: "Bio timing", race: "T" },
  { re: /\bmech\b|\btank\b|\bcyclone\b/i, label: "Mech", race: "T" },
  { re: /\bbanshee\b/i, label: "Banshee opener", race: "T" },
  { re: /\bproxy\b/i, label: "Proxy", race: "T" },
  // Protoss
  { re: /\boracle\b/i, label: "Oracle harass", race: "P" },
  { re: /\badept\b/i, label: "Adept pressure", race: "P" },
  { re: /\bzealot\b/i, label: "Zealot pressure", race: "P" },
  { re: /\bstalker\b/i, label: "Stalker timing", race: "P" },
  { re: /\bvoid[\s-]?ray|tempest|carrier|skytoss/i, label: "Skytoss", race: "P" },
  { re: /\bcannon[\s-]?rush/i, label: "Cannon rush", race: "P" },
  // Cross-race
  { re: /\bcheese|all[\s-]?in/i, label: "All-in" },
  { re: /\bmacro|fast[\s-]?expand|three[\s-]?base|3[\s-]?base/i, label: "Macro game" },
];

export function opponentOpenerBucket(strategy: string | null | undefined): string | null {
  if (!strategy) return null;
  for (const o of OPP_OPENERS) {
    if (o.re.test(strategy)) return o.label;
  }
  return null;
}

/** All bucket labels that fit a given race — used for distractor selection. */
export function openersForRace(race: "T" | "Z" | "P"): string[] {
  return OPP_OPENERS.filter((o) => !o.race || o.race === race).map((o) => o.label);
}

/* ──────────── question payload ──────────── */

export interface CaseFileFact {
  /** Stable key — used to dedupe and to skip the hidden one. */
  key: string;
  label: string;
  value: string;
  /** Optional tonal hint for UI styling. */
  tone?: "default" | "muted";
}

interface Q {
  gameId: string;
  questionType: BuildleQuestionType;
  /** Short prompt shown above the buttons. */
  prompt: string;
  /** Which fact key is hidden — used to redact the case file. */
  hiddenKey: string;
  /** Buttons, in render order. */
  options: string[];
  /** Index in `options` of the correct answer. */
  correctIndex: number;
  /** The full case file. Render skips the hidden one. */
  caseFile: CaseFileFact[];
}

type A = number; // index of picked option

/* ──────────── helpers ──────────── */

function normaliseRace(r: string | undefined | null): "T" | "Z" | "P" | null {
  const c = String(r || "").charAt(0).toUpperCase();
  if (c === "T" || c === "Z" || c === "P") return c;
  return null;
}

function raceLabel(r: string | undefined | null): string {
  const n = normaliseRace(r);
  if (n === "T") return "Terran";
  if (n === "Z") return "Zerg";
  if (n === "P") return "Protoss";
  return "Random";
}

function formatDuration(seconds: number | undefined): string {
  if (!seconds || !Number.isFinite(seconds)) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatDateLong(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function buildCaseFile(
  g: ArcadeGame,
  opp: ArcadeOpponent | undefined,
  hiddenKey: string,
): CaseFileFact[] {
  const facts: CaseFileFact[] = [];
  facts.push({
    key: "opponent",
    label: "Opponent",
    value: opp?.displayName || opp?.name || g.opponent?.displayName || "Unknown",
  });
  facts.push({
    key: "date",
    label: "Date played",
    value: formatDateLong(g.date),
  });
  facts.push({
    key: "matchup",
    label: "Matchup",
    value: `${raceLabel(g.myRace)} vs ${raceLabel(g.oppRace)}`,
  });
  if (g.map) {
    facts.push({ key: "map", label: "Map", value: g.map });
  }
  facts.push({
    key: "duration",
    label: "Duration",
    value: formatDuration(g.duration),
  });
  facts.push({
    key: "result",
    label: "Result",
    value: outcome(g) === "W" ? "Win" : outcome(g) === "L" ? "Loss" : "Undecided",
  });
  if (g.myBuild) {
    facts.push({ key: "yourBuild", label: "Your build", value: g.myBuild });
  }
  if (g.opp_strategy) {
    facts.push({ key: "oppOpener", label: "Opponent opener", value: g.opp_strategy });
  }
  return facts.filter((f) => f.key !== hiddenKey);
}

/**
 * Race-appropriate distractor build labels for the "Your build" round.
 * We pull from the user's own most-played builds in this matchup so
 * the choices feel personal rather than generic.
 */
function buildOptionsForMatchup(
  builds: GenerateInput["data"]["builds"],
  truth: string,
  myRace: "T" | "Z" | "P" | null,
  rng: () => number,
): string[] {
  const candidates = builds
    .filter((b) => b.name !== truth)
    .filter((b) => !myRace || normaliseRace(b.race) === myRace)
    .sort((a, b) => b.total - a.total)
    .slice(0, 8);
  const distractors = shuffle(
    candidates.map((b) => b.name),
    rng,
  ).slice(0, 3);
  return shuffle([truth, ...distractors], rng);
}

/* ──────────── per-question generators ──────────── */

interface QSpec {
  prompt: string;
  hiddenKey: string;
  options: string[];
  correct: string;
}

function generateDuration(g: ArcadeGame): QSpec | null {
  if (!g.duration) return null;
  const correct = durationBucket(g.duration);
  return {
    prompt: "How long did this game last?",
    hiddenKey: "duration",
    options: [...DURATION_BUCKETS],
    correct,
  };
}

function generateResult(g: ArcadeGame): QSpec | null {
  const b = resultBucket(g.result);
  if (!b) return null;
  return {
    prompt: "Did you win or lose this game?",
    hiddenKey: "result",
    options: [...RESULT_BUCKETS],
    correct: b,
  };
}

function generateDate(g: ArcadeGame, now: Date): QSpec | null {
  const b = ageBucket(g.date, now);
  if (!b) return null;
  return {
    prompt: "When did you play this?",
    hiddenKey: "date",
    options: [...AGE_BUCKETS],
    correct: b,
  };
}

function generateTimeOfDay(g: ArcadeGame): QSpec | null {
  const b = timeOfDayBucket(g.date);
  if (!b) return null;
  return {
    prompt: "What time of day was this?",
    hiddenKey: "date",
    options: [...TIME_OF_DAY_BUCKETS],
    correct: b,
  };
}

function generateOppOpener(g: ArcadeGame, rng: () => number): QSpec | null {
  const truth = opponentOpenerBucket(g.opp_strategy);
  if (!truth) return null;
  const oppRace = normaliseRace(g.oppRace);
  const pool = oppRace ? openersForRace(oppRace) : OPP_OPENERS.map((o) => o.label);
  const distractors = shuffle(
    pool.filter((l) => l !== truth),
    rng,
  ).slice(0, 3);
  return {
    prompt: "What did your opponent open with?",
    hiddenKey: "oppOpener",
    options: shuffle([truth, ...distractors], rng),
    correct: truth,
  };
}

function generateYourBuild(
  g: ArcadeGame,
  data: GenerateInput["data"],
  rng: () => number,
): QSpec | null {
  if (!g.myBuild) return null;
  const myRace = normaliseRace(g.myRace);
  const opts = buildOptionsForMatchup(data.builds, g.myBuild, myRace, rng);
  if (opts.length < 2 || !opts.includes(g.myBuild)) return null;
  return {
    prompt: "Which of your builds did you play here?",
    hiddenKey: "yourBuild",
    options: opts,
    correct: g.myBuild,
  };
}

function generateTimesPlayed(
  g: ArcadeGame,
  opp: ArcadeOpponent | undefined,
): QSpec | null {
  if (!opp || !opp.games) return null;
  const b = timesPlayedBucket(opp.games);
  return {
    prompt: "How many times had you played this opponent (total, all-time)?",
    hiddenKey: "opponent",
    options: [...TIMES_PLAYED_BUCKETS],
    correct: b,
  };
}

function generateCareerWr(g: ArcadeGame, opp: ArcadeOpponent | undefined): QSpec | null {
  if (!opp || !opp.games || opp.games < 3) return null;
  const b = wrBucket(opp.userWinRate);
  return {
    prompt: "What's your all-time win rate vs this opponent?",
    hiddenKey: "opponent",
    options: [...WR_BUCKETS],
    correct: b,
  };
}

function generateStreakGoingIn(
  g: ArcadeGame,
  gamesAsc: ArcadeGame[],
  idx: number,
): QSpec | null {
  if (idx < 1) return null;
  const signed = streakGoingIntoGame(gamesAsc, idx);
  if (signed === 0) return null;
  const b = streakBucket(signed);
  return {
    prompt: "What streak were you on going into this game?",
    hiddenKey: "result",
    options: [...STREAK_BUCKETS],
    correct: b,
  };
}

/** Dispatch per-question generation. Returns null if the game is unsuitable. */
function buildQuestion(
  type: BuildleQuestionType,
  g: ArcadeGame,
  gamesAsc: ArcadeGame[],
  idx: number,
  data: GenerateInput["data"],
  opp: ArcadeOpponent | undefined,
  rng: () => number,
  now: Date,
): QSpec | null {
  switch (type) {
    case "duration":
      return generateDuration(g);
    case "result":
      return generateResult(g);
    case "datePlayed":
      return generateDate(g, now);
    case "timeOfDay":
      return generateTimeOfDay(g);
    case "oppOpener":
      return generateOppOpener(g, rng);
    case "yourBuild":
      return generateYourBuild(g, data, rng);
    case "timesPlayedOpponent":
      return generateTimesPlayed(g, opp);
    case "careerWrVsOpponent":
      return generateCareerWr(g, opp);
    case "streakGoingIn":
      return generateStreakGoingIn(g, gamesAsc, idx);
  }
}

/* ──────────── generator ──────────── */

async function generate(input: GenerateInput): Promise<GenerateResult<Q>> {
  if (input.data.games.length < 10) {
    return { ok: false, reason: "Need ≥10 games before we can build a case file." };
  }
  const now = new Date();
  // Sort once, oldest → newest. Used both for selection and for the
  // streak-going-in question.
  const gamesAsc = [...input.data.games].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );
  // Exclude games younger than ~24 hours so today's session isn't the
  // mystery (no chance to forget yet).
  const cutoff = now.getTime() - 24 * 60 * 60 * 1000;
  const eligible: Array<{ idx: number; game: ArcadeGame }> = [];
  for (let i = 0; i < gamesAsc.length; i++) {
    const g = gamesAsc[i];
    const t = new Date(g.date).getTime();
    if (Number.isFinite(t) && t < cutoff) eligible.push({ idx: i, game: g });
  }
  if (eligible.length < 5) {
    return {
      ok: false,
      reason: "Need ≥5 games at least a day old. Play some more ladder games and come back.",
    };
  }

  const type = questionTypeForDay(input.daySeed || todayKey(now, input.tz));
  const oppById = new Map<string, ArcadeOpponent>();
  for (const o of input.data.opponents) oppById.set(o.pulseId, o);

  // Build a per-day candidate list that can actually answer today's
  // question. We try every eligible game in a deterministic seeded
  // order; the first that yields a valid QSpec wins.
  const ordered = shuffle(eligible, input.rng);
  for (const { idx, game } of ordered) {
    const opp = game.oppPulseId ? oppById.get(game.oppPulseId) : undefined;
    // Fresh RNG per attempt so distractor draws don't drift with the
    // skip count.
    const localRng = mulberry32(fnv1a(`${input.daySeed}::${game.gameId}`));
    const spec = buildQuestion(type, game, gamesAsc, idx, input.data, opp, localRng, now);
    if (!spec) continue;
    const correctIndex = spec.options.indexOf(spec.correct);
    if (correctIndex < 0) continue;
    return {
      ok: true,
      minDataMet: true,
      question: {
        gameId: game.gameId,
        questionType: type,
        prompt: spec.prompt,
        hiddenKey: spec.hiddenKey,
        options: spec.options,
        correctIndex,
        caseFile: buildCaseFile(game, opp, spec.hiddenKey),
      },
    };
  }

  return {
    ok: false,
    reason:
      "We couldn't build today's case file from your data. Try again tomorrow when the rotation moves on.",
  };
}

function score(q: Q, a: A): ScoreResult {
  const correct = a === q.correctIndex;
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
  blurb:
    "Daily case file from your real games. One fact is hidden — pick the right bucket.",
  generate,
  score,
  render: (ctx) => <Render ctx={ctx} />,
};

/* ──────────── share ──────────── */

/**
 * Build the share string for Buildle. Replaces the old Wordle-style
 * emoji grid — there's a single binary outcome per day now, so the
 * share is a one-liner that names the day's question type.
 */
export function buildleShareText(
  progress: BuildleProgress | undefined,
  daySeed: string,
): string {
  const dayLabel = daySeed || new Date().toISOString().slice(0, 10);
  if (!progress || progress.pickedIndex < 0) {
    return `Buildle · ${dayLabel} · not played yet`;
  }
  const type = progress.questionType as BuildleQuestionType;
  const label = QUESTION_LABEL[type] || "Daily";
  const stamp = progress.correct ? "✅" : "❌";
  return `Buildle · ${dayLabel} · ${label} ${stamp}`;
}

/* ──────────── render ──────────── */

function Render({
  ctx,
}: {
  ctx: Parameters<Mode<Q, A>["render"]>[0];
}) {
  const { state, update } = useArcadeState();
  const dayKey = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const stored: BuildleProgress | undefined = state.buildleByDay[dayKey];
  // If yesterday's case file is still in the store but today rolled to
  // a different question type / game, treat the day as fresh.
  const isFreshDay =
    !stored ||
    stored.gameId !== ctx.question.gameId ||
    stored.questionType !== ctx.question.questionType;
  const picked = isFreshDay ? -1 : stored.pickedIndex ?? -1;
  const answered = picked >= 0;
  const correct = answered ? picked === ctx.question.correctIndex : false;

  // First mount of the day: seed the day's record so reloads see the
  // same state. We don't set pickedIndex until the user picks.
  //
  // Idempotency note: this effect can fire BEFORE useArcadeState has
  // hydrated from the server (state.buildleByDay is empty by default),
  // so the mutator queue inside useArcadeState may replay it on top of
  // hydrated state. Inside the mutator we re-check the *actual* prev
  // state and bail when the slot already matches today's question —
  // otherwise we'd clobber a saved pickedIndex with -1.
  useEffect(() => {
    if (!isFreshDay) return;
    update((prev) => {
      const existing = prev.buildleByDay[dayKey];
      if (
        existing &&
        existing.gameId === ctx.question.gameId &&
        existing.questionType === ctx.question.questionType
      ) {
        return prev;
      }
      return {
        ...prev,
        buildleByDay: {
          ...prev.buildleByDay,
          [dayKey]: {
            gameId: ctx.question.gameId,
            questionType: ctx.question.questionType,
            options: ctx.question.options,
            correctIndex: ctx.question.correctIndex,
            pickedIndex: -1,
            correct: false,
          },
        },
      };
    });
  }, [
    isFreshDay,
    dayKey,
    ctx.question.gameId,
    ctx.question.questionType,
    ctx.question.options,
    ctx.question.correctIndex,
    update,
  ]);

  const pick = (index: number) => {
    if (answered) return;
    const isCorrect = index === ctx.question.correctIndex;
    update((prev) => ({
      ...prev,
      buildleByDay: {
        ...prev.buildleByDay,
        [dayKey]: {
          gameId: ctx.question.gameId,
          questionType: ctx.question.questionType,
          options: ctx.question.options,
          correctIndex: ctx.question.correctIndex,
          pickedIndex: index,
          correct: isCorrect,
        },
      },
    }));
    ctx.onAnswer(index);
  };

  const questionLabel = QUESTION_LABEL[ctx.question.questionType];

  return (
    <GameStage
      icon={IconFor(ID)}
      title={buildle.title}
      depthLabel={`Daily case file · ${questionLabel}`}
      hud={{
        score: answered ? (correct ? "✓ correct" : "✗ wrong") : "—",
        hint: answered
          ? "Sealed for today — comes back tomorrow."
          : "One pick. No partial credit.",
      }}
      isDaily={ctx.isDaily}
      body={
        <div className="space-y-4">
          <CaseFile
            facts={ctx.question.caseFile}
            hiddenLabel={questionLabel}
            revealed={
              answered ? ctx.question.options[ctx.question.correctIndex] : null
            }
          />
          <div className="space-y-2">
            <p className="text-caption text-text-muted">{ctx.question.prompt}</p>
            <div
              className={[
                "grid gap-2",
                ctx.question.options.length === 2 ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-4",
              ].join(" ")}
              role="group"
              aria-label="Answer options"
            >
              {ctx.question.options.map((opt, i) => {
                const isPick = i === picked;
                const isRight = i === ctx.question.correctIndex;
                const tone = !answered
                  ? "bg-bg-surface text-text hover:bg-bg-elevated"
                  : isRight
                    ? "bg-success/25 text-text border-success/50"
                    : isPick
                      ? "bg-danger/25 text-text border-danger/50"
                      : "bg-bg-surface text-text-dim";
                return (
                  <button
                    key={`${opt}-${i}`}
                    type="button"
                    onClick={() => pick(i)}
                    disabled={answered}
                    className={[
                      "inline-flex min-h-[44px] items-center justify-center rounded-md border border-border px-3 text-caption font-semibold uppercase tracking-wider focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default",
                      tone,
                    ].join(" ")}
                  >
                    {opt}
                  </button>
                );
              })}
            </div>
          </div>
          {answered ? (
            <Reveal
              correct={correct}
              truth={ctx.question.options[ctx.question.correctIndex]}
              questionLabel={questionLabel}
            />
          ) : null}
        </div>
      }
    />
  );
}

function CaseFile({
  facts,
  hiddenLabel,
  revealed,
}: {
  facts: CaseFileFact[];
  hiddenLabel: string;
  revealed: string | null;
}) {
  return (
    <section
      aria-label="Case file"
      className="rounded-md border border-border bg-bg-elevated p-3"
    >
      <header className="mb-2 flex items-center justify-between">
        <span className="text-caption font-mono uppercase tracking-wider text-text-dim">
          Case file
        </span>
        <span className="rounded-full bg-bg-surface px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider text-text-dim">
          1 fact redacted
        </span>
      </header>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2">
        {facts.map((f) => (
          <div
            key={f.key}
            className="flex items-baseline justify-between gap-2 border-b border-border/40 py-1 last:border-b-0"
          >
            <dt className="text-caption uppercase tracking-wider text-text-dim">
              {f.label}
            </dt>
            <dd className="truncate text-caption font-mono tabular-nums text-text">
              {f.value}
            </dd>
          </div>
        ))}
        <div className="col-span-full mt-1 flex items-baseline justify-between gap-2 rounded border border-warning/40 bg-warning/10 px-2 py-1.5">
          <dt className="text-caption uppercase tracking-wider text-warning">
            {hiddenLabel}
          </dt>
          <dd className="font-mono tabular-nums text-body text-warning">
            {revealed ?? "███"}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function Reveal({
  correct,
  truth,
  questionLabel,
}: {
  correct: boolean;
  truth: string;
  questionLabel: string;
}) {
  return (
    <div
      className={[
        "rounded-md border p-3 text-caption",
        correct
          ? "border-success/40 bg-success/10 text-success"
          : "border-warning/40 bg-warning/10 text-warning",
      ].join(" ")}
      role="status"
      aria-live="polite"
    >
      <p>
        <span className="font-semibold text-text">{questionLabel}:</span>{" "}
        <span className="font-mono text-text">{truth}</span>
        {correct ? " — nice." : " — sealed for the day."}
      </p>
    </div>
  );
}
