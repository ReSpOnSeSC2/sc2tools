"use client";

import { useCallback, useId, useRef } from "react";
import { Check, Link2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToastOptional } from "@/components/ui/Toast";
import { useCopy } from "@/lib/useCopy";

export interface ShareLinkButtonProps {
  /** Path relative to the site root. Origin is read at click time. */
  path: string;
  label?: string;
  className?: string;
}

/**
 * ShareLinkButton — copies the canonical URL to clipboard.
 *
 * Origin is read from `window.location` so dev/staging/prod all
 * produce the right URL without an env var lookup. Shared copy lifetime and
 * permission recovery keep the exact current URL available for manual copy.
 */
export function ShareLinkButton({
  path,
  label = "Share link",
  className,
}: ShareLinkButtonProps) {
  const button = useRef<HTMLButtonElement>(null);
  const inputId = useId(), helpId = useId();
  const toast = useToastOptional();
  const clipboard = useCopy({
    scopeKey: path,
    onCopied: () => toast?.toast.success("Link copied"),
    onFallback: () => toast?.toast.info("Copy the selected link"),
  });
  const setInputRef = useCallback((node: HTMLInputElement | null) => {
    clipboard.inputRef.current = node;
  }, [clipboard.inputRef]);
  const dismiss = () => {
    clipboard.clear();
    button.current?.focus();
  };

  return (
    <div className="min-w-0 space-y-2">
      <Button
        ref={button}
        variant="ghost"
        size="sm"
        className={className}
        loading={clipboard.pending}
        onClick={() => { void clipboard.copy(`${window.location.origin}${path}`); }}
        iconLeft={clipboard.copied
          ? <Check className="h-4 w-4 text-success" aria-hidden />
          : <Link2 className="h-4 w-4" aria-hidden />}
        fullWidth
      >
        {clipboard.copied ? "Copied!" : label}
      </Button>
      <span role="status" className="sr-only">
        {clipboard.copied ? "Link copied" : clipboard.pending ? "Copying link" : clipboard.fallbackText !== null ? "Automatic copy is unavailable. Copy the selected link manually." : ""}
      </span>
      {clipboard.fallbackText !== null ? <div className="space-y-2 rounded-lg border border-border bg-bg-surface p-3">
        <label htmlFor={inputId} className="block text-caption font-semibold">Copy link manually</label>
        <Input ref={setInputRef} id={inputId} value={clipboard.fallbackText} readOnly aria-describedby={helpId} className="min-h-11"
          onFocus={event => event.currentTarget.select()}
          onKeyDown={event => {
            if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismiss(); }
          }} />
        <p id={helpId} className="text-caption text-text-muted">Press Ctrl+C or ⌘C, or use your browser&apos;s Copy command.</p>
        <Button variant="ghost" size="sm" onClick={dismiss}>Done</Button>
      </div> : null}
    </div>
  );
}
