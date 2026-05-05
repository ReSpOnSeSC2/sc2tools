"use client";

import { useState } from "react";
import { SignedIn, SignedOut, useAuth } from "@clerk/nextjs";
import Link from "next/link";
import {
  AlertOctagon,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { apiCall } from "@/lib/clientApi";

export interface CommunityVotePanelProps {
  slug: string;
  /** Current cached vote count from the server. */
  initialVotes: number;
}

/**
 * CommunityVotePanel — sidebar widget combining up/down vote + report.
 *
 * Renders inline status messages instead of relying on window.prompt
 * for reporting — uses a small popover textarea so the action stays
 * accessible on touch.
 */
export function CommunityVotePanel({
  slug,
  initialVotes,
}: CommunityVotePanelProps) {
  const { getToken } = useAuth();
  const [votes, setVotes] = useState(initialVotes);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<"up" | "down" | "report" | null>(
    null,
  );
  const [status, setStatus] = useState<string | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportReason, setReportReason] = useState("");

  async function vote(delta: 1 | -1) {
    if (busy) return;
    setBusy(true);
    setPending(delta === 1 ? "up" : "down");
    setStatus(null);
    try {
      await apiCall(
        getToken,
        `/v1/community/builds/${encodeURIComponent(slug)}/vote`,
        {
          method: "POST",
          body: JSON.stringify({ delta }),
        },
      );
      // Optimistic — server has the authoritative count which we
      // display the next refresh, but a +/-1 nudge keeps the UI
      // responsive without a re-fetch.
      setVotes((v) => v + delta);
      setStatus(delta === 1 ? "Upvoted." : "Downvoted.");
    } catch (err: unknown) {
      const message =
        err && typeof err === "object" && "message" in err
          ? String((err as { message: unknown }).message)
          : "Couldn't vote.";
      setStatus(message);
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  async function submitReport() {
    const reason = reportReason.trim();
    if (!reason) {
      setStatus("Add a short reason for the report.");
      return;
    }
    setBusy(true);
    setPending("report");
    setStatus(null);
    try {
      await apiCall(getToken, "/v1/community/reports", {
        method: "POST",
        body: JSON.stringify({
          targetType: "build",
          targetId: slug,
          reason: reason.slice(0, 80),
        }),
      });
      setReportReason("");
      setReportOpen(false);
      setStatus("Reported. A moderator will review.");
    } catch (err: unknown) {
      const message =
        err && typeof err === "object" && "message" in err
          ? String((err as { message: unknown }).message)
          : "Couldn't report.";
      setStatus(message);
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  const tone =
    votes > 0 ? "text-success" : votes < 0 ? "text-danger" : "text-text";

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-medium uppercase tracking-wider text-text-dim">
          Community votes
        </span>
        <span
          className={[
            "font-mono text-h3 font-semibold tabular-nums",
            tone,
          ].join(" ")}
          aria-label={`${votes} net votes`}
        >
          {votes > 0 ? "+" : ""}
          {votes}
        </span>
      </div>
      <SignedIn>
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="secondary"
            size="md"
            onClick={() => vote(1)}
            disabled={busy}
            loading={pending === "up"}
            iconLeft={<ChevronUp className="h-4 w-4" aria-hidden />}
            aria-label="Upvote build"
          >
            Upvote
          </Button>
          <Button
            variant="secondary"
            size="md"
            onClick={() => vote(-1)}
            disabled={busy}
            loading={pending === "down"}
            iconLeft={<ChevronDown className="h-4 w-4" aria-hidden />}
            aria-label="Downvote build"
          >
            Downvote
          </Button>
        </div>
        {reportOpen ? (
          <div className="space-y-2 rounded-lg border border-warning/30 bg-warning/8 p-3">
            <label
              htmlFor="report-reason"
              className="block text-caption font-medium text-text"
            >
              Report this build
            </label>
            <textarea
              id="report-reason"
              value={reportReason}
              onChange={(e) => setReportReason(e.target.value)}
              rows={3}
              maxLength={80}
              placeholder="Spam, harassment, broken steps…"
              className="block w-full rounded-md border border-border bg-bg-elevated p-2 text-caption text-text placeholder:text-text-dim focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/40"
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setReportOpen(false);
                  setReportReason("");
                }}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={submitReport}
                loading={pending === "report"}
                disabled={busy}
              >
                Submit report
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setStatus(null);
              setReportOpen(true);
            }}
            iconLeft={<AlertOctagon className="h-4 w-4" aria-hidden />}
            fullWidth
          >
            Report
          </Button>
        )}
      </SignedIn>
      <SignedOut>
        <p className="rounded-lg border border-border bg-bg-elevated p-3 text-caption text-text-muted">
          <Link
            href="/sign-in"
            className="font-semibold text-accent-cyan underline-offset-2 hover:underline"
          >
            Sign in
          </Link>{" "}
          to vote, save to your library, or report a build.
        </p>
      </SignedOut>
      {status ? (
        <p
          role="status"
          className="inline-flex items-center gap-1.5 text-caption text-text-muted"
        >
          <CheckCircle2 className="h-4 w-4 text-accent-cyan" aria-hidden />
          {status}
        </p>
      ) : null}
    </div>
  );
}
