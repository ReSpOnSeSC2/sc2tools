"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall, boundedApiRequest } from "@/lib/clientApi";
import { useFocusTrap } from "@/lib/a11y/useFocusTrap";
import { Button } from "@/components/ui/Button";
import { Toggle } from "@/components/ui/Toggle";

/** Keyed by owner/opponent by the parent, so a pending note never changes target.
 * The quick note on the live brief and the game header: the text plus whether
 * it may appear on stream (private unless turned on). Tags, read-aloud and
 * scope are kept as stored; the dossier edits them. */
export function ScoutingNotePopover({ pulseId, initialNote, initialVisibility = "private", onOpenChange, label = "Add note" }: {
  pulseId: string; initialNote: string; initialVisibility?: "stream" | "private"; onOpenChange: (open: boolean) => void; label?: string;
}) {
  const { getToken } = useAuth();
  const [open, setOpen] = useState(false), [note, setNote] = useState(initialNote), [saved, setSaved] = useState(initialNote);
  const [visibility, setVisibility] = useState(initialVisibility), [savedVisibility, setSavedVisibility] = useState(initialVisibility);
  const unchanged = note === saved && visibility === savedVisibility;
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const dialog = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const request = useRef<AbortController | null>(null), active = useRef(true);
  const previousInitial = useRef(initialNote), previousVisibility = useRef(initialVisibility);
  const toggle = (next: boolean) => { setOpen(next); onOpenChange(next); };
  const [position, setPosition] = useState({ left: 8, top: 80, width: 320, maxHeight: 500 });
  useEffect(() => {
    if (initialNote === previousInitial.current) return;
    previousInitial.current = initialNote;
    if (busy || note !== saved) return;
    setNote(initialNote); setSaved(initialNote);
  }, [initialNote, note, saved, busy]);
  useEffect(() => {
    if (initialVisibility === previousVisibility.current) return;
    previousVisibility.current = initialVisibility;
    if (busy || visibility !== savedVisibility) return;
    setVisibility(initialVisibility); setSavedVisibility(initialVisibility);
  }, [initialVisibility, visibility, savedVisibility, busy]);
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
  useFocusTrap({ open, containerRef: dialog, onClose: () => toggle(false) });
  const save = async () => {
    if (busy || unchanged) return;
    const submitted = note, submittedVisibility = visibility, controller = new AbortController(); request.current = controller; setBusy(true); setError("");
    try {
      const result = await boundedApiRequest(signal => apiCall<{ notes: string; note?: { visibility?: string } | null }>(getToken, `/v1/opponents/${encodeURIComponent(pulseId)}/notes`, {
        method: "PUT", signal, body: JSON.stringify({ notes: submitted, preserveReadAloud: true, ...(submittedVisibility !== savedVisibility ? { visibility: submittedVisibility } : {}) }),
      }), 15_000, controller.signal);
      if (!active.current || controller.signal.aborted) return;
      if (typeof result.notes !== "string") throw new Error("Invalid note response");
      const stored = result.note?.visibility === "stream" ? "stream" : result.note ? "private" : submittedVisibility;
      setSaved(result.notes); setNote(previous => previous === submitted ? result.notes : previous);
      setSavedVisibility(stored); setVisibility(previous => previous === submittedVisibility ? stored : previous);
    } catch { if (active.current && !controller.signal.aborted) setError("Couldn’t save this note. Your draft is kept; try again."); }
    finally { if (active.current) setBusy(false); }
  };
  return <div>
    <Button ref={trigger} variant="secondary" size="sm" aria-haspopup="dialog" aria-expanded={open} onClick={() => toggle(!open)}>{label}</Button>
    {open ? <><button type="button" tabIndex={-1} aria-label="Close opponent note" className="fixed inset-0 z-30" onClick={() => toggle(false)} />
      <div ref={dialog} role="dialog" aria-modal="true" aria-label="Opponent note" tabIndex={-1} style={position} className="fixed z-40 space-y-3 overflow-y-auto rounded-xl border-2 border-line bg-bg-surface p-4 text-text shadow-card">
        <label className="block space-y-2 text-caption font-semibold">Note for next meeting<textarea value={note} maxLength={500} rows={4} onChange={event => setNote(event.target.value)} className="block w-full resize-y rounded-lg border border-border bg-bg px-3 py-2 text-body" /></label>
        <div className="flex min-h-11 items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"><span className="text-caption"><span className="block font-semibold">Show on stream</span><span className="block text-text-muted">{visibility === "stream" ? "Appears on your scouting widget" : "Private to you"}</span></span><Toggle checked={visibility === "stream"} onChange={checked => setVisibility(checked ? "stream" : "private")} label="Show this note on stream" /></div>
        <p className="text-caption text-text-muted">{note.length}/500 · {visibility === "stream" ? "Viewers can see this on your scouting widget." : "Only you can see this note."}</p>
        {error ? <p role="alert" className="text-caption text-danger">{error}</p> : null}
        <div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy || unchanged} onClick={() => void save()}>{busy ? "Saving…" : "Save note"}</Button><Button size="sm" variant="secondary" onClick={() => toggle(false)}>Done</Button></div>
        {unchanged ? <p role="status" className="text-caption text-text-muted">{saved === initialNote && savedVisibility === initialVisibility ? "No unsaved changes" : "Saved for next meeting"}</p> : null}
      </div></> : null}
  </div>;
}
