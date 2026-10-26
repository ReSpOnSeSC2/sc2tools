"use client";

import { useId, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { useAuth } from "@clerk/nextjs";
import { AlertCircle, Download, Loader2 } from "lucide-react";
import { apiCall, useOwnerRequestScope, type ClientApiError } from "@/lib/clientApi";
import { useToastOptional } from "@/components/ui/Toast";
import { buttonClassName, type ButtonSize, type ButtonVariant } from "@/components/ui/buttonStyles";

type ReplayDownloadResponse = {
  url: string;
  filename: string;
  expiresIn: number;
};

type DownloadState = "idle" | "loading" | "error";
type DownloadScope = {
  owner: string | null; gameId: string | null; path: string;
  available: boolean; filename: string | null; active: boolean;
  controller: AbortController | null;
};

export function ReplayDownloadButton({
  gameId,
  available,
  filename,
  sizeBytes,
  mobile = false,
  showLabel = false,
  contextLabel,
  downloadPath,
  unavailableMessage,
  size,
  variant,
}: {
  gameId?: string | null;
  available?: boolean;
  filename?: string | null;
  sizeBytes?: number | null;
  mobile?: boolean;
  /** Show a visible label for roomy action bars; icon-only remains the default. */
  showLabel?: boolean;
  /** Extra replay context for screen-reader action lists. */
  contextLabel?: string;
  /** Authorized API route for delegated access (for example, coaching). */
  downloadPath?: string;
  /** Context-specific guidance when the original replay has not been archived. */
  unavailableMessage?: string;
  /** Opt into shared action-bar styling; legacy row controls retain their look. */
  size?: ButtonSize;
  variant?: ButtonVariant;
}) {
  const { getToken, isLoaded, isSignedIn, userId } = useAuth();
  const owner = isLoaded && isSignedIn && userId ? userId : null;
  const runOwned = useOwnerRequestScope(owner, getToken);
  const path = downloadPath || `/v1/games/${encodeURIComponent(gameId ?? "")}/replay-download`;
  const scopeRef = useRef<DownloadScope>({
    owner, gameId: gameId ?? null, path, available: available === true,
    filename: filename ?? null, active: !!owner, controller: null,
  });
  let scope = scopeRef.current;
  if (scope.owner !== owner || scope.gameId !== (gameId ?? null) || scope.path !== path
    || scope.available !== (available === true) || scope.filename !== (filename ?? null)) {
    scope.active = false;
    scope = {
      owner, gameId: gameId ?? null, path, available: available === true,
      filename: filename ?? null, active: !!owner, controller: null,
    };
    scopeRef.current = scope;
  }
  useLayoutEffect(() => {
    scope.active = !!owner;
    return () => { scope.active = false; scope.controller?.abort(); scope.controller = null; };
  }, [scope, owner]);
  const toastContext = useToastOptional();
  const statusId = useId();
  const [request, setRequest] = useState<{ scope: DownloadScope; state: DownloadState; errorMessage: string | null }>({ scope, state: "idle", errorMessage: null });
  const state = request.scope === scope ? request.state : "idle";
  const errorMessage = request.scope === scope ? request.errorMessage : null;

  const canDownload = available === true && !!gameId;
  const loading = state === "loading";
  const resolvedUnavailableMessage = unavailableMessage
    || "Original replay unavailable. Update to the latest desktop agent, then run Re-sync.";
  const sizeLabel = formatSize(sizeBytes);
  const accessMessage = owner ? null : isLoaded ? "Sign in to download this replay." : "Checking replay access…";

  async function download(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (!owner || !scope.active || scopeRef.current !== scope) return;
    if (!canDownload) {
      toastContext?.toast.info("Replay unavailable", {
        description: resolvedUnavailableMessage,
      });
      return;
    }
    if (loading || scope.controller || !gameId) return;

    const controller = new AbortController();
    scope.controller = controller;
    const current = () => scope.active && scopeRef.current === scope && scope.controller === controller && !controller.signal.aborted;
    setRequest({ scope, state: "loading", errorMessage: null });
    try {
      const result = await runOwned(owner, async (scopedToken, signal, assertCurrent) => {
        const value = await apiCall<ReplayDownloadResponse>(scopedToken, path, { signal });
        assertCurrent();
        return value;
      }, 20_000, controller.signal);
      if (!current()) return;
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
      if (!current()) return;
      setRequest({ scope, state: "idle", errorMessage: null });
      toastContext?.toast.success("Replay download started");
    } catch (error) {
      if (!current()) return;
      const message = replayDownloadError(error);
      setRequest({ scope, state: "error", errorMessage: message });
      toastContext?.toast.error("Couldn't download replay", {
        description: message,
      });
    } finally {
      if (scope.controller === controller) scope.controller = null;
    }
  }

  const baseLabel = accessMessage ? isLoaded ? "Sign in to download replay" : "Checking replay access" : !canDownload
    ? "Replay unavailable"
    : loading
      ? "Downloading replay"
      : state === "error"
        ? "Retry replay download"
        : "Download replay";
  const label = owner && contextLabel ? `${baseLabel} — ${contextLabel}` : baseLabel;
  const title = accessMessage || (!canDownload
    ? resolvedUnavailableMessage
    : state === "error"
      ? errorMessage || "Retry replay download"
      : `${filename ? `Download ${filename}` : "Download original replay"}${
          sizeLabel ? ` (${sizeLabel})` : ""
        }`);

  return (
    <>
      <button
        type="button"
        onClick={download}
        disabled={loading || !owner}
        aria-disabled={!canDownload || !owner || undefined}
        aria-label={label}
        aria-busy={loading || undefined}
        aria-describedby={statusId}
        title={title}
        className={size || variant ? buttonClassName({ size, variant: variant ?? "secondary", className: `${!canDownload ? "opacity-55 aria-disabled:cursor-not-allowed" : ""} ${state === "error" ? "text-danger" : ""}` }) : [
          "inline-flex items-center justify-center rounded-md border font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:cursor-not-allowed aria-disabled:cursor-not-allowed",
          mobile
            ? "min-h-[44px] w-full gap-2 border-border-strong bg-bg-elevated/60 px-3 py-2 text-caption"
            : showLabel
              ? "min-h-9 gap-2 border-border-strong bg-bg-elevated/75 px-3 py-1.5 text-caption shadow-sm"
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
        {mobile || showLabel ? (
          <span>
            {accessMessage ? baseLabel : !canDownload
              ? "Replay unavailable"
              : loading
                ? "Downloading…"
                : state === "error"
                  ? "Try download again"
                  : "Download replay"}
            {owner && canDownload && sizeLabel && !loading ? (
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
        {accessMessage || (!canDownload
          ? resolvedUnavailableMessage
          : state === "error"
            ? errorMessage
            : loading
              ? "Preparing a secure replay download."
              : "")}
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
  if (apiError?.code === "request_timeout") return "Preparing the replay download took too long. Try again.";
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
