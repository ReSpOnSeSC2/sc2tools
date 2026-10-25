"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall, boundedApiRequest } from "@/lib/clientApi";
import { useFocusTrap } from "@/lib/a11y/useFocusTrap";
import { Button } from "@/components/ui/Button";

/** Keyed by owner/opponent by the parent, so a pending note never changes target. */
export function ScoutingNotePopover({ pulseId, initialNote, readAloud }: { pulseId: string; initialNote: string; readAloud: boolean }) {
  const { getToken } = useAuth();
  const [open, setOpen] = useState(false), [note, setNote] = useState(initialNote), [saved, setSaved] = useState(initialNote);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const dialog = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const request = useRef<AbortController | null>(null), active = useRef(true);
  const previousInitial = useRef(initialNote);
  const [position, setPosition] = useState({ left: 8, top: 80, width: 320, maxHeight: 500 });
  useEffect(() => {
    if (initialNote === previousInitial.current) return;
    previousInitial.current = initialNote;
    if (busy || note !== saved) return;
    setNote(initialNote); setSaved(initialNote);
  }, [initialNote, note, saved, busy]);
  useLayoutEffect(() => { active.current = true; return () => { active.current = false; request.current?.abort(); }; }, []);
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const rect = trigger.current?.getBoundingClientRect(); if (!rect) return;
      const width = Math.min(400, window.innerWidth - 16), top = Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - 280));
      setPosition({ width, left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), top, maxHeight: window.innerHeight - top - 8 });
    };
    update(); window.addEventListener("resize", update); window.addEventListener("scroll", update, true);
    return () => { window.removeEventListener("resize", update); window.removeEventListener("scroll", update, true); };
  }, [open]);
  useFocusTrap({ open, containerRef: dialog, onClose: () => setOpen(false) });
  const save = async () => {
    if (busy || note === saved) return;
    const submitted = note, controller = new AbortController(); request.current = controller; setBusy(true); setError("");
    try {
      const result = await boundedApiRequest(signal => apiCall<{ notes: string }>(getToken, `/v1/opponents/${encodeURIComponent(pulseId)}/notes`, {
        method: "PUT", signal, body: JSON.stringify({ notes: submitted, notesReadAloud: readAloud }),
      }), 15_000, controller.signal);
      if (!active.current || controller.signal.aborted) return;
      if (typeof result.notes !== "string") throw new Error("Invalid note response");
      setSaved(result.notes); setNote(previous => previous === submitted ? result.notes : previous);
    } catch { if (active.current && !controller.signal.aborted) setError("Couldn’t save this note. Your draft is kept; try again."); }
    finally { if (active.current) setBusy(false); }
  };
  return <div>
    <Button ref={trigger} variant="secondary" size="sm" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>Add note</Button>
    {open ? <><button type="button" tabIndex={-1} aria-label="Close opponent note" className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
      <div ref={dialog} role="dialog" aria-modal="true" aria-label="Opponent note" tabIndex={-1} style={position} className="fixed z-40 space-y-3 overflow-y-auto rounded-xl border-2 border-line bg-bg-surface p-4 text-text shadow-card">
        <label className="block space-y-2 text-caption font-semibold">Note for next meeting<textarea value={note} maxLength={500} rows={4} onChange={event => setNote(event.target.value)} className="block w-full resize-y rounded-lg border border-border bg-bg px-3 py-2 text-body" /></label>
        <p className="text-caption text-text-muted">{note.length}/500 · Also appears on your scouting widget.</p>
        {error ? <p role="alert" className="text-caption text-danger">{error}</p> : null}
        <div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy || note === saved} onClick={() => void save()}>{busy ? "Saving…" : "Save note"}</Button><Button size="sm" variant="secondary" onClick={() => setOpen(false)}>Done</Button></div>
        {note === saved ? <p role="status" className="text-caption text-text-muted">{saved === initialNote ? "No unsaved changes" : "Saved for next meeting"}</p> : null}
      </div></> : null}
  </div>;
}
