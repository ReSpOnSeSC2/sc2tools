"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { OpponentNotesValue } from "./OpponentNotesCard";
import { useUnsavedNote } from "./UnsavedNoteContext";

const same = (a: OpponentNotesValue, b: OpponentNotesValue) => a.notes === b.notes && a.notesReadAloud === b.notesReadAloud;

/** The caller keys its editor by owner and opponent, isolating pending work. */
export function useOpponentNoteDraft(pulseId: string, ownerId: string | null, server: OpponentNotesValue) {
  const key = `opponent-note-draft:${pulseId}`;
  const [draft, setState] = useState(server);
  const [baseline, setBaseline] = useState(server);
  const [restored, setRestored] = useState(false);
  const latest = useRef({ draft, baseline });
  latest.current = { draft, baseline };
  const dirty = !same(draft, baseline);
  const register = useUnsavedNote()?.register;

  const clear = useCallback(() => {
    try {
      const stored = sessionStorage.getItem(key);
      if (!stored || JSON.parse(stored).ownerId === ownerId) sessionStorage.removeItem(key);
    } catch { /* Storage may be unavailable. */ }
  }, [key, ownerId]);
  const persist = useCallback(() => {
    const value = latest.current;
    try {
      if (!same(value.draft, value.baseline)) sessionStorage.setItem(key, JSON.stringify({ ownerId, draft: value.draft }));
      else clear();
    } catch { /* The live draft remains available when storage is blocked. */ }
  }, [key, ownerId, clear]);
  const setDraft = useCallback((next: OpponentNotesValue | ((current: OpponentNotesValue) => OpponentNotesValue)) => {
    const value = typeof next === "function" ? next(latest.current.draft) : next;
    latest.current.draft = value; setState(value);
  }, []);

  useEffect(() => {
    const editing = !same(latest.current.draft, latest.current.baseline);
    latest.current.baseline = server; setBaseline(server);
    if (!editing) setDraft(server);
  }, [server, setDraft]);
  useEffect(() => {
    try {
      const stored = JSON.parse(sessionStorage.getItem(key) || "null");
      const value = stored?.draft;
      if (stored?.ownerId === ownerId && value && typeof value.notes === "string" && value.notes.length <= 500 && typeof value.notesReadAloud === "boolean" && !same(value, server)) {
        setDraft(value); setRestored(true);
      }
    } catch { /* An invalid entry never replaces a server value. */ }
    // Owner/opponent are immutable for this keyed editor; later server changes
    // update the baseline above without restoring over a live draft again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ownerId, setDraft]);
  useEffect(() => { if (!dirty) return; const timer = setTimeout(persist, 500); return () => clearTimeout(timer); }, [draft, dirty, persist]);
  useEffect(() => () => persist(), [persist]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { persist(); event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, persist]);

  const discard = useCallback(() => { setDraft(latest.current.baseline); setRestored(false); clear(); }, [setDraft, clear]);
  useEffect(() => { register?.({ dirty, discard }); return () => register?.({ dirty: false, discard: () => undefined }); }, [register, dirty, discard]);
  const saved = (canonical: OpponentNotesValue, submitted: OpponentNotesValue) => {
    const newer = !same(latest.current.draft, submitted);
    latest.current.baseline = canonical; setBaseline(canonical);
    if (!newer) setDraft(canonical);
    setRestored(false);
    if (newer) persist(); else clear();
    return newer;
  };
  return { draft, dirty, restored, setDraft, discard, saved };
}
