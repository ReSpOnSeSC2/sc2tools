"use client";

import { useState, type MouseEvent } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { Download, Loader2 } from "lucide-react";
import { apiCall } from "@/lib/clientApi";
import { gaEvent } from "@/lib/analytics/gtag";

type DownloadResponse = { url: string; filename: string; expiresIn: number };

/**
 * Download the asker's replay file, when they chose to share it. Each click
 * asks the API for a fresh short-lived link (the asker can stop sharing at
 * any time), under a neutral file name. Signed-in players only.
 *
 * ``variant="page"`` is a labelled button for the review page header;
 * ``variant="card"`` is a compact icon for board cards.
 */
export function ReviewReplayDownload({
  requestId,
  requestUrl,
  variant,
  available = true,
}: {
  requestId: string;
  requestUrl: string;
  variant: "page" | "card";
  /** False while the asker's desktop agent hasn't backed the file up. */
  available?: boolean;
}) {
  const { getToken, isSignedIn } = useAuth();
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [message, setMessage] = useState("");

  const cls = variant === "card"
    ? "grid h-9 w-9 place-items-center rounded-full border-2 border-line bg-bg-surface text-text-muted transition-colors hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60"
    : "inline-flex min-h-9 items-center gap-1.5 rounded-full border-2 border-line bg-bg-surface px-3.5 text-caption font-semibold text-text transition-colors hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60";
  const label = "Download replay";

  if (!isSignedIn) {
    return (
      <Link
        href={`/sign-in?redirect_url=${encodeURIComponent(requestUrl)}`}
        onClick={(e) => e.stopPropagation()}
        className={cls}
        aria-label="Sign in to download the replay"
        title="Sign in to download the replay"
      >
        <Download className="h-4 w-4" aria-hidden />
        {variant === "page" ? <span>Sign in to download replay</span> : null}
      </Link>
    );
  }

  if (!available) {
    return variant === "page" ? (
      <button type="button" disabled className={cls} title="The asker's desktop agent hasn't uploaded this replay yet">
        <Download className="h-4 w-4" aria-hidden /> Replay not uploaded yet
      </button>
    ) : null;
  }

  async function download(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (state === "loading") return;
    setState("loading");
    setMessage("");
    try {
      const res = await apiCall<DownloadResponse>(getToken, `/v1/reviews/${encodeURIComponent(requestId)}/replay`);
      const href = safeSignedUrl(res.url);
      if (!href) throw new Error("The replay download link was invalid.");
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = safeFilename(res.filename, requestId);
      anchor.rel = "noopener noreferrer";
      anchor.referrerPolicy = "no-referrer";
      anchor.style.display = "none";
      document.body.appendChild(anchor);
      try {
        anchor.click();
      } finally {
        anchor.remove();
      }
      gaEvent("review_replay_download");
      setState("idle");
    } catch (err) {
      setMessage((err as { message?: string })?.message || "Couldn't download the replay.");
      setState("error");
    }
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={(e) => void download(e)}
        disabled={state === "loading"}
        className={cls}
        aria-label={label}
        title={label}
      >
        {state === "loading" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Download className="h-4 w-4" aria-hidden />}
        {variant === "page" ? <span>{label}</span> : null}
      </button>
      {state === "error" && variant === "page" ? <span role="status" className="text-micro text-danger">{message}</span> : null}
    </span>
  );
}

export function safeSignedUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function safeFilename(value: unknown, requestId: string): string {
  const raw = typeof value === "string" ? value : `sc2tools-review-${requestId}`;
  const clean = raw
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\.SC2Replay$/i, "")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 160);
  return `${clean || "sc2tools-review"}.SC2Replay`;
}
