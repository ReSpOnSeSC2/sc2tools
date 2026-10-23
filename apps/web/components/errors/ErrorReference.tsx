"use client";

import { useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/Button";

type CopyState = "idle" | "copied" | "selected";

/** Select an element's text so the visitor can copy it by hand. */
function selectText(node: HTMLElement | null): void {
  if (!node || typeof window === "undefined") return;
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(node);
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * "Error reference: <digest>" with a copy button, so a crash report can
 * name the exact server error. When the clipboard is blocked (an
 * insecure context or a denied permission) the reference is selected
 * instead and the visitor is told to copy it by hand.
 */
export function ErrorReference({ digest }: { digest: string }) {
  const codeRef = useRef<HTMLElement>(null);
  const [state, setState] = useState<CopyState>("idle");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(digest);
      setState("copied");
    } catch {
      selectText(codeRef.current);
      setState("selected");
    }
  };

  return (
    <div className="flex flex-col items-center gap-2">
      <p className="text-caption text-text-muted">
        Error reference:{" "}
        <code ref={codeRef} className="select-all rounded bg-bg-elevated px-1.5 py-0.5 font-mono text-caption text-text">
          {digest}
        </code>
      </p>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => void copy()}
        iconLeft={state === "copied" ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
      >
        Copy error reference
      </Button>
      <p role="status" aria-live="polite" className="min-h-[20px] text-caption text-text-muted">
        {state === "copied"
          ? "Copied."
          : state === "selected"
            ? "Selected. Press Ctrl+C (⌘C on a Mac) to copy it."
            : ""}
      </p>
    </div>
  );
}
