"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAuth } from "@clerk/nextjs";
import { Eye, EyeOff, Lock, Save, StickyNote, Users, Volume2, VolumeX } from "lucide-react";
import { apiCall, type ClientApiError } from "@/lib/clientApi";
import { Button } from "@/components/ui/Button";
import { Card, Skeleton } from "@/components/ui/Card";
import { Toggle } from "@/components/ui/Toggle";
import { useToastOptional } from "@/components/ui/Toast";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { TagEditor } from "@/components/notes/TagEditor";
import { effectiveVisibility, hasPrivateTag, NOTE_TEXT_MAX, opponentNotePath, type NoteDto, type NoteScope, type NoteVisibility } from "@/lib/notes";
import { useLocalStorageState } from "@/lib/useLocalStorageState";
import { useOpponentNoteDraft } from "./useOpponentNoteDraft";
import { formatNumber } from "@/lib/i18n/format";

export const OPPONENT_NOTES_MAX_LENGTH = NOTE_TEXT_MAX;

export type OpponentNotesValue = {
  notes: string;
  notesReadAloud: boolean;
  tags: string[];
  visibility: NoteVisibility;
  scope: NoteScope;
};

type OpponentNotesCardProps = {
  pulseId: string;
  initialNotes?: string | null;
  initialNotesReadAloud?: boolean;
  /** The account's own note from the dossier (tags, visibility, scope). */
  initialNote?: NoteDto | null;
  /** Player-scope notes written on this player's other accounts. */
  linkedNotes?: NoteDto[];
  /** Deterministic suggestions from your games; never applied for you. */
  suggestedTags?: string[];
  onSaved?: (value: OpponentNotesValue, note: NoteDto | null) => void;
  headingLevel?: 2 | 3;
};

/** The note as the server holds it, falling back to the legacy text pair. */
export function opponentNoteValue(note: NoteDto | null | undefined, legacyText?: string | null, legacyReadAloud?: boolean): OpponentNotesValue {
  if (note) {
    return { notes: note.text, notesReadAloud: note.readAloud && note.streamEligible, tags: note.tags, visibility: note.visibility, scope: note.scope };
  }
  const notes = typeof legacyText === "string" ? legacyText : "";
  // An older API without the note object only ever showed notes on stream.
  return { notes, notesReadAloud: Boolean(legacyReadAloud) && Boolean(notes.trim()), tags: [], visibility: notes.trim() ? "stream" : "private", scope: "account" };
}

/**
 * Per-opponent scouting note editor: text, tags, whether it may appear on
 * your stream, and whether it follows the player's other accounts.
 *
 * Only notes with **Show on stream** on (and no private tag such as Toxic)
 * reach the OBS scouting widget; everything else stays in your own views.
 * Read aloud adds a stream note to the browser-speech readout; the global
 * Voice switch remains the master control for every spoken overlay event.
 */
export function OpponentNotesCard(props: OpponentNotesCardProps) {
  const { userId, isLoaded } = useAuth();
  if (isLoaded === false) return <Skeleton rows={3} />;
  return <OpponentNotesEditor key={`${userId || "local"}:${props.pulseId}`} ownerId={userId || null} {...props} />;
}

function OpponentNotesEditor({
  pulseId,
  initialNotes,
  initialNotesReadAloud = false,
  initialNote,
  linkedNotes = [],
  suggestedTags = [],
  onSaved,
  ownerId,
  headingLevel = 2,
}: OpponentNotesCardProps & { ownerId: string | null }) {
  const { getToken } = useAuth();
  const toastContext = useToastOptional();
  const serverValue = useMemo<OpponentNotesValue>(
    () => opponentNoteValue(initialNote, initialNotes, initialNotesReadAloud),
    [initialNote, initialNotes, initialNotesReadAloud],
  );
  const editor = useOpponentNoteDraft(pulseId, ownerId, serverValue);
  const { draft, dirty, restored, setDraft, discard } = editor;
  const [saving, setSaving] = useState(false);
  const [savedMessage, setSavedMessage] = useState("");
  const [saveFailed, setSaveFailed] = useState(false);
  const [macShortcut, setMacShortcut] = useState(false);
  const [explained, setExplained] = useLocalStorageState("notes.streamExplainerDismissed", false, (raw): raw is boolean => typeof raw === "boolean");
  useEffect(() => { setMacShortcut(/Mac|iPhone|iPad/.test(navigator.platform)); }, []);

  const active = useRef(true);
  const request = useRef<AbortController | null>(null);
  useEffect(() => { active.current = true; return () => { active.current = false; request.current?.abort(); }; }, []);
  const remaining = OPPONENT_NOTES_MAX_LENGTH - draft.notes.length;
  const lockedPrivate = hasPrivateTag(draft.tags);
  const visibility = effectiveVisibility(draft.visibility, draft.tags);
  const onStream = visibility === "stream" && Boolean(draft.notes.trim());
  const edit = (patch: Partial<OpponentNotesValue>) => {
    setDraft((current) => {
      const next = { ...current, ...patch };
      const stream = effectiveVisibility(next.visibility, next.tags) === "stream" && Boolean(next.notes.trim());
      return { ...next, notesReadAloud: stream ? next.notesReadAloud : false };
    });
    setSavedMessage("");
    setSaveFailed(false);
  };

  async function save() {
    if (!dirty || saving) return;
    setSaving(true);
    setSavedMessage("");
    setSaveFailed(false);
    const submitted = { ...draft };
    const controller = new AbortController(); request.current = controller;
    try {
      const saved = await apiCall<{ notes?: string; notesReadAloud?: boolean; note?: NoteDto | null }>(
        getToken,
        opponentNotePath(pulseId),
        {
          method: "PUT",
          body: JSON.stringify({
            notes: submitted.notes,
            notesReadAloud: submitted.notesReadAloud,
            tags: submitted.tags,
            visibility: effectiveVisibility(submitted.visibility, submitted.tags),
            scope: submitted.scope,
          }),
          signal: controller.signal,
        },
      );
      if (!active.current) return;
      const note = saved.note ?? null;
      const canonical = opponentNoteValue(note, typeof saved.notes === "string" ? saved.notes : "", saved.notesReadAloud === true);
      const newer = editor.saved(canonical, submitted);
      setSavedMessage(newer ? "Saved. You have newer unsaved changes." : "Saved just now");
      setSaveFailed(false);
      onSaved?.(canonical, note);
      toastContext?.toast.success("Opponent notes saved");
    } catch (error) {
      if (!active.current || controller.signal.aborted) return;
      const message =
        (error as ClientApiError | undefined)?.message ?? "Please try again.";
      toastContext?.toast.error("Couldn't save opponent notes", {
        description: message,
      });
      setSavedMessage(message);
      setSaveFailed(true);
    } finally {
      if (active.current) setSaving(false);
    }
  }

  const Heading = headingLevel === 3 ? "h3" : "h2";
  const showExplainer = !explained && initialNote?.migrated === true && initialNote.visibility === "stream";
  return (
    <Card
      variant="feature"
      aria-labelledby="opponent-notes-title"
      className="relative"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <StickyNote className="h-4 w-4 text-accent" aria-hidden />
          <Heading
            id="opponent-notes-title"
            className="text-caption font-semibold uppercase tracking-wider text-text"
          >
            Opponent notes
          </Heading>
          <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-micro uppercase tracking-wider ${onStream ? "border-accent/30 bg-accent/10 text-accent" : "border-border bg-bg-elevated text-text-muted"}`}>
            {onStream ? <Eye className="h-3 w-3" aria-hidden /> : <Lock className="h-3 w-3" aria-hidden />}
            {onStream ? "Shows on stream" : "Private"}
          </span>
          <LazyHelpLink slug="opponent-notes">Help</LazyHelpLink>
        </div>
        <p className="mt-1 text-xs text-text-muted">
          {serverValue.notes ? "Keep the read short and actionable." : "Write a note about this opponent."} Notes stay in your own views unless you turn on Show on stream.
        </p>
      </div>

      {showExplainer ? (
        <div role="status" className="mt-3 flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-caption text-text sm:flex-row sm:items-center sm:justify-between">
          <p>This note was written before private notes existed, so it still shows on your scouting widget, as it always did. Turn off Show on stream to keep it to yourself.</p>
          <Button variant="secondary" size="sm" onClick={() => setExplained(true)}>Got it</Button>
        </div>
      ) : null}

      <div className="mt-4">
        {restored ? <p role="status" className="mb-2 text-caption text-warning">Unsaved draft restored · <button type="button" className="min-h-11 underline" onClick={discard}>Discard restored draft</button></p> : null}
        <label
          htmlFor={`opponent-notes-${pulseId}`}
          className="sr-only"
        >
          Scouting notes for this opponent
        </label>
        <textarea
          id={`opponent-notes-${pulseId}`}
          value={draft.notes}
          maxLength={OPPONENT_NOTES_MAX_LENGTH}
          rows={4}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void save(); }
          }}
          placeholder="Example: Hides tech after early pressure. Check dead air behind the natural at 3:30."
          onChange={(event) => edit({ notes: event.target.value })}
          className="min-h-[112px] w-full resize-y rounded-lg border-2 border-line bg-bg px-3 py-2 text-sm leading-relaxed text-text shadow-inner transition-colors placeholder:text-text-dim focus:border-accent focus:ring-2 focus:ring-accent/20"
        />
      </div>

      <div className="mt-3">
        <TagEditor tags={draft.tags} onChange={(tags) => edit({ tags })} suggestions={suggestedTags} suggestionHint="From your games" disabled={saving} />
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        <ToggleRow
          icon={visibility === "stream" ? <Eye className="h-4 w-4 text-accent" aria-hidden /> : <EyeOff className="h-4 w-4 text-text-dim" aria-hidden />}
          title="Show on stream"
          detail={lockedPrivate ? "Toxic notes are always private" : "Your OBS scouting widget"}
          checked={visibility === "stream"}
          disabled={saving || lockedPrivate}
          onChange={(checked) => edit({ visibility: checked ? "stream" : "private" })}
          label="Show this note on stream"
        />
        <ToggleRow
          icon={draft.notesReadAloud ? <Volume2 className="h-4 w-4 text-accent" aria-hidden /> : <VolumeX className="h-4 w-4 text-text-dim" aria-hidden />}
          title="Read aloud"
          detail="Stream notes · Voice → Scouting Report"
          checked={draft.notesReadAloud}
          disabled={!onStream || saving}
          onChange={(checked) => edit({ notesReadAloud: checked })}
          label="Read opponent notes aloud"
        />
        <ToggleRow
          icon={<Users className={`h-4 w-4 ${draft.scope === "player" ? "text-accent" : "text-text-dim"}`} aria-hidden />}
          title="All their accounts"
          detail="Follows linked alts"
          checked={draft.scope === "player"}
          disabled={saving}
          onChange={(checked) => edit({ scope: checked ? "player" : "account" })}
          label="Show this note on the player's other linked accounts"
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3 text-xs text-text-dim">
          {remaining < 100 ? <span className={`tabular-nums ${remaining === 0 ? "text-danger" : ""}`}>
            {formatNumber(remaining)} characters left
          </span> : null}
          <span>{macShortcut ? "⌘+Enter" : "Ctrl+Enter"} to save</span>
          <span
            role={saveFailed ? "alert" : "status"}
            aria-live="polite"
            className={saveFailed ? "text-danger" : "text-success"}
          >
            {savedMessage}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {dirty ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={() => {
                discard();
                setSavedMessage("");
                setSaveFailed(false);
              }}
            >
              Discard
            </Button>
          ) : null}
          <Button
            size="sm"
            loading={saving}
            disabled={!dirty}
            onClick={save}
            iconLeft={<Save className="h-4 w-4" aria-hidden />}
          >
            {saveFailed ? "Retry" : "Save notes"}
          </Button>
        </div>
      </div>

      {linkedNotes.length ? (
        <section className="mt-4 border-t border-border pt-3" aria-labelledby={`linked-notes-${pulseId}`}>
          <h4 id={`linked-notes-${pulseId}`} className="text-caption font-semibold text-text">From their other accounts</h4>
          <ul className="mt-2 space-y-2">
            {linkedNotes.map((note) => (
              <li key={note.id || `${note.target.id}:${note.updatedAt}`} className="rounded-lg border border-border bg-bg-elevated/40 p-3">
                <p className="flex flex-wrap items-center gap-2 text-micro uppercase tracking-wider text-text-dim">
                  <span>{note.account || "Linked account"}</span>
                  <span>{note.streamEligible ? "Shows on stream" : "Private"}</span>
                </p>
                <p className="mt-1 whitespace-pre-wrap break-words text-body text-text">{note.text}</p>
                {note.tags.length ? <p className="mt-1 text-caption text-text-muted">{note.tags.join(" · ")}</p> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </Card>
  );
}

function ToggleRow({ icon, title, detail, checked, disabled, onChange, label }: {
  icon: ReactNode; title: string; detail: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void; label: string;
}) {
  return (
    <div className="flex min-h-[44px] items-center gap-3 rounded-lg border border-border bg-bg-elevated px-3 py-2">
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-medium text-text">{title}</span>
        <span className="block text-micro text-text-dim">{detail}</span>
      </span>
      <Toggle checked={checked} disabled={disabled} onChange={onChange} label={label} />
    </div>
  );
}
