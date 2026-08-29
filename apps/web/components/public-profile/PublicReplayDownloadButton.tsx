"use client";

import { useId, useState, type MouseEvent } from "react";
import { AlertCircle, Download, Loader2 } from "lucide-react";
import { API_BASE } from "@/lib/clientApi";
import { useToastOptional } from "@/components/ui/Toast";

type DownloadResponse = {
  url: string;
  filename: string;
  expiresIn: number;
};

/**
 * Public-share download control. It never receives an object-store URL in the
 * page payload: each click re-checks the owner's active sharing switch, then
 * receives a short-lived HTTPS URL from the API.
 */
export function PublicReplayDownloadButton({
  handle,
  gameId,
  available,
  sizeBytes,
  mobile = false,
  showLabel = false,
  contextLabel,
}: {
  handle: string;
  gameId: string;
  available?: boolean;
  sizeBytes?: number | null;
  mobile?: boolean;
  showLabel?: boolean;
  /** Extra replay context for screen-reader action lists. */
  contextLabel?: string;
}) {
  const toastContext = useToastOptional();
  const statusId = useId();
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [message, setMessage] = useState("");
  const canDownload = available === true && Boolean(handle && gameId);

  async function download(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (!canDownload || state === "loading") return;
    setState("loading");
    setMessage("");
    try {
      const response = await fetch(
        `${API_BASE}/v1/public/replays/${encodeURIComponent(handle)}/${encodeURIComponent(gameId)}/download`,
        { headers: { accept: "application/json" }, cache: "no-store" },
      );
      if (!response.ok) throw new Error(await publicDownloadError(response));
      const payload = (await response.json()) as DownloadResponse;
      const href = safeSignedUrl(payload.url);
      if (!href) throw new Error("The replay download link was invalid.");

      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = safeFilename(payload.filename, gameId);
      anchor.rel = "noopener noreferrer";
      anchor.referrerPolicy = "no-referrer";
      anchor.style.display = "none";
      document.body.appendChild(anchor);
      try {
        anchor.click();
      } finally {
        anchor.remove();
      }
      setState("idle");
      toastContext?.toast.success("Replay download started");
    } catch (error) {
      const next = error instanceof Error && error.message
        ? error.message
        : "Please try again in a moment.";
      setMessage(next);
      setState("error");
      toastContext?.toast.error("Couldn't download replay", {
        description: next,
      });
    }
  }

  const size = formatSize(sizeBytes);
  const baseLabel = !canDownload
    ? "Replay unavailable"
    : state === "loading"
      ? "Preparing replay download"
      : state === "error"
        ? "Retry replay download"
        : "Download replay";
  const label = contextLabel ? `${baseLabel} — ${contextLabel}` : baseLabel;

  return (
    <>
      <button
        type="button"
        disabled={!canDownload || state === "loading"}
        onClick={download}
        aria-label={label}
        aria-busy={state === "loading" || undefined}
        aria-describedby={statusId}
        title={`${label}${size ? ` (${size})` : ""}`}
        className={[
          "inline-flex items-center justify-center rounded-md border font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:cursor-not-allowed",
          mobile
            ? "min-h-[44px] w-full gap-2 border-border-strong bg-bg-elevated/60 px-3 py-2 text-caption"
            : showLabel
              ? "min-h-11 gap-2 border-border-strong bg-bg-elevated/60 px-4 text-caption"
              : "h-8 w-8 border-border bg-bg-elevated/60",
          !canDownload
            ? "text-text-dim opacity-55"
            : state === "error"
              ? "border-danger/50 text-danger hover:bg-danger/10"
              : "text-text-muted hover:border-accent hover:bg-bg-elevated hover:text-accent",
        ].join(" ")}
      >
        {state === "loading" ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        ) : state === "error" ? (
          <AlertCircle className="h-4 w-4" aria-hidden />
        ) : (
          <Download className="h-4 w-4" aria-hidden />
        )}
        {mobile || showLabel ? (
          <span>{!canDownload ? "Replay unavailable" : state === "loading" ? "Preparing…" : state === "error" ? "Try download again" : `Download replay${size ? ` · ${size}` : ""}`}</span>
        ) : null}
      </button>
      <span id={statusId} className="sr-only" role={state === "error" ? "alert" : "status"}>
        {!canDownload
          ? "The original replay file is unavailable."
          : state === "loading"
            ? "Preparing a secure, short-lived replay download link."
            : state === "error"
              ? message
              : ""}
      </span>
    </>
  );
}

async function publicDownloadError(response: Response): Promise<string> {
  if (response.status === 404) {
    return "This replay is unavailable or sharing has been turned off.";
  }
  if (response.status === 429) return "Too many download requests. Try again in a minute.";
  if (response.status >= 500) return "Replay storage is temporarily unavailable.";
  try {
    const body = await response.json() as { error?: { message?: string } };
    if (body.error?.message) return body.error.message;
  } catch {
    // Use the generic message below.
  }
  return "The replay download could not be prepared.";
}

function safeSignedUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function safeFilename(value: unknown, gameId: string): string {
  const raw = typeof value === "string" ? value : `sc2tools-${gameId}`;
  const clean = raw
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\.SC2Replay$/i, "")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 160);
  return `${clean || "sc2tools-replay"}.SC2Replay`;
}

function formatSize(value: number | null | undefined): string | null {
  if (!Number.isFinite(value) || Number(value) <= 0) return null;
  const bytes = Number(value);
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
