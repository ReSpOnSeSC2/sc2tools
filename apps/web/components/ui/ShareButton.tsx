"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, Share2 } from "lucide-react";
import { Button, type ButtonProps } from "@/components/ui/Button";
import { CopyRecoveryDialog } from "@/components/ui/CopyRecoveryDialog";
import { useToastOptional } from "@/components/ui/Toast";
import { useCopy } from "@/lib/useCopy";

type ShareScope = {
  identity: object;
  active: boolean;
  attempt: number;
  busy: boolean;
  timer: number | null;
};
type NativeState = { scope: ShareScope; status: "idle" | "sharing" | "shared" };
const useClientLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

interface ShareButtonProps extends Pick<ButtonProps, "variant" | "size" | "className" | "fullWidth" | "aria-label"> {
  path: string;
  title?: string;
  text?: string;
  label?: string;
  copiedLabel?: string;
}

/** Native sharing with clipboard and keyboard-accessible manual copy. */
export function ShareButton({
  path, title, text, label = "Share", copiedLabel = "Link copied",
  variant = "secondary", size = "md", className, fullWidth, "aria-label": ariaLabel,
}: ShareButtonProps) {
  const toast = useToastOptional()?.toast;
  const button = useRef<HTMLButtonElement>(null);
  const identity = useMemo(() => ({ path, title, text }), [path, title, text]);
  const scopeRef = useRef<ShareScope>({ identity, active: false, attempt: 0, busy: false, timer: null });
  if (scopeRef.current.identity !== identity) {
    scopeRef.current.active = false;
    scopeRef.current = { identity, active: false, attempt: 0, busy: false, timer: null };
  }
  const scope = scopeRef.current;
  const [nativeState, setNativeState] = useState<NativeState>({ scope, status: "idle" });
  const nativeStatus = nativeState.scope === scope ? nativeState.status : "idle";
  const clipboard = useCopy({
    scopeKey: identity,
    onCopied: () => toast?.success("Link copied"),
  });

  useClientLayoutEffect(() => {
    scope.active = true;
    return () => {
      scope.active = false;
      scope.attempt += 1;
      scope.busy = false;
      if (scope.timer !== null) window.clearTimeout(scope.timer);
      scope.timer = null;
    };
  }, [scope]);

  async function sharePage() {
    if (!scope.active || scopeRef.current !== scope || scope.busy) return;
    const attempt = ++scope.attempt;
    const current = () => scope.active && scopeRef.current === scope && scope.attempt === attempt;
    scope.busy = true;
    if (scope.timer !== null) window.clearTimeout(scope.timer);
    scope.timer = null;
    clipboard.clear();
    const href = `${window.location.origin}${path}`;
    setNativeState({ scope, status: "sharing" });

    try {
      let shared = false;
      try {
        if (typeof navigator.share === "function") {
          // Keep this in the click's activation; no effect or awaited work
          // precedes the platform share sheet.
          await navigator.share({ title, text, url: href });
          shared = true;
        }
      } catch (error) {
        if (!current()) return;
        if (
          error
          && typeof error === "object"
          && "name" in error
          && error.name === "AbortError"
        ) {
          setNativeState({ scope, status: "idle" });
          return;
        }
        // If the platform share sheet fails, fall through to copy support.
      }
      if (!current()) return;
      if (shared) {
        setNativeState({ scope, status: "shared" });
        toast?.success("Link shared");
        scope.timer = window.setTimeout(() => {
          if (!current()) return;
          scope.timer = null;
          setNativeState({ scope, status: "idle" });
        }, 1800);
        return;
      }
      setNativeState({ scope, status: "idle" });
      // The captured hook callback belongs to this same public resource.
      await clipboard.copy(href);
    } finally {
      if (current()) scope.busy = false;
    }
  }

  const sharing = nativeStatus === "sharing" || clipboard.pending;
  const complete = nativeStatus === "shared" || clipboard.copied;
  return (
    <>
      <Button
        ref={button}
        variant={variant}
        size={size}
        className={className}
        fullWidth={fullWidth}
        onClick={() => void sharePage()}
        loading={sharing}
        aria-label={ariaLabel}
        iconLeft={complete
          ? <Check className="h-4 w-4 text-success" aria-hidden />
          : <Share2 className="h-4 w-4" aria-hidden />}
      >
        {sharing
          ? "Opening share…"
          : nativeStatus === "shared"
            ? "Shared"
            : clipboard.copied
              ? copiedLabel
              : label}
      </Button>
      <CopyRecoveryDialog text={clipboard.fallbackText} inputRef={clipboard.inputRef}
        triggerRef={button} scopeKey={identity} onDismiss={clipboard.clear}
        title="Copy link manually" label="Copy link manually" />
    </>
  );
}
