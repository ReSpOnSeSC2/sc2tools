"use client";

import { useEffect, type RefObject } from "react";

const targets = new Set<HTMLInputElement>();
export function hasPageSearchTarget(): boolean { return targets.size > 0; }

export function usePageSearchShortcut(ref: RefObject<HTMLInputElement | null>) {
  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    targets.add(input);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
      const active = document.activeElement;
      if (active?.matches("input, textarea, select, [contenteditable]:not([contenteditable='false'])")
        || active?.closest("[contenteditable='true']")
        || Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], dialog[open]')).some((dialog) => !dialog.hidden && dialog.getAttribute("aria-hidden") !== "true")) return;
      event.preventDefault(); input.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => { targets.delete(input); document.removeEventListener("keydown", onKey); };
  }, [ref]);
}
