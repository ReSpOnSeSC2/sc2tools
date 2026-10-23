"use client";

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

const useClientLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;
const scopes: HTMLElement[] = [];
const topScope = () => scopes.findLast((scope) => scope.isConnected);

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
  useClientLayoutEffect(() => {
    if (!open) return;
    const scope = containerRef.current;
    if (!scope) return;
    const previous = document.activeElement;
    scopes.push(scope);
    const onKey = (event: KeyboardEvent) => {
      const root = containerRef.current;
      if (!root || topScope() !== root) return;
      const target = event.target instanceof Element ? event.target : document.activeElement;
      const activeDialog = target?.closest('[role="dialog"]');
      if (activeDialog && activeDialog !== root) return;
      if (event.key === "Escape") {
        event.preventDefault();
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
    // Focus in the same commit. A zero-delay timer leaves a frame where a
    // newly opened child still sends Escape to its parent's focused button.
    (initialFocusRef?.current ?? focusableInside(scope)[0] ?? scope).focus();
    return () => {
      // React may already have detached the closing root before cleanup.
      const wasTop = scopes.at(-1) === scope;
      const index = scopes.lastIndexOf(scope);
      if (index >= 0) scopes.splice(index, 1);
      document.removeEventListener("keydown", onKey);
      if (wasTop && previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [open, containerRef, initialFocusRef]);
}
