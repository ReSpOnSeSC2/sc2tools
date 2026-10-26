"use client";

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { canReturnFocus, focusableInside, handleFocusScopeKey, isFocusTrapRoot, registerFocusScope, removeFocusScope } from "./focusScopes";

const useClientLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;
/** Modal Tab containment and top-layer Escape, including nonmodal portals. */
export function useFocusTrap({ open, containerRef, onClose, initialFocusRef, returnFocusRef, trapFocus = true, autoFocus = true, restoreFocus = true }: {
  open: boolean;
  containerRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  initialFocusRef?: RefObject<HTMLElement | null>;
  returnFocusRef?: RefObject<HTMLElement | null>;
  /** Nonmodal layers own Escape while the enclosing modal still owns Tab. */
  trapFocus?: boolean;
  /** A lazy consumer can keep its own ready-and-merged initial focus timing. */
  autoFocus?: boolean;
  /** if-lost waits for the pointer's native focus action before restoring. */
  restoreFocus?: boolean | "if-lost" | (() => boolean | "if-lost");
}) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const restoreRef = useRef(restoreFocus); restoreRef.current = restoreFocus;
  const restoreEpoch = useRef(0);
  const afterCommit = useRef<(() => void) | null>(null);
  useClientLayoutEffect(() => {
    if (!open) return;
    const scope = containerRef.current;
    if (!scope) return;
    const epoch = ++restoreEpoch.current;
    afterCommit.current = null;
    const record = registerFocusScope(scope, trapFocus, returnFocusRef?.current ?? document.activeElement);
    const onKey = (event: KeyboardEvent) => handleFocusScopeKey(record, event, () => onCloseRef.current());
    document.addEventListener("keydown", onKey);
    // Focus in the same commit. A zero-delay timer leaves a frame where a
    // newly opened child still sends Escape to its parent's focused button.
    if (autoFocus) (initialFocusRef?.current ?? focusableInside(scope)[0] ?? scope).focus();
    return () => {
      // React may already have detached the closing root before cleanup.
      const wasTop = removeFocusScope(record);
      document.removeEventListener("keydown", onKey);
      const shouldRestore = typeof restoreRef.current === "function" ? restoreRef.current() : restoreRef.current;
      if (!wasTop || !shouldRestore) return;
      const before = document.activeElement;
      const restore = () => {
        const target = record.previous;
        const active = document.activeElement;
        const lost = !active || active === document.body || !active.isConnected
          || (shouldRestore === "if-lost" && isFocusTrapRoot(active));
        if (restoreEpoch.current !== epoch || !(target instanceof HTMLElement) || !target.isConnected || !canReturnFocus(target)) return;
        if (lost || (shouldRestore !== "if-lost" && active === before)) target.focus();
      };
      if (shouldRestore === "if-lost") {
        // Pointer default focus happens after React's close commit.
        window.setTimeout(restore, 0);
      } else {
        restore();
        // React can restore the commit's earlier selection after cleanup.
        // Retry in layout for controlled closes, or a microtask on unmount.
        afterCommit.current = restore;
        queueMicrotask(() => { if (afterCommit.current === restore) { afterCommit.current = null; restore(); } });
      }
    };
  }, [open, containerRef, initialFocusRef, returnFocusRef, trapFocus, autoFocus]);
  useClientLayoutEffect(() => {
    const restore = afterCommit.current;
    afterCommit.current = null;
    restore?.();
  });
}
