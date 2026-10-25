"use client";
import { useState } from "react";
import { CalendarDays, Gamepad2, Target, XCircle } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { cadenceNoun, formatWindow, progressStateLabel, requirementDetail, requirementTitle, statePill, type PracticeAssignment } from "./coachingPracticeModel";
import { ReplayEvidence } from "./ReplayEvidence";
import { PracticePeriodStrip } from "./PracticePeriodStrip";
export function AssignmentCard({
  assignment,
  canManage,
  onCancel,
  onAssignAgain,
  now,
}: {
  assignment: PracticeAssignment;
  canManage: boolean;
  onCancel: () => void;
  onAssignAgain: () => void;
  now: number;
}) {
  const progress = assignment.progress;
  const [selected, setSelected] = useState<string>();
  const bucket = progress.buckets.find(item => item.key === selected) || progress.currentBucket
    || (progress.state === "met" || progress.state === "missed"
      ? progress.buckets.at(-1)
      : progress.buckets[0])
    || null;
  const played = bucket?.playedGames ?? progress.playedGames;
  const required = bucket?.requiredGames
    ?? (progress.requiredGamesTotal || assignment.requirement.requiredGames);
  const percentage = required > 0 ? Math.min(100, (played / required) * 100) : 0;
  const recurring = assignment.requirement.recurrence !== "once";
  const title = assignment.requirement.title?.trim() || requirementTitle(assignment);
  const status = progressStateLabel(progress.state);
  const remaining = Math.max(0, required - played);
  const past = !!bucket && Date.parse(bucket.endsAt) <= now;
  const targetCopy = progress.state === "cancelled"
    ? (played > 0 ? `${played} recorded before cancellation` : "No games counted")
    : remaining === 0
      ? "Target reached"
      : past ? `${remaining} short of target` : `${remaining} to go`;
  const cancellable = assignment.status === "active"
    && (progress.state === "active" || progress.state === "upcoming");

  return (
    <Card className="flex min-h-full flex-col" padded={false}>
      <div className="flex flex-1 flex-col p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className={statePill(progress.state)}>{status}</span>
              {canManage ? (
                <span className="text-micro font-bold uppercase tracking-wider text-text-dim">
                  {assignment.student.name}
                </span>
              ) : null}
            </div>
            <h3 className="mt-2 font-display text-h4 font-extrabold text-text">{title}</h3>
            <p className="mt-1 text-caption text-text-muted">{requirementDetail(assignment)}</p>
          </div>
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-border bg-bg-elevated text-accent-cyan">
            {assignment.requirement.type === "build"
              ? <Target className="h-5 w-5" aria-hidden />
              : <Gamepad2 className="h-5 w-5" aria-hidden />}
          </span>
        </div>
        <PracticePeriodStrip assignment={assignment} now={now} selected={selected} onSelect={setSelected} />

        <div className="mt-5 rounded-xl border border-border bg-bg-elevated/45 p-4">
          <div className="flex items-end justify-between gap-3">
            <div>
              <p className="text-micro font-bold uppercase tracking-wider text-text-dim">
                {recurring ? `${selected ? "Selected" : "This"} ${cadenceNoun(assignment.requirement.recurrence)}` : "Progress"}
              </p>
              <p className="mt-1 font-display text-h3 font-extrabold tabular-nums text-text">
                {played}<span className="text-body text-text-muted"> / {required}</span>
              </p>
            </div>
            <p className="text-right text-caption font-bold text-text-muted">
              {targetCopy}
            </p>
          </div>
          <div
            className="mt-3 h-2 overflow-hidden rounded-full bg-bg-subtle"
            role="progressbar"
            aria-label={`${title}${canManage ? ` for ${assignment.student.name}` : ""}: ${played} of ${required} games`}
            aria-valuemin={0}
            aria-valuemax={required}
            aria-valuenow={Math.min(played, required)}
          >
            <div
              className={[
                "h-full rounded-full transition-[width]",
                played >= required ? "bg-success" : "bg-accent-cyan",
              ].join(" ")}
              style={{ width: `${percentage}%` }}
            />
          </div>
          {recurring ? (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-micro text-text-dim">
              <span>{progress.completedBuckets} of {progress.totalBuckets} periods complete</span>
              {bucket ? <span>{formatWindow(bucket.startsAt, bucket.endsAt, assignment.requirement.timeZone)}</span> : null}
            </div>
          ) : null}
        </div>

        <div className="mt-4 flex items-start gap-2 text-caption text-text-muted">
          <CalendarDays className="mt-0.5 h-4 w-4 shrink-0 text-text-dim" aria-hidden />
          <span>{formatWindow(assignment.requirement.window.startsAt, assignment.requirement.window.endsAt, assignment.requirement.timeZone)}</span>
        </div>
        {assignment.requirement.note ? <p className="mt-3 text-caption text-text-muted">{assignment.requirement.note}</p> : null}

        <ReplayEvidence assignment={assignment} />
      </div>
      {canManage ? (
        <div className="flex flex-wrap justify-end gap-2 border-t border-border bg-bg-elevated/30 px-5 py-3">
          <Button variant="secondary" size="sm" className="min-h-11" onClick={onAssignAgain}>Assign again</Button>
          {cancellable ? <Button variant="ghost" size="sm" className="min-h-11" onClick={onCancel} iconLeft={<XCircle className="h-4 w-4" />}>
            Cancel plan
          </Button> : null}
        </div>
      ) : null}
    </Card>
  );
}

