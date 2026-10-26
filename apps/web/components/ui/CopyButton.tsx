"use client";

import { useCallback, useId, useMemo, useRef, type KeyboardEvent, type ReactNode } from "react";
import { useCopy } from "@/lib/useCopy";
import { Button, type ButtonProps } from "./Button";
import { Input } from "./Input";
import { useToastOptional } from "./Toast";

export interface CopyButtonProps extends Omit<ButtonProps, "onClick" | "loading" | "children"> {
  text: string;
  /** Optional owner/resource identity in addition to the copied text. */
  scopeKey?: string | number | null;
  children?: ReactNode;
  copiedLabel?: ReactNode;
  successMessage?: string;
  fallbackLabel?: string;
}

/** A user-triggered copy action with the same accessible fallback everywhere. */
export function CopyButton({
  text, scopeKey, children = "Copy", copiedLabel = "Copied", successMessage = "Copied",
  fallbackLabel = "Copy this text", variant = "secondary", ...props
}: CopyButtonProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inputId = useId();
  const helpId = useId();
  const context = useToastOptional();
  const identity = useMemo(() => ({ text, scopeKey }), [text, scopeKey]);
  const clipboard = useCopy({
    scopeKey: identity,
    onCopied: () => context?.toast.success(successMessage),
    onFallback: () => context?.toast.info("Copy the selected text", { description: "Use your browser's Copy command or keyboard shortcut." }),
  });
  const dismissFallback = () => { clipboard.clear(); buttonRef.current?.focus(); };
  const setInputRef = useCallback((node: HTMLInputElement | HTMLTextAreaElement | null) => {
    clipboard.inputRef.current = node;
  }, [clipboard.inputRef]);
  const onFallbackKey = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismissFallback(); }
  };
  return <div className="relative min-w-0 space-y-2">
    <Button {...props} ref={buttonRef} variant={variant} loading={clipboard.pending} onClick={() => { void clipboard.copy(text); }}>
      {clipboard.copied ? copiedLabel : children}
    </Button>
    <span className="sr-only" role="status" aria-live="polite">
      {clipboard.copied ? successMessage : clipboard.fallbackText !== null ? "Automatic copy is unavailable. Copy the selected text manually." : clipboard.pending ? "Copying" : ""}
    </span>
    {clipboard.fallbackText !== null ? <div className="space-y-2 rounded-lg border border-border bg-bg-surface p-3">
      <label htmlFor={inputId} className="block text-caption font-semibold">{fallbackLabel}</label>
      {/[\r\n]/.test(clipboard.fallbackText) ? <textarea ref={setInputRef} id={inputId} value={clipboard.fallbackText} readOnly rows={3}
        aria-describedby={helpId} className="block min-h-11 w-full rounded-lg border-2 border-line bg-bg-surface px-3 py-2 text-body text-text focus:outline-none focus:ring-2 focus:ring-accent"
        onFocus={event => event.currentTarget.select()} onKeyDown={onFallbackKey} />
        : <Input ref={setInputRef} id={inputId} value={clipboard.fallbackText} readOnly aria-describedby={helpId}
          className="min-h-11" onFocus={event => event.currentTarget.select()} onKeyDown={onFallbackKey} />}
      <p id={helpId} className="text-caption text-text-muted">Press Ctrl+C or ⌘C, or use your browser&apos;s Copy command.</p>
      <Button variant="ghost" size="sm" onClick={dismissFallback}>Done</Button>
    </div> : null}
  </div>;
}
