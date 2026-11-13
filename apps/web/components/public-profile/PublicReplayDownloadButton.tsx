"use client";

import { useId, useState, type MouseEvent } from "react";
import { AlertCircle, Download, Loader2 } from "lucide-react";
import { useToastOptional } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";

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
  primary = false,
  appearance,
  contextLabel,
}: {
  handle: string;
  gameId: string;
  available?: boolean;
  sizeBytes?: number | null;
  mobile?: boolean;
  showLabel?: boolean;
  primary?: boolean;
  appearance?: "pill";
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
      const { downloadPublicReplay } = await import("@/lib/downloadPublicReplay");
      await downloadPublicReplay(handle, gameId);
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

  const props = {
    disabled: !canDownload || state === "loading",
    onClick: download,
    "aria-label": label,
    "aria-busy": state === "loading" || undefined,
    "aria-describedby": statusId,
    title: label + (size ? " (" + size + ")" : ""),
  };
  const icon = state === "loading" ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
    : state === "error" ? <AlertCircle className="h-4 w-4" aria-hidden /> : <Download className="h-4 w-4" aria-hidden />;
  const text = !canDownload ? "Replay unavailable" : state === "loading" ? "Preparing…" : state === "error"
    ? "Try download again" : "Download replay" + (size ? " · " + size : "");
  return (
    <>
      {appearance === "pill" ? <Button {...props} variant="secondary" iconLeft={icon}>{text}</Button> : <button
        {...props}
        type="button"
        className={[
          "inline-flex items-center justify-center rounded-md border font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:cursor-not-allowed",
          mobile
            ? "min-h-[44px] w-full gap-2 px-3 py-2 text-caption"
            : showLabel
              ? "min-h-11 gap-2 px-4 text-caption"
              : "h-8 w-8",
          !canDownload
            ? "border-border bg-bg-elevated/60 text-text-dim opacity-55"
            : state === "error"
              ? "border-danger/50 bg-bg-elevated/60 text-danger hover:bg-danger/10"
              : primary ? "border-accent bg-accent text-white hover:bg-accent/85" : `${mobile || showLabel ? "border-border-strong" : "border-border"} bg-bg-elevated/60 text-text-muted hover:border-accent hover:bg-bg-elevated hover:text-accent`,
        ].join(" ")}
      >
        {icon}{mobile || showLabel ? <span>{text}</span> : null}
      </button>}
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

function formatSize(value: number | null | undefined): string | null {
  if (!Number.isFinite(value) || Number(value) <= 0) return null;
  const bytes = Number(value);
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
