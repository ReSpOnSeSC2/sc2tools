"use client";

import { useCallback, useEffect, useState } from "react";
import type { DockPost } from "./dockActions";
import { DockButton } from "./DockControls";

type Surface = "clips" | "game";
type UndoMark = { token: string; previous: number; expected: number | null; surface: Surface; expiresAt: number };

export function useDockMarkUndo(token: string, current: number | null, post: DockPost) {
  const [entry, setEntry] = useState<UndoMark | null>(null);
  const active = entry?.token === token && entry.expected === current ? entry : null;
  useEffect(() => {
    if (!entry) return;
    const timer = setTimeout(() => setEntry((value) => value === entry ? null : value), Math.max(0, entry.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [entry]);
  const offer = useCallback((previous: number, expected: number | null, surface: Surface) => {
    setEntry({ token, previous, expected, surface, expiresAt: Date.now() + 8000 });
  }, [token]);
  async function undo() {
    if (!active || Date.now() >= active.expiresAt) return;
    const restored = await post({ streamMarkUndo: { expected: active.expected, previous: active.previous } });
    if (restored) setEntry((value) => value === active ? null : value);
  }
  return { active, offer, undo };
}

export function DockMarkUndoNotice({ surface, busy, undo }: { surface: Surface; busy: boolean; undo: () => void }) {
  return <span role="status" className="inline-flex flex-wrap items-center gap-2 text-caption text-text-muted">
    {surface === "clips" ? "Stream start cleared" : "Stream start replaced"}
    <DockButton disabled={busy} onClick={undo}>Undo</DockButton>
  </span>;
}
