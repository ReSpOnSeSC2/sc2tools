"use client";

import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR = ["a[href]", "button:not([disabled])", "input:not([disabled])", "select:not([disabled])", "textarea:not([disabled])", "[tabindex]:not([tabindex='-1'])"].join(",");

function focusableInside(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((el) => {
    if (el.hasAttribute("data-focus-trap-skip") || el.tabIndex < 0 || el.matches(":disabled") || el.closest("[hidden],[inert],[aria-hidden='true']")) return false;
    // Responsive close buttons and collapsed groups may be in the DOM while
    // hidden. Focusing those leaves the keyboard outside the active dialog.
    for (let node: HTMLElement | null = el; node && node !== root.parentElement; node = node.parentElement) {
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return true;
  });
}

/** Shared dialog/popover keyboard scope, including portalled child dialogs. */
export function useFocusTrap({ open, containerRef, onClose, initialFocusRef }: {
  open: boolean;
  containerRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  initialFocusRef?: RefObject<HTMLElement | null>;
}) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    const onKey = (event: KeyboardEvent) => {
      const root = containerRef.current;
      if (!root) return;
      const target = event.target instanceof Element ? event.target : document.activeElement;
      const activeDialog = target?.closest('[role="dialog"]');
      if (activeDialog && activeDialog !== root) return;
      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current();
      } else if (event.key === "Tab") {
        const elements = focusableInside(root);
        if (!elements.length) { event.preventDefault(); root.focus(); return; }
        const first = elements[0];
        const last = elements[elements.length - 1];
        const active = document.activeElement;
        if (event.shiftKey && (active === first || !root.contains(active))) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && (active === last || !root.contains(active))) {
          event.preventDefault(); first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    const initial = window.setTimeout(() => (initialFocusRef?.current ?? focusableInside(containerRef.current)[0] ?? containerRef.current)?.focus(), 0);
    return () => {
      window.clearTimeout(initial);
      document.removeEventListener("keydown", onKey);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [open, containerRef, initialFocusRef]);
}
