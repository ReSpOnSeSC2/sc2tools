"use client";

import {
  useEffect,
  useId,
  useRef,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { lockBodyScroll } from "@/lib/bodyScrollLock";
import { useFocusTrap } from "@/lib/a11y/useFocusTrap";
import { OverlayLayerProvider, useOverlayLayer } from "./OverlayLayer";

/**
 * Modal — portal-based dialog with focus trap and Esc-close.
 *
 * Behavior:
 *   - ≤640px viewport: renders as a bottom sheet (full-width) by default,
 *     or a centered card when `mobileLayout="center"`.
 *   - ≥640px viewport: renders as a centered card, or a full-height
 *     panel docked to the right edge when `desktopLayout="side"`.
 *   - Focus is trapped inside while open, returned to the previously
 *     focused element on close.
 *   - Body scroll is locked while open.
 *
 * For destructive confirmations use ConfirmDialog (built on this).
 */

export type ModalSize = "sm" | "md" | "lg" | "xl" | "2xl" | "3xl";
export type ModalMobileLayout = "sheet" | "center";
export type ModalDesktopLayout = "center" | "side";
export type ModalPlacement = "responsive" | "bottom" | "right";

const SIZE_CLASSES: Record<ModalSize, string> = {
  sm: "sm:max-w-md",
  md: "sm:max-w-lg",
  lg: "sm:max-w-2xl",
  xl: "sm:max-w-4xl",
  "2xl": "sm:max-w-6xl",
  "3xl": "sm:max-w-[1400px]",
};
const SIDE_SIZE_CLASSES: Record<ModalSize, string> = {
  sm: "max-w-md",
  md: "max-w-lg",
  lg: "max-w-2xl",
  xl: "max-w-4xl",
  "2xl": "max-w-6xl",
  "3xl": "max-w-[1400px]",
};

export interface ModalProps {
  /** Keep a dialog inside a fullscreen player when supplied. */
  portalContainer?: Element | null;
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  size?: ModalSize;
  /**
   * Mobile (≤640px) layout. Defaults to "sheet" (bottom sheet).
   * Use "center" to render as a centered card on mobile too.
   */
  mobileLayout?: ModalMobileLayout;
  /**
   * ≥640px layout. Defaults to "center" (centered card). "side" docks a
   * full-height panel to the right edge, for reading alongside the page.
   */
  desktopLayout?: ModalDesktopLayout;
  /** Explicit sheet placement at every viewport; responsive keeps existing layouts. */
  placement?: ModalPlacement;
  /** Hide the X close button (still closes on Esc / scrim click). */
  hideClose?: boolean;
  /** Disable scrim-click dismissal — useful for in-progress flows. */
  disableScrimClose?: boolean;
  /** Focus a specific control when opening; otherwise use the first control. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
  footer?: ReactNode;
}

export function Modal({
  portalContainer,
  open,
  onClose,
  title,
  description,
  size = "md",
  mobileLayout = "sheet",
  desktopLayout = "center",
  placement = "responsive",
  hideClose = false,
  disableScrimClose = false,
  initialFocusRef,
  children,
  footer,
}: ModalProps) {
  const layer = useOverlayLayer();
  const titleId = useId();
  const descId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap({ open, containerRef: dialogRef, onClose, initialFocusRef });

  // Body scroll lock + Esc + focus management
  useEffect(() => {
    if (!open) return;
    const unlockScroll = lockBodyScroll();
    return unlockScroll;
  }, [open]);

  if (!open) return null;
  if (typeof window === "undefined") return null;

  const onScrimClick = () => {
    if (!disableScrimClose) onClose();
  };

  const centerOnMobile = placement === "responsive" && mobileLayout === "center";
  const sideOnDesktop = placement === "responsive" && desktopLayout === "side";
  const sheetPlacement = placement === "right"
    ? "h-[100dvh] max-h-[100dvh] rounded-none border-y-0 border-r-0"
    : placement === "bottom"
      ? "max-h-[90dvh] rounded-t-2xl pb-[env(safe-area-inset-bottom,0px)]"
      : "";

  return createPortal(
    <OverlayLayerProvider value={layer}>
    <div
      style={{ zIndex: layer }}
      className={[
        "fixed inset-0 z-50 flex",
        placement === "right" ? "items-stretch justify-end" : placement === "bottom" ? "items-end justify-center" : [
          "justify-center",
          sideOnDesktop ? "sm:items-stretch sm:justify-end" : "sm:items-center sm:p-4",
          centerOnMobile ? "items-center p-4" : "items-end",
        ].join(" "),
      ].join(" ")}
      role="presentation"
    >
      {/* Keep mouse focus inside when a busy caller blocks dismissal. */}
      <button
        type="button"
        aria-label="Close dialog"
        tabIndex={-1}
        onMouseDown={event => event.preventDefault()}
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
          "relative w-full min-w-0 bg-bg-surface text-text border border-border shadow-[var(--shadow-card)]",
          "overflow-hidden flex flex-col",
          placement !== "responsive" ? sheetPlacement : [
          centerOnMobile ? "max-h-[85dvh]" : "max-h-[100dvh]",
          // The side panel spans the full height; 3xl gets more vertical
          // room for the build editor's timeline.
          sideOnDesktop
            ? "sm:h-[100dvh] sm:max-h-[100dvh]"
            : size === "3xl"
              ? "sm:max-h-[94vh]"
              : "sm:max-h-[85vh]",
          centerOnMobile
            ? "rounded-2xl"
            : sideOnDesktop
              ? "rounded-t-2xl sm:rounded-none sm:border-y-0 sm:border-r-0"
              : "rounded-t-2xl sm:rounded-xl",
          centerOnMobile
            ? "sm:pb-0"
            : "pb-[env(safe-area-inset-bottom,0px)]",
          ].join(" "),
          placement === "right" ? SIDE_SIZE_CLASSES[size] : SIZE_CLASSES[size],
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
              className="-mr-1.5 -mt-0.5 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-bg-elevated hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
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
    </div>
    </OverlayLayerProvider>,
    portalContainer ?? document.body,
  );
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
