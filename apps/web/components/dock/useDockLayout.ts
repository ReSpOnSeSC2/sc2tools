"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { defaultDockLayout, normalizeDockLayout, readDockLayout, writeDockLayout, type DockLayout, type DockSectionId } from "@/lib/dockLayout";

export function useDockLayout() {
  const [layout, setLayout] = useState(defaultDockLayout), [hydrated, setHydrated] = useState(false);
  const current = useRef(layout);
  useEffect(() => {
    // Merely opening a Dock never overwrites its saved layout with defaults.
    let saved = defaultDockLayout();
    try { saved = readDockLayout(window.localStorage); } catch { /* Storage accessor itself may throw. */ }
    current.current = saved; setLayout(saved); setHydrated(true);
  }, []);
  const update = useCallback((change: (previous: DockLayout) => DockLayout) => {
    const next = normalizeDockLayout(change(current.current)); current.current = next; setLayout(next);
    try { writeDockLayout(window.localStorage, next); } catch { /* Keep the local control usable. */ }
  }, []);
  const setOpen = useCallback((id: DockSectionId, open: boolean) => update(previous => ({ ...previous,
    collapsed: open ? previous.collapsed.filter(value => value !== id) : previous.collapsed.includes(id) ? previous.collapsed : [...previous.collapsed, id],
  })), [update]);
  const togglePin = useCallback((id: DockSectionId) => update(previous => ({ ...previous,
    pinned: previous.pinned.includes(id) ? previous.pinned.filter(value => value !== id) : [...previous.pinned, id],
  })), [update]);
  const setBrollOpen = useCallback((open: boolean) => update(previous => ({ ...previous, brollOpen: open })), [update]);
  const reset = useCallback(() => update(defaultDockLayout), [update]);
  return { layout, hydrated, setOpen, togglePin, setBrollOpen, reset };
}
