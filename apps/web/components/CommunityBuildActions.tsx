"use client";

import { useState } from "react";
import { SignedIn, SignedOut, useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { apiCall } from "@/lib/clientApi";

export function CommunityBuildActions({ slug }: { slug: string }) {
  const { getToken } = useAuth();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function vote(delta: 1 | -1) {
    setBusy(true);
    setMsg(null);
    try {
      await apiCall(getToken, `/v1/community/builds/${slug}/vote`, {
        method: "POST",
        body: JSON.stringify({ delta }),
      });
      setMsg("Vote recorded.");
    } catch (err: any) {
      setMsg(err?.message || "Could not vote.");
    } finally {
      setBusy(false);
    }
  }

  async function report() {
    const reason = window.prompt(
      "What's wrong with this build? (e.g. spam, harassment, broken steps)",
    );
    if (!reason) return;
    setBusy(true);
    setMsg(null);
    try {
      await apiCall(getToken, "/v1/community/reports", {
        method: "POST",
        body: JSON.stringify({
          targetType: "build",
          targetId: slug,
          reason: reason.slice(0, 80),
        }),
      });
      setMsg("Reported. A moderator will review.");
    } catch (err: any) {
      setMsg(err?.message || "Could not report.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-2">
      <SignedIn>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <button
            type="button"
            className="btn btn-secondary text-sm"
            onClick={() => vote(1)}
            disabled={busy}
          >
            ▲ Upvote
          </button>
          <button
            type="button"
            className="btn btn-secondary text-sm"
            onClick={() => vote(-1)}
            disabled={busy}
          >
            ▼ Downvote
          </button>
          <button
            type="button"
            className="btn btn-secondary text-sm"
            onClick={report}
            disabled={busy}
          >
            Report
          </button>
        </div>
      </SignedIn>
      <SignedOut>
        <p className="text-sm text-text-muted">
          <Link href="/sign-in" className="underline">
            Sign in
          </Link>{" "}
          to vote or report.
        </p>
      </SignedOut>
      {msg && <p className="text-xs text-text-muted">{msg}</p>}
    </section>
  );
}
