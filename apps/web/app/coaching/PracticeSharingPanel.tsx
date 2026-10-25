"use client";
import { CheckCircle2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import type { PracticeSharingRelationship, Student } from "./coachingPracticeModel";
export function PracticeSharingPanel({
  canManage,
  relationship,
  selectedStudent,
  busy,
  onRequest,
  onRespond,
  onRevoke,
}: {
  canManage: boolean;
  relationship: PracticeSharingRelationship | null;
  selectedStudent: Student | null;
  busy: boolean;
  onRequest: () => void;
  onRespond: (decision: "accepted" | "rejected") => void;
  onRevoke: () => void;
}) {
  if (canManage) {
    if (!selectedStudent?.userId) return null;
    const accepted = relationship?.status === "accepted";
    const waiting = relationship?.status === "pending" && Boolean(relationship.requestedAt);
    return (
      <Card className={accepted ? "border-success/35 bg-success/5" : "border-accent/30 bg-accent/5"}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            {accepted ? (
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" aria-hidden />
            ) : (
              <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-accent-cyan" aria-hidden />
            )}
            <div>
              <p className="font-display text-caption font-extrabold text-text">
                {accepted
                  ? `${selectedStudent.name} approved practice sharing`
                  : waiting
                    ? `Waiting for ${selectedStudent.name}`
                    : `${selectedStudent.name}'s approval is required`}
              </p>
              <p className="mt-0.5 text-caption text-text-muted">
                {accepted
                  ? "You can assign plans, review qualifying 1v1 details, and download their archived original replays."
                  : waiting
                    ? "They can accept or decline the request from their Coaching page."
                    : "Send a clear, revocable request before assigning games or opening replay evidence."}
              </p>
            </div>
          </div>
          {!accepted ? (
            <Button
              size="sm"
              variant={waiting ? "secondary" : "primary"}
              onClick={onRequest}
              loading={busy}
              disabled={waiting}
            >
              {waiting ? "Request sent" : "Request approval"}
            </Button>
          ) : null}
        </div>
      </Card>
    );
  }

  if (!relationship) return null;
  if (relationship.status === "pending") {
    return (
      <Card variant="feature" className="border-accent/40">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <ShieldCheck className="mt-0.5 h-6 w-6 shrink-0 text-accent-cyan" aria-hidden />
            <div>
              <p className="font-display text-h4 font-extrabold text-text">
                Review practice sharing with {relationship.coach.name}
              </p>
              <p className="mt-1 max-w-2xl text-caption text-text-muted">
                Allowing access lets your coach assign targets, see each qualifying future
                ladder or custom 1v1 game’s map, opponent, result, and detected build,
                and download its archived original replay. You can revoke access anytime.
              </p>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button variant="secondary" disabled={busy} onClick={() => onRespond("rejected")}>
              Not now
            </Button>
            <Button loading={busy} onClick={() => onRespond("accepted")}>
              Allow sharing
            </Button>
          </div>
        </div>
      </Card>
    );
  }

  if (relationship.status === "accepted") {
    return (
      <Card className="border-success/35 bg-success/5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" aria-hidden />
            <div>
              <p className="font-display text-caption font-extrabold text-text">Practice sharing is on</p>
              <p className="mt-0.5 text-caption text-text-muted">
                {relationship.coach.name} can review qualifying assignment evidence and archived replays.
              </p>
            </div>
          </div>
          <Button variant="ghost" size="sm" disabled={busy} onClick={onRevoke}>
            Revoke access
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card className="border-border bg-bg-elevated/30">
      <div className="flex items-start gap-3">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-text-dim" aria-hidden />
        <div>
          <p className="font-display text-caption font-extrabold text-text">Practice sharing is off</p>
          <p className="mt-0.5 text-caption text-text-muted">
            {relationship.coach.name} cannot open assignment evidence or archived replays.
            They can send you a new request if you want to enable it later.
          </p>
        </div>
      </div>
    </Card>
  );
}

