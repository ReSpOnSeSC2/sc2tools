"use client";

import { useEffect, useRef, useState } from "react";
import { Clock, Lock, MapPin, Pencil, Plus, Star, Trash2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card, Skeleton } from "@/components/ui/Card";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import type { ClientApiError } from "@/lib/clientApi";
import { formatGameClock, NOTE_TEXT_MAX, undoInput, type NoteDto } from "@/lib/notes";
import { TagEditor } from "./TagEditor";
import type { GameNoteWorkspace } from "./useGameNoteWorkspace";

/** Quick-add tags for game moments. */
export const GAME_NOTE_TAGS = ["Mistake", "Macro", "Micro", "Scouting", "Build", "Highlight"] as const;

const message = (error: unknown) => (error as ClientApiError | undefined)?.message || "Please try again.";

/**
 * Private notes on one game, listed by game time: seek to a moment, edit,
 * tag, mark a key moment, delete with Undo. The composer opens from the
 * replay dock ("Add note at 4:12", shortcut B) or here, and "Pin on map"
 * takes the next click on the map. Never shared: share links and the Review
 * Exchange use their own allowlists.
 */
export function GameNotesPanel({ workspace, currentTime, onSeek }: {
  workspace: GameNoteWorkspace;
  currentTime: number;
  onSeek: (t: number) => void;
}) {
  const { notes, draft, startNote } = workspace;
  const [deleted, setDeleted] = useState<NoteDto | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const atLimit = notes.items.length >= notes.limit;

  const remove = async (note: NoteDto) => {
    setError("");
    try {
      const gone = await notes.remove(note.id);
      setDeleted(gone);
      setStatus(`Note at ${typeof gone.gameTimeSec === "number" ? formatGameClock(gone.gameTimeSec) : "no time"} deleted.`);
    } catch (err) { setError(`Couldn't delete the note. ${message(err)}`); }
  };
  const undo = async () => {
    if (!deleted) return;
    setError("");
    try {
      await notes.create(undoInput(deleted));
      setDeleted(null);
      setStatus("Note restored.");
    } catch (err) { setError(`Couldn't restore the note. ${message(err)}`); }
  };

  return (
    <Card aria-labelledby="game-notes-heading" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="game-notes-heading" className="font-display text-h3 font-bold">Game notes</h2>
          <span className="inline-flex items-center gap-1 rounded-full border border-border bg-bg-elevated px-2 py-0.5 text-micro uppercase tracking-wider text-text-muted"><Lock className="h-3 w-3" aria-hidden />Private</span>
          <span className="text-caption text-text-dim">{notes.items.length} of {notes.limit}</span>
          <LazyHelpLink slug="game-page-notes">Help</LazyHelpLink>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={atLimit} onClick={() => startNote(currentTime)} iconLeft={<Clock className="h-4 w-4" aria-hidden />} aria-keyshortcuts="B">Add note at {formatGameClock(currentTime)}</Button>
          <Button size="sm" variant="secondary" disabled={atLimit} onClick={() => startNote(null)} iconLeft={<Plus className="h-4 w-4" aria-hidden />}>General note</Button>
        </div>
      </div>
      <p className="text-caption text-text-muted">Only you can see these. Press B in the replay to note the current moment.</p>
      {atLimit ? <p role="status" className="text-caption text-warning">This game has the maximum of {notes.limit} notes.</p> : null}
      {draft ? <GameNoteComposer key={draft.seq} workspace={workspace} onSaved={(note) => setStatus(`Note saved${typeof note.gameTimeSec === "number" ? ` at ${formatGameClock(note.gameTimeSec)}` : ""}.`)} /> : null}
      <div aria-live="polite" className="text-caption">
        {status ? <p role="status" className="flex flex-wrap items-center gap-2 text-text-muted">{status}{deleted ? <Button size="sm" variant="ghost" onClick={() => void undo()} iconLeft={<Undo2 className="h-4 w-4" aria-hidden />}>Undo</Button> : null}</p> : null}
      </div>
      {error ? <p role="alert" className="text-caption text-danger">{error}</p> : null}
      {notes.isLoading && !notes.items.length ? <Skeleton rows={2} /> : notes.error ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-caption text-danger">Couldn&apos;t load your notes. <Button size="sm" variant="secondary" onClick={notes.retry}>Retry</Button></div>
      ) : notes.items.length ? (
        <ol className="space-y-2" aria-label="Notes on this game, by game time">
          {notes.items.map((note, index) => (
            <GameNoteRow key={note.id} note={note} number={index + 1} active={workspace.activeId === note.id} workspace={workspace} onSeek={onSeek} onDelete={() => void remove(note)} />
          ))}
        </ol>
      ) : !draft ? <p className="text-body text-text-muted">No notes on this game yet.</p> : null}
    </Card>
  );
}

function GameNoteComposer({ workspace, onSaved }: { workspace: GameNoteWorkspace; onSaved: (note: NoteDto) => void }) {
  const { draft, notes, picking, setPicking, cancelNote, setDraft } = workspace;
  const [text, setText] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { field.current?.focus({ preventScroll: false }); field.current?.scrollIntoView?.({ block: "nearest" }); }, []);
  if (!draft) return null;
  const save = async () => {
    if (busy || !text.trim()) return;
    setBusy(true); setError("");
    try {
      const note = await notes.create({ text, tags, gameTimeSec: draft.t, ...(draft.point ? { x: draft.point.x, y: draft.point.y } : {}) });
      cancelNote();
      onSaved(note);
    } catch (err) { setError(message(err)); }
    finally { setBusy(false); }
  };
  return (
    <form className="space-y-3 rounded-lg border-2 border-accent/40 bg-bg-elevated/40 p-3" onSubmit={(event) => { event.preventDefault(); void save(); }} aria-label="New game note">
      <div className="flex flex-wrap items-center gap-2 text-caption text-text-muted">
        <span className="inline-flex items-center gap-1 font-semibold text-text"><Clock className="h-4 w-4" aria-hidden />{draft.t === null ? "No game time" : `At ${formatGameClock(draft.t)}`}</span>
        {draft.t !== null ? <Button size="sm" variant="ghost" type="button" onClick={() => setDraft({ ...draft, t: null, point: null })}>Remove time</Button> : null}
        <Button size="sm" variant="secondary" type="button" aria-pressed={picking} onClick={() => setPicking(!picking)} iconLeft={<MapPin className="h-4 w-4" aria-hidden />}>{picking ? "Click the map…" : draft.point ? "Move pin" : "Pin on map"}</Button>
        {draft.point ? <Button size="sm" variant="ghost" type="button" onClick={() => setDraft({ ...draft, point: null })}>Remove pin</Button> : null}
      </div>
      {picking ? <p role="status" className="text-caption text-accent">Click or tap the replay map where this happened.</p> : null}
      <label className="block space-y-1 text-caption font-semibold">Note
        <textarea ref={field} value={text} maxLength={NOTE_TEXT_MAX} rows={3} onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void save(); } if (event.key === "Escape") cancelNote(); }}
          placeholder="What happened here, and what to do next time?"
          className="block min-h-[88px] w-full resize-y rounded-lg border border-border bg-bg px-3 py-2 text-body font-normal text-text placeholder:text-text-dim focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20" />
      </label>
      <TagEditor tags={tags} onChange={setTags} presets={GAME_NOTE_TAGS} disabled={busy} />
      {error ? <p role="alert" className="text-caption text-danger">Couldn&apos;t save the note. {error}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" type="submit" loading={busy} disabled={!text.trim()}>Save note</Button>
        <Button size="sm" variant="ghost" type="button" onClick={cancelNote}>Cancel</Button>
        <span className="text-micro text-text-dim">{text.length}/{NOTE_TEXT_MAX} · Ctrl+Enter to save · Esc to cancel</span>
      </div>
    </form>
  );
}

function GameNoteRow({ note, number, active, workspace, onSeek, onDelete }: {
  note: NoteDto; number: number; active: boolean; workspace: GameNoteWorkspace; onSeek: (t: number) => void; onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note.text);
  const [tags, setTags] = useState(note.tags);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const time = typeof note.gameTimeSec === "number" ? note.gameTimeSec : null;
  const patch = async (body: Parameters<GameNoteWorkspace["notes"]["update"]>[1], done?: () => void) => {
    setBusy(true); setError("");
    try { await workspace.notes.update(note.id, body); done?.(); }
    catch (err) { setError(message(err)); }
    finally { setBusy(false); }
  };
  return (
    <li id={`game-note-${note.id}`} className={`rounded-lg border p-3 ${active ? "border-accent bg-accent/5" : "border-border"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-bg-elevated px-1 text-micro font-semibold text-text-muted" aria-hidden>{number}</span>
        {time !== null ? (
          <Button size="sm" variant="secondary" onClick={() => { onSeek(time); workspace.setActiveId(note.id); }} aria-label={`Jump to ${formatGameClock(time)}`} iconLeft={<Clock className="h-4 w-4" aria-hidden />}>{formatGameClock(time)}</Button>
        ) : <span className="text-caption text-text-dim">No game time</span>}
        {typeof note.x === "number" ? <span className="inline-flex items-center gap-1 text-caption text-text-muted"><MapPin className="h-4 w-4" aria-hidden />Pinned on map</span> : null}
        <span className="ml-auto flex flex-wrap gap-1">
          <Button size="sm" variant="ghost" aria-pressed={note.pinned} aria-label={note.pinned ? "Unmark key moment" : "Mark as key moment"} disabled={busy} onClick={() => void patch({ pinned: !note.pinned })}><Star className={`h-4 w-4 ${note.pinned ? "fill-current text-warning" : ""}`} aria-hidden /></Button>
          <Button size="sm" variant="ghost" aria-label="Edit note" disabled={busy} onClick={() => { setText(note.text); setTags(note.tags); setEditing(!editing); }}><Pencil className="h-4 w-4" aria-hidden /></Button>
          <Button size="sm" variant="ghost" aria-label="Delete note" disabled={busy} onClick={onDelete}><Trash2 className="h-4 w-4" aria-hidden /></Button>
        </span>
      </div>
      {editing ? (
        <form className="mt-2 space-y-2" aria-label="Edit game note" onSubmit={(event) => { event.preventDefault(); if (text.trim()) void patch({ text, tags }, () => setEditing(false)); }}>
          <label className="block text-caption font-semibold">Note text
            <textarea value={text} maxLength={NOTE_TEXT_MAX} rows={3} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setEditing(false); }}
              className="mt-1 block w-full resize-y rounded-lg border border-border bg-bg px-3 py-2 text-body font-normal text-text focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20" />
          </label>
          <TagEditor tags={tags} onChange={setTags} presets={GAME_NOTE_TAGS} disabled={busy} />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" type="submit" loading={busy} disabled={!text.trim()}>Save changes</Button>
            <Button size="sm" variant="ghost" type="button" onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </form>
      ) : (
        <>
          <p className="mt-2 whitespace-pre-wrap break-words text-body text-text">{note.text}</p>
          {note.tags.length ? <p className="mt-1 flex flex-wrap gap-1">{note.tags.map((tag) => <span key={tag} className="rounded-full border border-border px-2 py-0.5 text-micro text-text-muted">{tag}</span>)}</p> : null}
        </>
      )}
      {error ? <p role="alert" className="mt-1 text-caption text-danger">{error}</p> : null}
    </li>
  );
}
