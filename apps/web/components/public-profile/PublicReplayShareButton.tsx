"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Share2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useToastOptional } from "@/components/ui/Toast";

type ShareState = "idle" | "sharing" | "shared" | "copied";

/** Mobile-native sharing with a clipboard/manual-copy desktop fallback. */
export function PublicReplayShareButton({
  path,
  playerName,
}: {
  path: string;
  playerName: string;
}) {
  const toast = useToastOptional()?.toast;
  const [state, setState] = useState<ShareState>("idle");
  const resetTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
  }, []);

  async function sharePage() {
    if (state === "sharing") return;
    const href = `${window.location.origin}${path}`;
    const title = `${playerName}'s StarCraft II replays`;
    setState("sharing");

    if (typeof navigator.share === "function") {
      try {
        await navigator.share({
          title,
          text: `View and download ${playerName}'s shared StarCraft II replays.`,
          url: href,
        });
        finish("shared");
        toast?.success("Replay page shared");
        return;
      } catch (error) {
        if (
          error
          && typeof error === "object"
          && "name" in error
          && error.name === "AbortError"
        ) {
          setState("idle");
          return;
        }
        // If the platform share sheet fails, fall through to copy support.
      }
    }

    try {
      await copyText(href);
      finish("copied");
      toast?.success("Replay page link copied");
    } catch {
      setState("idle");
      window.prompt("Copy this replay page link", href);
    }
  }

  function finish(next: "shared" | "copied") {
    setState(next);
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => {
      resetTimer.current = null;
      setState("idle");
    }, 1800);
  }

  const complete = state === "shared" || state === "copied";
  return (
    <Button
      variant="secondary"
      size="md"
      className="w-full sm:w-auto"
      onClick={() => void sharePage()}
      loading={state === "sharing"}
      aria-label={`Share ${playerName}'s replay page`}
      iconLeft={complete
        ? <Check className="h-4 w-4 text-success" aria-hidden />
        : <Share2 className="h-4 w-4" aria-hidden />}
    >
      {state === "sharing"
        ? "Opening share…"
        : state === "shared"
          ? "Shared"
          : state === "copied"
            ? "Link copied"
            : "Share replay page"}
    </Button>
  );
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textArea = document.createElement("textarea");
  textArea.value = value;
  textArea.setAttribute("readonly", "");
  textArea.style.position = "fixed";
  textArea.style.left = "-9999px";
  document.body.appendChild(textArea);
  try {
    textArea.select();
    if (typeof document.execCommand !== "function" || !document.execCommand("copy")) {
      throw new Error("copy_unavailable");
    }
  } finally {
    textArea.remove();
  }
}
