"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { Input } from "./Input";

export interface DestructiveConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: ReactNode;
  description?: ReactNode;
  /**
   * Word the user must type verbatim to enable the confirm button.
   * Comparison is case-sensitive — pick a word that's hard to type by
   * accident (default "DELETE").
   */
  confirmWord?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  loading?: boolean;
  /**
   * Extra content rendered between the description and the type-to-
   * confirm input — useful for date pickers, size warnings, etc.
   */
  children?: ReactNode;
}

/**
 * Two-step destructive confirmation. Used for any action that wipes
 * user data: account deletion, game-history wipes, snapshot restores,
 * etc.
 *
 * Flow:
 *   1. The dialog opens with the confirm button disabled.
 *   2. User reads the prompt and types the confirm word into the input.
 *   3. Confirm button becomes enabled; clicking it fires `onConfirm`.
 *
 * Resets its internal state every time `open` flips to true so the
 * input never carries a stale value across opens.
 */
export function DestructiveConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmWord = "DELETE",
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  loading = false,
  children,
}: DestructiveConfirmDialogProps) {
  const [typed, setTyped] = useState("");
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setTyped("");
      // Defer focus so the modal has actually mounted the input.
      const t = window.setTimeout(() => inputRef.current?.focus(), 50);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [open]);

  const matches = typed === confirmWord;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button
            variant="danger"
            onClick={onConfirm}
            loading={loading}
            disabled={!matches}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
      <div className="space-y-1.5">
        <label htmlFor={inputId} className="block text-caption text-text-muted">
          Type{" "}
          <span className="font-mono font-semibold text-text">{confirmWord}</span>{" "}
          to confirm:
        </label>
        <Input
          ref={inputRef}
          id={inputId}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          aria-label={`Type ${confirmWord} to confirm`}
          disabled={loading}
        />
      </div>
    </Modal>
  );
}
