"use client";

import { useState } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { Award, GraduationCap, ShieldCheck, ShieldQuestion } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { apiCall } from "@/lib/clientApi";
import { gaEvent } from "@/lib/analytics/gtag";
import { verifiedLabel, type ReviewCommentAuthor } from "@/lib/reviews";

/**
 * Who wrote a review: the league band + race VERIFIED from the
 * reviewer's own synced ladder games (never self-reported; "Unverified"
 * otherwise), their karma badges and flair, and the Coaching Locker
 * "Coach" badge with its lesson entry point.
 */
export function ReviewerBadges({
  author,
  requestId,
}: {
  author: ReviewCommentAuthor;
  requestId: string;
}) {
  if (author.isAsker) {
    return <Badge variant="accent" size="sm">Asker</Badge>;
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {author.verified ? (
        <Badge variant="cyan" size="sm" iconLeft={<ShieldCheck className="h-3 w-3" aria-hidden />} title="Verified from this reviewer's own ladder games">
          {verifiedLabel(author.verified)}
        </Badge>
      ) : (
        <Badge variant="neutral" size="sm" iconLeft={<ShieldQuestion className="h-3 w-3" aria-hidden />} title="No verified ladder band yet">
          Unverified
        </Badge>
      )}
      {author.flair ? (
        <Badge variant="signal" size="sm" iconLeft={<Award className="h-3 w-3" aria-hidden />}>{author.flair}</Badge>
      ) : null}
      {author.badges
        .filter((b) => !(author.flair && b.key === "mentor"))
        .slice(-2)
        .map((b) => (
          <Badge key={b.key} variant="neutral" size="sm">{b.label}</Badge>
        ))}
      {author.coach ? <CoachBadge coach={author.coach} name={author.label} requestId={requestId} /> : null}
    </span>
  );
}

function CoachBadge({
  coach,
  name,
  requestId,
}: {
  coach: NonNullable<ReviewCommentAuthor["coach"]>;
  name: string;
  requestId: string;
}) {
  const { getToken, isSignedIn } = useAuth();
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [message, setMessage] = useState("");

  async function requestLesson() {
    setState("sending");
    try {
      const res = await apiCall<{ status: string; href?: string }>(
        getToken,
        `/v1/reviews/coaches/${encodeURIComponent(coach.coachId)}/lesson-request`,
        { method: "POST", body: JSON.stringify({ requestId }) },
      );
      if (res.status === "student" && res.href) {
        window.location.assign(res.href);
        return;
      }
      setState("sent");
      setMessage(`${name} has your lesson request.`);
      gaEvent("review_lesson_request");
    } catch (err) {
      setState("error");
      setMessage((err as { message?: string })?.message || "Couldn't send the request.");
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Badge variant="success" size="sm" iconLeft={<GraduationCap className="h-3 w-3" aria-hidden />}>Coach</Badge>
      {coach.bookable ? (
        coach.isViewersCoach ? (
          <Link href="/coaching?view=schedule" className="text-caption font-semibold text-accent-cyan underline underline-offset-2 hover:text-accent">
            Book a lesson
          </Link>
        ) : isSignedIn ? (
          state === "sent" || state === "error" ? (
            <span role="status" className={`text-caption ${state === "error" ? "text-danger" : "text-success"}`}>{message}</span>
          ) : (
            <button
              type="button"
              disabled={state === "sending"}
              onClick={() => void requestLesson()}
              className="text-caption font-semibold text-accent-cyan underline underline-offset-2 hover:text-accent disabled:opacity-60"
            >
              {state === "sending" ? "Sending…" : "Book a lesson"}
            </button>
          )
        ) : (
          <Link href="/sign-in" className="text-caption font-semibold text-accent-cyan underline underline-offset-2">
            Book a lesson
          </Link>
        )
      ) : null}
    </span>
  );
}
