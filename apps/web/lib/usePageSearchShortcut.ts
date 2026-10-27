"use client";

import { useEffect, type RefObject } from "react";
import { hasActiveFocusScope } from "./a11y/focusScopes";

const targets = new Set<HTMLInputElement>();
function shown(element: HTMLElement): boolean {
  if (!element.isConnected || element.closest("[hidden],[inert],[aria-hidden='true']")) return false;
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    if (node.tagName === "DETAILS" && !node.hasAttribute("open")
      && !Array.from(node.children).find(child => child.tagName === "SUMMARY")?.contains(element)) return false;
    const style = window.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse"
      || style.opacity === "0") return false;
  }
  return true;
}
function pageTarget() { return Array.from(targets).findLast(input => !input.matches(":disabled") && shown(input)); }
export function hasPageSearchTarget(): boolean { return Boolean(pageTarget()); }
export function focusPageSearchTarget(): boolean {
  const input = pageTarget();
  if (!input) return false;
  input.focus(); return document.activeElement === input;
}
export function searchShortcutBlocked(event: KeyboardEvent): boolean {
  const active = document.activeElement, target = event.target;
  const editing = (element: EventTarget | null) => element instanceof Element && Boolean(element.closest(
    "input,textarea,select,[contenteditable]:not([contenteditable='false'])",
  ));
  return event.defaultPrevented || event.isComposing || event.repeat || event.altKey || editing(active) || editing(target)
    || hasActiveFocusScope() || Array.from(document.querySelectorAll<HTMLElement>(
      '[role="dialog"],dialog[open],[role="menu"],[role="listbox"]',
    )).some(shown);
}
function onPageKey(event: KeyboardEvent) {
  if (event.key !== "/" || event.ctrlKey || event.metaKey || searchShortcutBlocked(event)) return;
  if (focusPageSearchTarget()) event.preventDefault();
}

export function usePageSearchShortcut(ref: RefObject<HTMLInputElement | null>) {
  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    targets.add(input);
    if (targets.size === 1) document.addEventListener("keydown", onPageKey);
    return () => { targets.delete(input); if (!targets.size) document.removeEventListener("keydown", onPageKey); };
  }, [ref]);
}
