"use client";

import { useId, useState, type MouseEvent } from "react";
import { useAuth } from "@clerk/nextjs";
import { AlertCircle, Download, Loader2 } from "lucide-react";
import { apiCall, type ClientApiError } from "@/lib/clientApi";
import { useToastOptional } from "@/components/ui/Toast";

type ReplayDownloadResponse = {
  url: string;
  filename: string;
  expiresIn: number;
};

type DownloadState = "idle" | "loading" | "error";

export function ReplayDownloadButton({
  gameId,
  available,
  filename,
  sizeBytes,
  mobile = false,
}: {
  gameId?: string | null;
  available?: boolean;
  filename?: string | null;
  sizeBytes?: number | null;
  mobile?: boolean;
}) {
  const { getToken } = useAuth();
  const toastContext = useToastOptional();
  const statusId = useId();
  const [state, setState] = useState<DownloadState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const canDownload = available === true && !!gameId;
  const loading = state === "loading";
  const unavailableMessage =
    "Original replay unavailable. Update to the latest desktop agent, then run Re-sync.";
  const sizeLabel = formatSize(sizeBytes);

  async function download(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (!canDownload || loading || !gameId) return;

    setState("loading");
    setErrorMessage(null);
    try {
      const result = await apiCall<ReplayDownloadResponse>(
        getToken,
        `/v1/games/${encodeURIComponent(gameId)}/replay-download`,
      );
      const href = safeSignedUrl(result?.url);
      if (!href) throw new Error("The replay download link was invalid.");

      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = safeReplayFilename(
        result?.filename || filename,
        gameId,
      );
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
      const message = replayDownloadError(error);
      setState("error");
      setErrorMessage(message);
      toastContext?.toast.error("Couldn't download replay", {
        description: message,
      });
    }
  }

  const label = !canDownload
    ? "Replay unavailable"
    : loading
      ? "Downloading replay"
      : state === "error"
        ? "Retry replay download"
        : "Download replay";
  const title = !canDownload
    ? unavailableMessage
    : state === "error"
      ? errorMessage || "Retry replay download"
      : `${filename ? `Download ${filename}` : "Download original replay"}${
          sizeLabel ? ` (${sizeLabel})` : ""
        }`;

  return (
    <>
      <button
        type="button"
        onClick={download}
        disabled={!canDownload || loading}
        aria-label={label}
        aria-busy={loading || undefined}
        aria-describedby={statusId}
        title={title}
        className={[
          "inline-flex items-center justify-center rounded-md border font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:cursor-not-allowed",
          mobile
            ? "min-h-[44px] w-full gap-2 border-border-strong bg-bg-elevated/60 px-3 py-2 text-caption"
            : "h-8 w-8 border-border bg-bg-elevated/60",
          !canDownload
            ? "text-text-dim opacity-55"
            : state === "error"
              ? "border-danger/50 text-danger hover:bg-danger/10"
              : "text-text-muted hover:border-accent hover:bg-bg-elevated hover:text-accent",
        ].join(" ")}
      >
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        ) : state === "error" && canDownload ? (
          <AlertCircle className="h-4 w-4" aria-hidden />
        ) : (
          <Download className="h-4 w-4" aria-hidden />
        )}
        {mobile ? (
          <span>
            {!canDownload
              ? "Replay unavailable"
              : loading
                ? "Downloading…"
                : state === "error"
                  ? "Try download again"
                  : "Download replay"}
            {canDownload && sizeLabel && !loading ? (
              <span className="ml-1 font-normal text-text-dim">
                · {sizeLabel}
              </span>
            ) : null}
          </span>
        ) : null}
      </button>
      <span
        id={statusId}
        className="sr-only"
        role={state === "error" ? "alert" : "status"}
      >
        {!canDownload
          ? unavailableMessage
          : state === "error"
            ? errorMessage
            : loading
              ? "Preparing a secure replay download."
              : ""}
      </span>
    </>
  );
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

function safeReplayFilename(
  value: string | null | undefined,
  gameId: string,
): string {
  const fallbackId = gameId
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/[. ]+$/g, "")
    .slice(0, 96);
  let clean = String(value || `sc2tools-${fallbackId || "replay"}`)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
  if (!clean) clean = "sc2tools-replay";
  clean = clean.replace(/\.SC2Replay$/i, "").slice(0, 160).trim();
  return `${clean || "sc2tools-replay"}.SC2Replay`;
}

function formatSize(value: number | null | undefined): string | null {
  if (!Number.isFinite(value) || Number(value) <= 0) return null;
  const bytes = Number(value);
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function replayDownloadError(error: unknown): string {
  const apiError = error as ClientApiError | undefined;
  if (
    apiError?.code === "replay_unavailable"
    || apiError?.code === "not_found"
    || apiError?.status === 404
  ) {
    return "This replay is no longer available. Update to the latest desktop agent, then run Re-sync.";
  }
  if (typeof apiError?.message === "string" && apiError.message.trim()) {
    return apiError.message;
  }
  if (error instanceof Error && error.message.trim()) return error.message;
  return "Please try again in a moment.";
}
