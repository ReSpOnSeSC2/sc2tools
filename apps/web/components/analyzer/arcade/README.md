# Arcade

Quizzes and games surfaced as the 6th tab of the analyzer (`AnalyzerShell`).
Each mode sources from real `/v1/*` endpoints — never mock data — and ships
with a declared `depthTag` enforced by CI.

## The depth rule

A mode is allowed only if its answer is **not visible by sorting one column on an existing tab** (Opponents / Strategies / Trends / Maps / Builds / Per-game inspector). A new mode's `depthTag` must be one of:

| Tag | Meaning |
|---|---|
| `multi-entity` | Compares ≥3 entities side-by-side on one axis |
| `cross-axis` | Combines ≥2 axes (matchup × time, build × map, etc.) |
| `temporal` | Walks the timeline; uses ordering, not just totals |
| `conditional` | Filters/aggregates on a condition over a sequence (after-X, given-Y) |
| `hidden-derivation` | Computes a hidden field (mean win-length, etc.) |
| `forward` | Predicts the future or resolves over a future window |
| `generative` | Builds new game state (portfolios, cards, daily puzzles) |

The CI script `scripts/depthLint.mjs` walks every mode file, asserts a known `depthTag` literal is present, and that it agrees with the file's `registerMode(...)` call. The unit test `__tests__/depthLint.test.ts` cross-checks at runtime.

## Locked catalog

Sixteen modes, exactly. The catalog is locked: a mode is added only by replacing one of these slots after a design review.

### Quizzes (10)

| ID | Tag | What it asks |
|---|---|---|
| `opponent-bracket-pick` | multi-entity | Pick the highest-WR opponent in a bracket of 4 |
| `rivalry-ranker` | multi-entity | Rank 4 opponents by your personal WR vs them |
| `active-streak-hunter` | temporal | Which rival is on their longest active win streak vs you |
| `streak-veto` | temporal | Which loss broke your longest winning streak |
| `first-game-of-day` | conditional | First-game-of-session WR vs overall WR (higher / lower / within ±2%) |
| `streak-after-loss` | conditional | Bucket your WR after losing 3 straight |
| `comeback-count` | temporal | How many times you came back from 0–2 in a session |
| `loss-pattern-sleuth` | conditional | Modal next-build after losing to a given race |
| `closers-eye` | hidden-derivation | Build with the shortest mean win duration (cannon rush excluded) |
| `macro-memory` | hidden-derivation | Pick the cleanest macro game from 3 unscored options |

### Games (6)

| ID | Tag | What it does |
|---|---|---|
| `stock-market` | generative | Allocate 100 across ≤5 builds for the week; weekly P&L = Σ(weight × Δprice). Opt-in leaderboard renders in **Community → Leaderboard** |
| `bingo-ladder` | forward | 5×5 forward objectives auto-resolved against the next 7 days of ingested games. Map-bound objectives draw from `/v1/seasons` `mapPool` |
| `buildle` | generative | Daily case file from a real game in your history. One fact is redacted (duration, result, when, time-of-day, opp opener, your build, times played opponent, career WR vs opponent, or streak going in — 9-day rotation). One pick from 2–4 buckets, correct or wrong, sealed for the day |
| `two-truths-lie` | cross-axis | Three multi-axis claims about you — pick the lie |
| `higher-or-lower` | multi-entity | Card-stack guess on next build's WR. 3 lives, persisted personal-best |
| `builds-as-cards` | generative | Collection: every played build → card with rarity/attack/defense/foil derived from totals |

## Add a new mode in <50 lines

```tsx
"use client";

import { useState } from "react";
import { QuizAnswerButton, QuizCard } from "../../shells/QuizCard";
import { IconFor } from "../../icons";
import { pickN, registerMode } from "../../ArcadeEngine";
import type { GenerateInput, GenerateResult, Mode, ScoreResult } from "../../types";

type Q = { /* round payload */ };
type A = number;
const ID = "your-mode";
registerMode(ID, "multi-entity"); // pick the right depthTag

async function generate(input: GenerateInput): Promise<GenerateResult<Q>> {
  if (input.data.opponents.length < 3) {
    return { ok: false, reason: "Need 3+ opponents." };
  }
  return { ok: true, minDataMet: true, question: { /* … */ } };
}

function score(q: Q, a: A): ScoreResult {
  return { raw: 1, xp: 10, outcome: "correct" };
}

export const yourMode: Mode<Q, A> = {
  id: ID, kind: "quiz", category: "matchups", difficulty: "easy",
  ttp: "fast", depthTag: "multi-entity",
  title: "Your Mode", blurb: "Short pitch.",
  generate, score, render: (ctx) => <Render ctx={ctx} />,
};

function Render(/* … */) { /* QuizCard + QuizAnswerButton */ }
```

Then:

1. Add `import { yourMode } from "./quizzes/yourMode"` in `modes/index.ts` and append to `QUIZZES` (or `GAMES`).
2. Add a unique inline SVG to `icons.tsx` keyed by your `ID`.
3. CI's depth-lint will refuse the build if `depthTag` is missing or unknown.

## State persistence

State (streak / XP / minerals / cards / portfolio / Bingo / Buildle history / cosmetics / leaderboard opt-in) is persisted server-side via `PUT /v1/me/preferences/arcade` — the **server allowlists `arcade` as one of the preference types**. The blob is small (≤ ~3 kB) and writes are debounced (~600 ms) on every mutator.

## Server endpoints touched

- `PREF_TYPES` in `apps/api/src/routes/me.js` accepts `"arcade"`.
- `/v1/seasons` returns a `mapPool: string[]` field (current 1v1 ladder pool).
- `/v1/arcade/quests/resolve` — Bingo objective resolver (server-side predicates).
- `/v1/arcade/leaderboard` — Stock Market weekly P&L (opt-in, anonymisable).

## Daily seed

Daily content uses `mulberry32(fnv1a(userId + "::" + YYYY-MM-DD))` so the same user sees the same Daily Drop and Daily Run on every device for the day. `dailySeed()` and `weekKey()` live in `ArcadeEngine.ts`.

## No mock data

Every mode either renders against real data or returns `{ ok: false, reason }` and the surface shows an empty-state card with a CTA to the analyzer surface that builds the missing data. The `__tests__/thinDataEmpty.test.ts` spec asserts every quiz returns `ok=false` on an empty fixture.
