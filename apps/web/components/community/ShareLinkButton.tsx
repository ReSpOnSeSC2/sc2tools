"use client";

import { useState } from "react";
import { Check, Link2 } from "lucide-react";
import { Button } from "@/components/ui/Button";

export interface ShareLinkButtonProps {
  /** Path relative to the site root. Origin is read at click time. */
  path: string;
  label?: string;
}

/**
 * ShareLinkButton — copies the canonical URL to clipboard.
 *
 * Origin is read from `window.location` so dev/staging/prod all
 * produce the right URL without an env var lookup. Falls back to
 * select-and-copy on browsers without the async clipboard API.
 */
export function ShareLinkButton({
  path,
  label = "Share link",
}: ShareLinkButtonProps) {
  const [copied, setCopied] = useState(false);

  async function handleClick() {
    const origin =
      typeof window !== "undefined" ? window.location.origin : "";
    const href = `${origin}${path}`;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(href);
      } else {
        const textArea = document.createElement("textarea");
        textArea.value = href;
        textArea.setAttribute("readonly", "");
        textArea.style.position = "absolute";
        textArea.style.left = "-9999px";
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand("copy");
        document.body.removeChild(textArea);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Browser blocked clipboard access — surface a fallback prompt
      // so the user can copy manually.
      window.prompt("Copy this link", href);
    }
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleClick}
      iconLeft={
        copied ? (
          <Check className="h-4 w-4 text-success" aria-hidden />
        ) : (
          <Link2 className="h-4 w-4" aria-hidden />
        )
      }
      fullWidth
    >
      {copied ? "Copied!" : label}
    </Button>
  );
}
