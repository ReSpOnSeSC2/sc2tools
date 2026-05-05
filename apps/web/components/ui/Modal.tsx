"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

/**
 * Modal — portal-based dialog with focus trap and Esc-close.
 *
 * Behavior:
 *   - ≤640px viewport: renders as a bottom sheet (full-width).
 *   - ≥640px viewport: renders as a centered card.
 *   - Focus is trapped inside while open, returned to the previously
 *     focused element on close.
 *   - Body scroll is locked while open.
 *
 * For destructive confirmations use ConfirmDialog (built on this).
 */

export type ModalSize = "sm" | "md" | "lg" | "xl";

const SIZE_CLASSES: Record<ModalSize, string> = {
  sm: "sm:max-w-md",
  md: "sm:max-w-lg",
  lg: "sm:max-w-2xl",
  xl: "sm:max-w-4xl",
};

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  size?: ModalSize;
  /** Hide the X close button (still closes on Esc / scrim click). */
  hideClose?: boolean;
  /** Disable scrim-click dismissal — useful for in-progress flows. */
  disableScrimClose?: boolean;
  children: ReactNode;
  footer?: ReactNode;
}

export function Modal({
  open,
  onClose,
  title,
  description,
  size = "md",
  hideClose = false,
  disableScrimClose = false,
  children,
  footer,
}: ModalProps) {
  const titleId = useId();
  const descId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<Element | null>(null);

  // Body scroll lock + Esc + focus management
  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current = document.activeElement;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      } else if (e.key === "Tab") {
        trapTab(e, dialogRef.current);
      }
    };
    document.addEventListener("keydown", onKey);

    // Focus the dialog itself once mounted; consumers can override
    // by adding autoFocus on a child element.
    const initFocus = window.setTimeout(() => {
      const focusables = focusableInside(dialogRef.current);
      (focusables[0] ?? dialogRef.current)?.focus();
    }, 0);

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      window.clearTimeout(initFocus);
      const prev = previouslyFocusedRef.current as HTMLElement | null;
      if (prev && typeof prev.focus === "function") {
        prev.focus();
      }
    };
  }, [open, onClose]);

  if (!open) return null;
  if (typeof window === "undefined") return null;

  const onScrimClick = () => {
    if (!disableScrimClose) onClose();
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4"
      role="presentation"
    >
      <button
        type="button"
        aria-label="Close dialog"
        tabIndex={-1}
        onClick={onScrimClick}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={[
          "relative w-full bg-bg-surface text-text border border-border shadow-[var(--shadow-card)]",
          "max-h-[100dvh] sm:max-h-[85vh] overflow-hidden flex flex-col",
          "rounded-t-2xl sm:rounded-xl",
          "pb-[env(safe-area-inset-bottom,0px)]",
          SIZE_CLASSES[size],
        ].join(" ")}
      >
        <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="space-y-1">
            <h2 id={titleId} className="text-h4 font-semibold text-text">
              {title}
            </h2>
            {description ? (
              <p id={descId} className="text-caption text-text-muted">
                {description}
              </p>
            ) : null}
          </div>
          {hideClose ? null : (
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="-mr-1.5 -mt-0.5 inline-flex h-9 w-9 items-center justify-center rounded-md text-text-muted hover:bg-bg-elevated hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <X className="h-5 w-5" aria-hidden />
            </button>
          )}
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? (
          <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-border bg-bg-elevated/30 px-5 py-3">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

/* ============================================================
 * Focus-trap helpers
 * ============================================================ */

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function focusableInside(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute("data-focus-trap-skip"),
  );
}

function trapTab(e: KeyboardEvent, root: HTMLElement | null): void {
  if (!root) return;
  const els = focusableInside(root);
  if (els.length === 0) {
    e.preventDefault();
    root.focus();
    return;
  }
  const first = els[0];
  const last = els[els.length - 1];
  const active = document.activeElement;
  if (e.shiftKey) {
    if (active === first || !root.contains(active)) {
      e.preventDefault();
      last.focus();
    }
  } else {
    if (active === last) {
      e.preventDefault();
      first.focus();
    }
  }
}

/* Exported for callers that want to render a basic actions row inside `footer`. */
export function ModalActions({
  className = "",
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={["flex flex-wrap gap-2", className].filter(Boolean).join(" ")}
      {...rest}
    >
      {children}
    </div>
  );
}
