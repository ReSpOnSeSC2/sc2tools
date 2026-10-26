"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, type RefObject } from "react";
import { canReturnFocus } from "@/lib/a11y/focusScopes";
import { Button } from "./Button";
import { Input } from "./Input";
import { Modal } from "./Modal";

const useClientLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;
export interface CopyRecoveryDialogProps {
  text: string | null;
  inputRef: RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
  triggerRef: RefObject<HTMLButtonElement | null>;
  /** The caller's fresh resource identity, shared with its copy controller. */
  scopeKey: object;
  /** Clear only the current copy UI; consent/native operations stay in callers. */
  onDismiss: () => void;
  title?: string;
  label?: string;
}

/** Controlled manual-copy presentation. This component never starts a copy,
 * native share or API request, and implicit resource retirement does not queue
 * an explicit trigger return. Keep it mounted while its controlled text closes.
 */
export function CopyRecoveryDialog({ text, inputRef, triggerRef, scopeKey, onDismiss,
  title = "Copy link manually", label = "Copy link manually" }: CopyRecoveryDialogProps) {
  const inputId = useId(), helpId = useId();
  const currentScope = useRef(scopeKey); currentScope.current = scopeKey;
  const restore = useRef<{ scope: object; target: HTMLButtonElement | null } | null>(null);
  const setInput = useCallback((node: HTMLInputElement | null) => { inputRef.current = node; }, [inputRef]);
  const dismiss = () => {
    if (currentScope.current !== scopeKey) return;
    restore.current = { scope: scopeKey, target: triggerRef.current };
    onDismiss();
  };
  useClientLayoutEffect(() => {
    if (text !== null) return;
    const request = restore.current; restore.current = null;
    const target = request?.target;
    // Modal cleanup restores pre-open focus first. Explicit dismissal returns
    // to the current action only while that action still owns modal focus.
    if (request?.scope === scopeKey && target === triggerRef.current && target?.isConnected
      && !target.disabled && canReturnFocus(target)) target.focus();
  }, [text, scopeKey, triggerRef]);
  return <Modal open={text !== null} title={title} onClose={dismiss} initialFocusRef={inputRef}
    footer={<Button variant="secondary" onClick={dismiss}>Done</Button>}>
    {text !== null ? <div className="space-y-2">
      <label htmlFor={inputId} className="block text-caption font-semibold">{label}</label>
      <Input ref={setInput} id={inputId} value={text} readOnly aria-describedby={helpId} className="min-h-11"
        onFocus={event => event.currentTarget.select()} onKeyDown={event => {
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismiss(); }
        }} />
      <p id={helpId} className="text-caption text-text-muted">Press Ctrl+C or ⌘C, or use your browser&apos;s Copy command.</p>
    </div> : null}
  </Modal>;
}
