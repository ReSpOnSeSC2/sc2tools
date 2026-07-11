"use client";

/**
 * GhostGradeCard — the closing move of the Ghost Build practice loop.
 *
 * When a target build is armed (localStorage mirror written by the
 * "Arm" affordance on a game's own build log)
 * AND this game has a my-side build log, the card grades the executed
 * build against the target: letter grade, per-step timing drift, and
 * the first point of divergence. Grading is lib/ghostGrade.ts — pure
 * and deterministic; this card only renders its output. Spawning
 * Tool's advisor displays a build; this grades the execution.
 *
 * Renders nothing when no target is armed or the game has no build
 * log — the page must not gain an empty box for users who never
 * touched Ghost Build.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Crosshair } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { useToastOptional } from "@/components/ui/Toast";
import {
  armGhostTarget,
  disarmGhostTarget,
  fromBuildLog,
  readArmedGhostTarget,
  type GhostTarget,
} from "@/lib/ghostBuild";
import {
  gradeExecution,
  type GhostGradeLetter,
  type GhostGradeResult,
} from "@/lib/ghostGrade";

/**
 * Same-page arm→grade sync: arming from this page's build column
 * should make the grade card appear without a reload. localStorage
 * "storage" events only fire in OTHER tabs, so the arm affordances
 * dispatch this custom event locally.
 */
export const GHOST_ARMED_EVENT = "sc2tools:ghost-build-armed";

const GRADE_CLASS: Record<GhostGradeLetter, string> = {
  S: "text-success",
  A: "text-accent-cyan",
  B: "text-warning",
  C: "text-warning",
  D: "text-danger",
};

const GRADE_HINT: Record<GhostGradeLetter, string> = {
  S: "On the money — every step, on time.",
  A: "Tight — a step slipped or drifted a touch.",
  B: "Solid skeleton, loose timings.",
  C: "Half the homework made it in.",
  D: "That was a different build.",
};

export function GhostGradeCard({
  buildLog,
}: {
  /** Raw my-side ``[m:ss] Name`` lines for THIS game. */
  buildLog: ReadonlyArray<string> | null;
}) {
  // localStorage is read after mount (SSR-safe) and re-read when an
  // arm affordance fires the local event.
  const [target, setTarget] = useState<GhostTarget | null>(null);
  const [showSteps, setShowSteps] = useState(false);
  useEffect(() => {
    const read = () => setTarget(readArmedGhostTarget());
    read();
    window.addEventListener(GHOST_ARMED_EVENT, read);
    return () => window.removeEventListener(GHOST_ARMED_EVENT, read);
  }, []);

  const grade = useMemo<GhostGradeResult | null>(() => {
    if (!target || !buildLog || buildLog.length === 0) return null;
    return gradeExecution(target, buildLog);
  }, [target, buildLog]);

  const onDisarm = useCallback(() => {
    disarmGhostTarget();
    setTarget(null);
  }, []);

  if (!target || !grade) return null;

  return (
    <Card title="Ghost Build grade" data-testid="ghost-grade-card">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span
            className={`font-display text-5xl font-bold leading-none ${GRADE_CLASS[grade.grade]}`}
            aria-label={`Grade ${grade.grade}`}
          >
            {grade.grade}
          </span>
          <div className="min-w-0">
            <p className="truncate text-body font-medium text-text" title={target.name}>
              vs {target.name}
            </p>
            <p className="text-caption text-text-muted">
              {GRADE_HINT[grade.grade]}
            </p>
          </div>
        </div>

        <dl className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-caption text-text-muted">
          <div className="flex items-center gap-1.5">
            <dt className="text-micro uppercase tracking-wider text-text-dim">
              Steps hit
            </dt>
            <dd className="tabular-nums text-text">
              {grade.matchedSteps}/{grade.targetSteps}
            </dd>
          </div>
          <div className="flex items-center gap-1.5">
            <dt className="text-micro uppercase tracking-wider text-text-dim">
              Avg drift
            </dt>
            <dd className="tabular-nums text-text">{grade.avgDriftSec}s</dd>
          </div>
          <div className="flex items-center gap-1.5">
            <dt className="text-micro uppercase tracking-wider text-text-dim">
              Max drift
            </dt>
            <dd className="tabular-nums text-text">{grade.maxDriftSec}s</dd>
          </div>
        </dl>

        {grade.firstDivergence ? (
          <p className="text-caption text-text-muted">
            First divergence:{" "}
            <span className="font-medium text-text">
              {grade.firstDivergence.name}
            </span>{" "}
            — planned {clock(grade.firstDivergence.expectedT)},{" "}
            {grade.firstDivergence.actualT === null
              ? "never executed"
              : `executed ${clock(grade.firstDivergence.actualT)}`}
            .
          </p>
        ) : (
          <p className="text-caption text-text-muted">
            No divergence — the build survived contact with the ladder.
          </p>
        )}

        <div>
          <button
            type="button"
            onClick={() => setShowSteps((s) => !s)}
            aria-expanded={showSteps}
            className="inline-flex min-h-[32px] items-center gap-1 rounded text-caption font-medium text-text-muted hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {showSteps ? (
              <ChevronDown className="h-4 w-4" aria-hidden />
            ) : (
              <ChevronRight className="h-4 w-4" aria-hidden />
            )}
            Per-step breakdown
          </button>
          {showSteps ? (
            <ol className="mt-1 max-h-72 space-y-0.5 overflow-y-auto pr-1">
              {grade.perStep.map((step) => (
                <li
                  key={`${step.index}-${step.name}`}
                  className="flex items-center gap-2 rounded px-1 py-0.5 text-caption"
                >
                  <span className="w-11 flex-shrink-0 text-right font-mono text-micro tabular-nums text-text-dim">
                    {clock(step.expectedT)}
                  </span>
                  <span
                    className={`min-w-0 flex-1 truncate ${step.matched ? "text-text" : "text-text-dim line-through"}`}
                    title={step.name}
                  >
                    {step.supply !== null ? `${step.supply} ` : ""}
                    {step.name}
                  </span>
                  <span className="w-20 flex-shrink-0 text-right font-mono text-micro tabular-nums">
                    {step.driftSec === null ? (
                      <span className="text-danger">missed</span>
                    ) : (
                      <span
                        className={
                          Math.abs(step.driftSec) <= 5
                            ? "text-success"
                            : Math.abs(step.driftSec) <= 15
                              ? "text-warning"
                              : "text-danger"
                        }
                      >
                        {step.driftSec >= 0 ? "+" : ""}
                        {step.driftSec}s
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ol>
          ) : null}
        </div>

        <p className="text-caption text-text-dim">
          Grading against the armed target on this device.{" "}
          <button
            type="button"
            onClick={onDisarm}
            className="rounded text-text-muted underline underline-offset-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            Disarm
          </button>
        </p>
      </div>
    </Card>
  );
}

/**
 * "Arm this build" — the game-page arm affordance, rendered inside the
 * my-side build column. Turns THIS game's executed build log into the
 * Ghost Build target (fromBuildLog) so "play like that game again" is
 * one click.
 */
export function ArmGhostFromLogButton({
  name,
  lines,
}: {
  /** Display name for the target (my build label / map fallback). */
  name: string;
  /** Raw my-side ``[m:ss] Name`` lines. */
  lines: ReadonlyArray<string>;
}) {
  const toastCtx = useToastOptional();
  const [armed, setArmed] = useState(false);

  const onArm = () => {
    const target = fromBuildLog(name, lines);
    if (!target || !armGhostTarget(target)) {
      toastCtx?.toast.error("Couldn't arm this build", {
        description:
          "No timed steps were found in this build log (workers are excluded), or browser storage is unavailable.",
      });
      return;
    }
    window.dispatchEvent(new Event(GHOST_ARMED_EVENT));
    setArmed(true);
    window.setTimeout(() => setArmed(false), 1500);
    toastCtx?.toast.success(`Armed "${target.name}"`, {
      description: `${target.steps.length} timed steps. Copy the Ghost Build widget URL from Settings → Overlay — your next games get graded against it.`,
    });
  };

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onArm}
      iconLeft={<Crosshair className="h-4 w-4" aria-hidden />}
      title="Make this game's build the Ghost Build practice target"
    >
      {armed ? "Armed!" : "Arm this build"}
    </Button>
  );
}

function clock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
