"use client";

import { useEffect, useState, type MouseEvent } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { Download, Loader2 } from "lucide-react";
import { apiCall, useOwnerRequestScope } from "@/lib/clientApi";
import { gaEvent } from "@/lib/analytics/gtag";
import { signInHref } from "@/lib/authLinks";

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
  contextLabel,
}: {
  requestId: string;
  requestUrl: string;
  variant: "page" | "card";
  /** False while the asker's desktop agent hasn't backed the file up. */
  available?: boolean;
  /** Card only: what the icon belongs to, for its accessible name. */
  contextLabel?: string;
}) {
  const { getToken, isLoaded, isSignedIn, userId } = useAuth();
  const owner = isLoaded && isSignedIn && userId ? userId : null;
  const scopeId = owner ? JSON.stringify([owner, requestId]) : null;
  const runOwned = useOwnerRequestScope(scopeId, getToken);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [message, setMessage] = useState("");
  useEffect(() => { setState("idle"); setMessage(""); }, [scopeId]);

  const cls = variant === "card"
    ? "grid h-9 w-9 place-items-center rounded-full border-2 border-line bg-bg-surface text-text-muted transition-colors hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60"
    : "inline-flex min-h-9 min-w-0 max-w-full items-center gap-1.5 rounded-full border-2 border-line bg-bg-surface px-3.5 text-caption font-semibold text-text transition-colors hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60";
  const suffix = variant === "card" && contextLabel ? `: ${contextLabel}` : "";
  const label = `Download replay${suffix}`;

  if (!owner) {
    // The page variant's visible text is its accessible name (label in name).
    const signIn = `Sign in to download replay${suffix}`;
    return (
      <Link
        href={signInHref(requestUrl)}
        onClick={(e) => e.stopPropagation()}
        className={cls}
        aria-label={variant === "card" ? signIn : undefined}
        title={signIn}
      >
        <Download className="h-4 w-4 shrink-0" aria-hidden />
        {variant === "page" ? <span className="min-w-0">Sign in to download replay</span> : null}
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
    if (state === "loading" || !scopeId) return;
    setState("loading");
    setMessage("");
    try {
      await runOwned(scopeId, async (scopedToken, signal, assertCurrent) => {
        try {
          const res = await apiCall<DownloadResponse>(scopedToken, `/v1/reviews/${encodeURIComponent(requestId)}/replay`, { signal });
          // A DOM download outlives React, so fence it inside the owned operation.
          assertCurrent();
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
          // A late failure belongs to the retired account/replay as well.
          assertCurrent();
          setMessage((err as { message?: string })?.message || "Couldn't download the replay.");
          setState("error");
        }
      });
    } catch {
      // The owned operation handles current failures; retirement is silent.
    }
  }
  return (
    <span className="inline-flex min-w-0 flex-col items-start gap-1">
      <button
        type="button"
        onClick={(e) => void download(e)}
        disabled={state === "loading"}
        className={`${cls} ${state === "error" ? "border-danger text-danger" : ""}`}
        aria-label={variant === "card" ? (state === "error" ? `${label} — ${message}` : label) : undefined}
        title={state === "error" ? message : label}
      >
        {state === "loading" ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden /> : <Download className="h-4 w-4 shrink-0" aria-hidden />}
        {variant === "page" ? <span className="min-w-0">{label}</span> : null}
      </button>
      {state === "error" ? (
        <span role="status" className={variant === "page" ? "text-micro text-danger" : "sr-only"}>{message}</span>
      ) : null}
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
