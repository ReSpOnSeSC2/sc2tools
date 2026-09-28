"use client";

/**
 * TryUploadStatus — what saving /try games to an account is doing right
 * now: loading the stored games, a determinate upload bar (checking →
 * uploading → waiting for a busy server), success, or why it stopped
 * (today's cap, an expired sign-in, a busy server with Retry, or games
 * the server refused). A polite live region announces each change.
 *
 * Example:
 *   <TryUploadStatus state={upload.state} onRetry={() => void upload.retry()} />
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui";
import { TRY_SIGN_IN_HREF } from "@/lib/instant/authRedirect";
import { percentOf, secondsUntilRetry, uploadsResumeText } from "@/lib/instant/displayUnits";
import { TRY_TTL_DAYS } from "@/lib/instant/localStore";
import type { UploadProgress } from "@/lib/instant/uploader";
import type { TryUploadState, TryUploadStop } from "../TryResume";
import { gamesLabel } from "./ReportBits";

const LINK_CLASS = [
  "inline-flex min-h-[44px] items-center font-semibold text-accent underline-offset-4 hover:underline",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
].join(" ");

/**
 * Label for one upload progress sample (games already in the account
 * count as saved).
 *
 * Example:
 *   uploadProgressLabel({ phase: "uploading", accepted: 2, settled: 3, total: 5 }); // -> "Saving games… 3 of 5"
 */
export function uploadProgressLabel(progress: UploadProgress | null): string {
  if (!progress || progress.phase === "checking") return "Checking which games your account already has…";
  if (progress.phase === "waiting") {
    return `Our servers are busy — trying again in ${secondsUntilRetry(progress.retryInMs)} s…`;
  }
  if (progress.phase === "done") return "Finishing up…";
  return `Saving games… ${progress.settled} of ${progress.total}`;
}

function UploadBar({ progress }: { progress: UploadProgress | null }) {
  const total = Math.max(1, progress?.total ?? 1);
  const done = Math.min(progress?.settled ?? 0, total);
  const label = uploadProgressLabel(progress);
  return (
    <div className="space-y-2">
      <p className="text-body font-semibold text-text">{label}</p>
      <div
        role="progressbar"
        aria-label="Saving games"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        className="h-3 overflow-hidden rounded-full border-2 border-line bg-bg-elevated"
      >
        <div
          className="h-full bg-accent transition-[width] duration-150 motion-reduce:transition-none"
          style={{ width: `${percentOf(done, total)}%` }}
        />
      </div>
    </div>
  );
}

type StoppedState = Extract<TryUploadState, { status: "stopped" }>;

function capBody({ accepted, pending, resetAt }: StoppedState): string {
  const resume = uploadsResumeText(resetAt) ?? "Come back tomorrow to save them.";
  return `Saved ${gamesLabel(accepted)}. The other ${gamesLabel(pending)} stay on this device for up to ${TRY_TTL_DAYS} days. ${resume}`;
}

function StopMessage({ state, onRetry }: { state: StoppedState; onRetry: () => void }) {
  const { reason, pending } = state;
  const copy: Record<TryUploadStop, { title: string; body: string; action: ReactNode }> = {
    daily_cap: {
      title: "You've reached today's upload limit",
      body: capBody(state),
      action: <Link href="/app" className={LINK_CLASS}>Open your dashboard</Link>,
    },
    auth: {
      title: "Your sign-in expired",
      body: "Sign in again and we'll pick up the games stored on this device.",
      action: <Link href={TRY_SIGN_IN_HREF} className={LINK_CLASS}>Sign in again</Link>,
    },
    server: {
      title: "Our servers are busy right now",
      body: "Your games are still on this device. Try again in a moment.",
      action: <Button variant="secondary" onClick={onRetry}>Try again</Button>,
    },
    rejected: {
      title: "We couldn't save these games",
      body: `The server didn't accept ${gamesLabel(pending)}. They're still on this device; the desktop agent can import the replays instead.`,
      action: <Link href="/download" className={LINK_CLASS}>Get the desktop agent</Link>,
    },
  };
  const { title, body, action } = copy[reason];
  return (
    <div className="space-y-2">
      <p className="flex items-start gap-2 text-body font-semibold text-text">
        <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-warning" aria-hidden />
        {title}
      </p>
      <p className="text-caption text-text-muted">{body}</p>
      <div>{action}</div>
    </div>
  );
}

function StatusBody({ state, onRetry }: { state: TryUploadState; onRetry: () => void }) {
  switch (state.status) {
    case "idle":
      return null;
    case "loading":
      return <p className="text-body font-semibold text-text">Loading the games saved on this device…</p>;
    case "empty":
      return (
        <p className="text-body text-text-muted">
          {state.reason === "storage"
            ? "This browser isn't letting us read the games stored here. Analyze your replays again below to save them."
            : `No games from this page are stored on this device — they're kept for ${TRY_TTL_DAYS} days in the browser you used. Analyze some replays below to save them.`}
        </p>
      );
    case "uploading":
      return <UploadBar progress={state.progress} />;
    case "done":
      return (
        <p className="flex items-center gap-2 text-body font-semibold text-text">
          <CheckCircle2 className="h-5 w-5 flex-shrink-0 text-success" aria-hidden />
          Saved! Taking you to your dashboard…
        </p>
      );
    case "stopped":
      return <StopMessage state={state} onRetry={onRetry} />;
  }
}

export interface TryUploadStatusProps {
  state: TryUploadState;
  onRetry: () => void;
}

/**
 * Live status of the /try save (see module comment).
 *
 * Example:
 *   <TryUploadStatus state={{ status: "loading" }} onRetry={retry} />
 */
export function TryUploadStatus({ state, onRetry }: TryUploadStatusProps) {
  return (
    <div role="status" aria-live="polite">
      <StatusBody state={state} onRetry={onRetry} />
    </div>
  );
}
