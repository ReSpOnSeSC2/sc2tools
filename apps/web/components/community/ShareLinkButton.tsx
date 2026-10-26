"use client";

import { useMemo, useRef } from "react";
import { Check, Link2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { CopyRecoveryDialog } from "@/components/ui/CopyRecoveryDialog";
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
  const identity = useMemo(() => ({ path }), [path]);
  const toast = useToastOptional();
  const clipboard = useCopy({
    scopeKey: identity,
    onCopied: () => toast?.toast.success("Link copied"),
  });

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
      <CopyRecoveryDialog text={clipboard.fallbackText} inputRef={clipboard.inputRef} triggerRef={button}
        scopeKey={identity} onDismiss={clipboard.clear} />
    </div>
  );
}
