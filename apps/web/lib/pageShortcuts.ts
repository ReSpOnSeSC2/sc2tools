"use client";

import { useEffect, useSyncExternalStore } from "react";

/**
 * Keys a page adds while it is mounted, listed by the global "?" sheet
 * under "This page". Pages register descriptors here instead of binding
 * "?" a second time; the sheet reads the newest registration.
 */
export type PageShortcut = { keys: string; label: string };
export type PageShortcutSection = { title: string; items: readonly PageShortcut[] };

const EMPTY: readonly PageShortcutSection[] = [];
let entries: Array<{ token: symbol; sections: readonly PageShortcutSection[] }> = [];
let snapshot: readonly PageShortcutSection[] = EMPTY;
const listeners = new Set<() => void>();

function publish() {
  snapshot = entries.at(-1)?.sections ?? EMPTY;
  for (const listener of listeners) listener();
}

export function registerPageShortcuts(sections: readonly PageShortcutSection[]): () => void {
  const token = Symbol("page-shortcuts");
  entries = [...entries, { token, sections }];
  publish();
  return () => {
    entries = entries.filter((entry) => entry.token !== token);
    publish();
  };
}

export function currentPageShortcuts(): readonly PageShortcutSection[] {
  return snapshot;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Register while mounted. Pass a stable (module-level or memoized) array. */
export function usePageShortcuts(sections: readonly PageShortcutSection[]): void {
  useEffect(() => registerPageShortcuts(sections), [sections]);
}

export function usePageShortcutSections(): readonly PageShortcutSection[] {
  return useSyncExternalStore(subscribe, currentPageShortcuts, () => EMPTY);
}
