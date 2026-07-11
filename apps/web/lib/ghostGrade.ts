/**
 * ghostGrade — a pure, deterministic grader for the Ghost Build loop.
 *
 * Compares ONE game's executed build (raw ``[m:ss] Name`` build-log
 * lines, the shape lib/build-events.ts parses) against an armed
 * {@link GhostTarget} (lib/ghostBuild.ts) and produces a letter grade
 * with per-step timing drift and the first point of divergence.
 * No LLM, no network, no randomness — a pure function of its inputs so
 * repeated renders (and tests) always produce identical output.
 * Spawning Tool's build advisor displays a target; this GRADES the
 * execution.
 *
 * ALIGNMENT — greedy in-order name matching:
 *   Target steps are walked in chronological order. For each target
 *   step, the executed log is scanned FORWARD from a cursor for the
 *   first event whose normalized name matches (lowercase, everything
 *   but letters/digits stripped — the light normalization
 *   lib/salt.ts uses for alias lookups; see normalizeGhostName).
 *   On a match the cursor advances past the matched event, so each
 *   executed event satisfies at most one target step and ordering is
 *   preserved; on a miss the cursor stays put so a skipped target step
 *   can't consume evidence a later step needs. Extra executed events
 *   (workers, spare pylons, army beyond the target) are simply
 *   ignored. Unmatched target steps are misses.
 *
 * DRIFT — computed only over matched steps:
 *   driftSec (per step)  = actualT − expectedT (signed; + = late)
 *   avgDriftSec          = mean of |driftSec| over matched steps
 *   maxDriftSec          = max  of |driftSec| over matched steps
 *
 * FIRST DIVERGENCE — the earliest target step that either
 *   (a) was never matched (a cut/skipped step; actualT = null), or
 *   (b) matched with |drift| > DIVERGENCE_DRIFT_SEC (badly mistimed).
 *
 * GRADE THRESHOLDS (documented contract, tuned for ladder practice —
 *   ±5 s is "on the money", ±15 s is a slipped production cycle):
 *   matchRate = matchedSteps / targetSteps
 *   S: every step matched          AND avg ≤ 5 s  AND max ≤ 15 s
 *   A: matchRate ≥ 0.90            AND avg ≤ 10 s AND max ≤ 30 s
 *   B: matchRate ≥ 0.75            AND avg ≤ 20 s
 *   C: matchRate ≥ 0.50            AND avg ≤ 40 s
 *   D: everything else
 *   (An empty target grades "S" vacuously — nothing to execute. The
 *   arm/decode paths reject empty targets, so this only guards direct
 *   callers.)
 */

import { normalizeGhostName, type GhostTarget } from "@/lib/ghostBuild";

/** A matched step whose |drift| exceeds this counts as a divergence
 * even though the step was executed — 45 s late is "off the build". */
export const DIVERGENCE_DRIFT_SEC = 30;

export type GhostGradeLetter = "S" | "A" | "B" | "C" | "D";

export interface GhostStepGrade {
  /** Index into the target's step list. */
  index: number;
  name: string;
  /** Supply stamp from the target, when it carried one. */
  supply: number | null;
  expectedT: number;
  /** When the step was actually executed; null = never matched. */
  actualT: number | null;
  /** Signed drift (actualT − expectedT; + = late); null = missed. */
  driftSec: number | null;
  matched: boolean;
}

export interface GhostDivergence {
  index: number;
  name: string;
  expectedT: number;
  /** null = the step was cut entirely. */
  actualT: number | null;
}

export interface GhostGradeResult {
  grade: GhostGradeLetter;
  targetSteps: number;
  matchedSteps: number;
  /** Mean |drift| over matched steps, 1 dp. 0 when nothing matched. */
  avgDriftSec: number;
  /** Max |drift| over matched steps. 0 when nothing matched. */
  maxDriftSec: number;
  firstDivergence: GhostDivergence | null;
  perStep: GhostStepGrade[];
}

/** ``[m:ss] Name`` — same regex family as lib/build-events.ts. */
const BUILD_LOG_LINE_RE = /^\[(\d+):(\d{2})\]\s+(.+?)\s*$/;

interface ExecutedEvent {
  t: number;
  normalized: string;
}

/** Parse executed build-log lines; garbage lines are skipped. */
function parseExecutedLog(lines: ReadonlyArray<string>): ExecutedEvent[] {
  const events: ExecutedEvent[] = [];
  for (const line of lines) {
    if (typeof line !== "string") continue;
    const m = BUILD_LOG_LINE_RE.exec(line);
    if (!m) continue;
    const minutes = parseInt(m[1], 10);
    const seconds = parseInt(m[2], 10);
    if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) continue;
    const normalized = normalizeGhostName(m[3]);
    if (!normalized) continue;
    events.push({ t: minutes * 60 + seconds, normalized });
  }
  return events;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function letterFor(
  matchRate: number,
  allMatched: boolean,
  avg: number,
  max: number,
): GhostGradeLetter {
  if (allMatched && avg <= 5 && max <= 15) return "S";
  if (matchRate >= 0.9 && avg <= 10 && max <= 30) return "A";
  if (matchRate >= 0.75 && avg <= 20) return "B";
  if (matchRate >= 0.5 && avg <= 40) return "C";
  return "D";
}

/**
 * Grade an executed build against the armed target. Deterministic —
 * see the module doc for the alignment, drift, divergence, and grade
 * threshold contracts.
 */
export function gradeExecution(
  target: GhostTarget,
  executedLog: ReadonlyArray<string>,
): GhostGradeResult {
  const steps = target.steps;
  if (steps.length === 0) {
    // Vacuously perfect — nothing to execute. Decode/arm reject empty
    // targets, so this branch only guards direct callers.
    return {
      grade: "S",
      targetSteps: 0,
      matchedSteps: 0,
      avgDriftSec: 0,
      maxDriftSec: 0,
      firstDivergence: null,
      perStep: [],
    };
  }

  const executed = parseExecutedLog(executedLog);
  const perStep: GhostStepGrade[] = [];
  let cursor = 0;
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const wanted = normalizeGhostName(step.name);
    let matchedAt = -1;
    for (let j = cursor; j < executed.length; j += 1) {
      if (executed[j].normalized === wanted) {
        matchedAt = j;
        break;
      }
    }
    if (matchedAt >= 0) {
      const actualT = executed[matchedAt].t;
      perStep.push({
        index: i,
        name: step.name,
        supply: step.supply,
        expectedT: step.t,
        actualT,
        driftSec: actualT - step.t,
        matched: true,
      });
      cursor = matchedAt + 1;
    } else {
      perStep.push({
        index: i,
        name: step.name,
        supply: step.supply,
        expectedT: step.t,
        actualT: null,
        driftSec: null,
        matched: false,
      });
    }
  }

  const matched = perStep.filter((s) => s.matched);
  const absDrifts = matched.map((s) => Math.abs(s.driftSec as number));
  const avgDriftSec =
    absDrifts.length > 0
      ? round1(absDrifts.reduce((a, b) => a + b, 0) / absDrifts.length)
      : 0;
  const maxDriftSec = absDrifts.length > 0 ? Math.max(...absDrifts) : 0;

  let firstDivergence: GhostDivergence | null = null;
  for (const s of perStep) {
    const diverged =
      !s.matched || Math.abs(s.driftSec as number) > DIVERGENCE_DRIFT_SEC;
    if (diverged) {
      firstDivergence = {
        index: s.index,
        name: s.name,
        expectedT: s.expectedT,
        actualT: s.actualT,
      };
      break;
    }
  }

  const matchRate = matched.length / steps.length;
  return {
    grade: letterFor(
      matchRate,
      matched.length === steps.length,
      avgDriftSec,
      maxDriftSec,
    ),
    targetSteps: steps.length,
    matchedSteps: matched.length,
    avgDriftSec,
    maxDriftSec,
    firstDivergence,
    perStep,
  };
}
