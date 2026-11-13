"use client";

import { useId, useRef, useState } from "react";
import { useToastOptional } from "@/components/ui/Toast";

export function GuideReplayDownloadButton({ handle, replayRef, label }: {
  handle: string;
  replayRef: string;
  label: string;
}) {
  const pending = useRef(false);
  const statusId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toast = useToastOptional()?.toast;

  async function download() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const { downloadPublicReplay } = await import("@/lib/downloadPublicReplay");
      await downloadPublicReplay(handle, replayRef);
      toast?.success("Replay download started");
    } catch (cause) {
      const message = cause instanceof Error && cause.message ? cause.message : "Please try again in a moment.";
      setError(message);
      toast?.error("Couldn't download replay", { description: message });
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  const action = busy ? "Preparing replay download" : error ? "Retry replay download" : "Download replay";
  return (
    <>
      <button
        type="button"
        className="inline-flex min-h-11 items-center rounded-md border border-border-strong bg-bg-elevated/60 px-4 text-caption font-semibold text-text-muted hover:border-accent hover:text-accent focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed"
        onClick={download}
        disabled={busy}
        aria-busy={busy || undefined}
        aria-label={`${action} — ${label}`}
        aria-describedby={statusId}
      >
        {busy ? "Preparing…" : error ? "Try download again" : "Download replay"}
      </button>
      <span id={statusId} role={error ? "alert" : "status"} className="sr-only">
        {error || (busy ? "Preparing a secure, short-lived replay download link." : "")}
      </span>
    </>
  );
}
