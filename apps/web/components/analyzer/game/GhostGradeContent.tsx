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

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Crosshair } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useArmGhostTarget } from "./useArmGhostTarget";
export { GHOST_ARMED_EVENT } from "./useArmGhostTarget";
import Link from "next/link";
import { ghostMatchupKey, selectGhostTarget } from "@/lib/ghostBuild";
import { useGhostPractice } from "@/lib/useGhostPractice";
import { useApi } from "@/lib/clientApi";
import type { StoredPractice } from "@/lib/practiceLog";
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

type GhostGradeProps = {
  gameId?: string;
  /** Raw my-side ``[m:ss] Name`` lines for THIS game. */
  buildLog: ReadonlyArray<string> | null;
  myRace?: string | null;
  opponentRace?: string | null;
};
type Practice = ReturnType<typeof useGhostPractice>;

/**
 * The grade stored when the game uploaded (the practice log) wins over a
 * live grade against today's target: it was graded against the target armed
 * when the game was played. Accounts that never used Ghost make no request.
 */
export function GhostGradeCard(props: GhostGradeProps) {
  const practice = useGhostPractice();
  const target = selectGhostTarget(practice.config, props.myRace, props.opponentRace);
  const isSource = Boolean(target && props.gameId && target.sourceGameId === props.gameId);
  const stored = Boolean(props.gameId && !isSource && practice.hasConfig && ghostMatchupKey(props.myRace, props.opponentRace));
  return stored ? <StoredFirstGrade {...props} practice={practice} /> : <LiveGhostGrade {...props} practice={practice} />;
}

function StoredFirstGrade(props: GhostGradeProps & { practice: Practice }) {
  const record = useApi<{ practice: StoredPractice | null }>(`/v1/practice/games/${encodeURIComponent(props.gameId!)}`, { revalidateOnFocus: false, shouldRetryOnError: false });
  const stored = record.data?.practice;
  if (stored?.grade) return <StoredGradeCard stored={stored} />;
  // Wait briefly for the stored answer rather than flashing a live grade first.
  if (record.data === undefined && !record.error) return null;
  return <LiveGhostGrade {...props} />;
}

function StoredGradeCard({ stored }: { stored: StoredPractice }) {
  const grade = stored.grade!;
  return (
    <Card title="Ghost Build grade" data-testid="ghost-grade-card">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className={`font-display text-5xl font-bold leading-none ${GRADE_CLASS[grade]}`} aria-label={`Grade ${grade}`}>{grade}</span>
          <div className="min-w-0">
            <p className="truncate text-body font-medium text-text" title={stored.targetName}>vs {stored.targetName}</p>
            <p className="text-caption text-text-muted">{GRADE_HINT[grade]}</p>
          </div>
        </div>
        <dl className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-caption text-text-muted">
          <div className="flex items-center gap-1.5"><dt className="text-micro uppercase tracking-wider text-text-dim">Steps hit</dt><dd className="tabular-nums text-text">{stored.matched}/{stored.total}</dd></div>
          <div className="flex items-center gap-1.5"><dt className="text-micro uppercase tracking-wider text-text-dim">Avg drift</dt><dd className="tabular-nums text-text">{stored.avgDrift}s</dd></div>
          <div className="flex items-center gap-1.5"><dt className="text-micro uppercase tracking-wider text-text-dim">Max drift</dt><dd className="tabular-nums text-text">{stored.maxDrift}s</dd></div>
        </dl>
        <p className="text-caption text-text-muted">
          {stored.firstDivergence
            ? <>First divergence: <span className="font-medium text-text">{stored.firstDivergence.name}</span> — planned {clock(stored.firstDivergence.expectedT)}, {stored.firstDivergence.actualT === null ? "never executed" : `executed ${clock(stored.firstDivergence.actualT)}`}.</>
            : "No divergence — the build survived contact with the ladder."}
        </p>
        {stored.worstSteps?.length ? (
          <ul className="space-y-0.5 text-caption" aria-label="Steps furthest off the plan">
            {stored.worstSteps.map((step) => (
              <li key={step.i} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-text">{step.name ?? `Step ${step.i + 1}`}</span>
                <span className="font-mono text-micro tabular-nums">{step.d === null ? <span className="text-danger">missed</span> : `${step.d >= 0 ? "+" : ""}${step.d}s`}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <p className="text-caption text-text-dim">
          {stored.via === "request" ? "Graded on request against your practice target." : "Graded when this game uploaded, against the target armed at the time."}{" "}
          <Link href="/practice" className="text-text-muted underline underline-offset-2 hover:text-text">Open your practice log</Link>
        </p>
      </div>
    </Card>
  );
}

function LiveGhostGrade({
  gameId, buildLog,
  myRace,
  opponentRace,
  practice,
}: GhostGradeProps & { practice: Practice }) {
  const target = selectGhostTarget(practice.config, myRace, opponentRace);
  const [showSteps, setShowSteps] = useState(false);
  const grade = useMemo<GhostGradeResult | null>(() => {
    if (!target || (gameId && target.sourceGameId === gameId) || !buildLog || buildLog.length === 0) return null;
    return gradeExecution(target, buildLog);
  }, [target, buildLog, gameId]);

  const onDisarm = () => {
    const matchup = ghostMatchupKey(myRace, opponentRace);
    if (matchup) void practice.assign(matchup, null, target);
  };

  if (target && gameId && target.sourceGameId === gameId) return <Card title="Ghost Build target">
    <p>This game is your armed {ghostMatchupKey(myRace, opponentRace)} target. Your next {ghostMatchupKey(myRace, opponentRace)} games will be graded against it.</p>
    <Button variant="ghost" disabled={practice.saving || !!practice.readError} onClick={onDisarm}>Disarm</Button>
    {practice.error ? <p role="alert" className="text-caption text-danger">{practice.error}</p> : null}
  </Card>;
  if (!target || !grade) return null;

  return (
    <Card title="Ghost Build grade" data-testid="ghost-grade-card">
      <div className="space-y-3">
        {practice.offline ? <p className="text-caption text-warning">Graded against this account’s cached target; account refresh is unavailable.</p> : null}
        {practice.error ? <p role="alert" className="text-caption text-danger">{practice.error}</p> : null}
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
            className="inline-flex min-h-[44px] items-center gap-1 rounded text-caption font-medium text-text-muted hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
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
          Grading against your account&apos;s assigned target.{" "}
          <button
            type="button"
            onClick={onDisarm} disabled={practice.saving || !!practice.readError}
            className="rounded text-text-muted underline underline-offset-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            Clear {ghostMatchupKey(myRace, opponentRace) ?? "matchup"}
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
export function ArmGhostFromLogButton(props: {
  name: string; lines: ReadonlyArray<string>; myRace?: string | null; opponentRace?: string | null; gameId?: string; className?: string;
}) {
  const ghost = useArmGhostTarget(props);
  const random = ["r", "random"].includes((props.opponentRace || "").toLowerCase());
  return <>
    <Button variant="ghost" size="sm" className={props.className} onClick={ghost.armed ? ghost.disarm : ghost.arm}
      aria-label={ghost.armed ? `Armed for ${ghost.matchup} · Disarm` : ghost.matchup ? "Use as Ghost Build target" : undefined}
      disabled={!ghost.matchup || !ghost.signedIn || ghost.saving || ghost.loading} iconLeft={<Crosshair className="h-4 w-4" aria-hidden />}
      title={random ? "Ghost Build is disabled against Random opponents" : ghost.matchup
        ? `Your next ${ghost.matchup} games are graded against this build, and the Ghost Build overlay shows its steps while you play.`
        : "Ghost Build requires two concrete races"}>
      {ghost.armed ? `Armed for ${ghost.matchup} · Disarm` : !ghost.matchup
        ? random ? "No build vs Random" : "Matchup unavailable"
        : <><span className="hidden sm:inline">Use as Ghost Build target</span><span className="sm:hidden">Ghost target</span></>}
    </Button>
    {ghost.error ? <span role="alert" className="text-caption text-danger">{ghost.error} <button className="min-h-11 px-2 underline" onClick={ghost.retry}>Try again</button></span> : null}
    <ConfirmDialog open={!!ghost.replacement} onClose={ghost.cancel} onConfirm={ghost.confirm}
      title={`Replace “${ghost.replacement?.name || ""}” with this game's build?`}
      description="Later games in this matchup will use the new target. You can undo this from the confirmation toast."
      confirmLabel="Replace target" />
  </>;
}

function clock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
