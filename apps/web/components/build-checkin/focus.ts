import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Nothing on the page has focus any more: the focused control unmounted
 * (focus fell back to `<body>`). Focus is only moved back for the player
 * then, never taken from wherever they went meanwhile.
 */
export function focusWasLost(): boolean {
  const active = document.activeElement;
  return !active || active === document.body || !active.isConnected;
}

/**
 * Focus for a check-in row whose picker opens and closes in place.
 *
 * - When the picker closes and its controls took focus with them,
 *   "Change…" (`changeRef`) takes it.
 * - When a failed "Add new build" check-in reopens the picker while focus
 *   is lost, the picker's search box (inside `rowRef`) takes it once the
 *   row is usable again.
 *
 * Nothing moves while the build editor dialog is open: the move waits until
 * it closes, after the dialog had its chance to restore focus itself.
 */
export function usePickerRowFocus({
  picking,
  busy,
  editorOpen,
}: {
  picking: boolean;
  busy: boolean;
  editorOpen: boolean;
}) {
  const changeRef = useRef<HTMLButtonElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const returnToChange = useRef(false);
  const returnToPicker = useRef(false);
  // A request re-runs the check even when nothing else changed.
  const [requested, setRequested] = useState(0);

  useEffect(() => {
    if (editorOpen) return;
    if (!picking && returnToChange.current) {
      returnToChange.current = false;
      if (focusWasLost()) changeRef.current?.focus();
    }
    if (picking && !busy && returnToPicker.current) {
      returnToPicker.current = false;
      if (focusWasLost()) {
        rowRef.current
          ?.querySelector<HTMLElement>('[role="combobox"]')
          ?.focus({ preventScroll: true });
      }
    }
  }, [picking, busy, editorOpen, requested]);

  /** The picker is closing: "Change…" takes focus if it is lost. */
  const returnOnClose = useCallback(() => {
    returnToChange.current = true;
    returnToPicker.current = false;
    setRequested((count) => count + 1);
  }, []);
  /** The picker reopened from outside: its search box takes lost focus. */
  const returnToPickerIfLost = useCallback(() => {
    if (!focusWasLost()) return;
    returnToPicker.current = true;
    setRequested((count) => count + 1);
  }, []);

  return { changeRef, rowRef, returnOnClose, returnToPickerIfLost };
}
