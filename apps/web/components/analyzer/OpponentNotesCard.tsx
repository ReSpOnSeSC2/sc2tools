"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { Save, StickyNote, Volume2, VolumeX } from "lucide-react";
import { apiCall, type ClientApiError } from "@/lib/clientApi";
import { Button } from "@/components/ui/Button";
import { Card, Skeleton } from "@/components/ui/Card";
import { Toggle } from "@/components/ui/Toggle";
import { useToastOptional } from "@/components/ui/Toast";
import { useOpponentNoteDraft } from "./useOpponentNoteDraft";

export const OPPONENT_NOTES_MAX_LENGTH = 500;

export type OpponentNotesValue = {
  notes: string;
  notesReadAloud: boolean;
};

type OpponentNotesCardProps = {
  pulseId: string;
  initialNotes?: string | null;
  initialNotesReadAloud?: boolean;
  onSaved?: (value: OpponentNotesValue) => void;
  headingLevel?: 2 | 3;
};

/**
 * Private, per-opponent scouting notes editor.
 *
 * Notes always render on the scouting widget. ``notesReadAloud`` only adds
 * them to the browser-speech readout; the global Voice switch remains the
 * master safety control for every spoken overlay event.
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
  onSaved,
  ownerId,
  headingLevel = 2,
}: OpponentNotesCardProps & { ownerId: string | null }) {
  const { getToken } = useAuth();
  const toastContext = useToastOptional();
  const serverValue = useMemo<OpponentNotesValue>(
    () => ({
      notes: typeof initialNotes === "string" ? initialNotes : "",
      notesReadAloud:
        Boolean(initialNotesReadAloud) && Boolean(initialNotes?.trim()),
    }),
    [initialNotes, initialNotesReadAloud],
  );
  const editor = useOpponentNoteDraft(pulseId, ownerId, serverValue);
  const { draft, dirty, restored, setDraft, discard } = editor;
  const [saving, setSaving] = useState(false);
  const [savedMessage, setSavedMessage] = useState("");
  const [saveFailed, setSaveFailed] = useState(false);
  const [macShortcut, setMacShortcut] = useState(false);
  useEffect(() => { setMacShortcut(/Mac|iPhone|iPad/.test(navigator.platform)); }, []);

  const active = useRef(true);
  const request = useRef<AbortController | null>(null);
  useEffect(() => { active.current = true; return () => { active.current = false; request.current?.abort(); }; }, []);
  const remaining = OPPONENT_NOTES_MAX_LENGTH - draft.notes.length;

  async function save() {
    if (!dirty || saving) return;
    setSaving(true);
    setSavedMessage("");
    setSaveFailed(false);
    const submitted = { ...draft };
    const controller = new AbortController(); request.current = controller;
    try {
      const saved = await apiCall<OpponentNotesValue & { updatedAt?: string }>(
        getToken,
        `/v1/opponents/${encodeURIComponent(pulseId)}/notes`,
        {
          method: "PUT",
          body: JSON.stringify(submitted),
          signal: controller.signal,
        },
      );
      if (!active.current) return;
      const canonical: OpponentNotesValue = {
        notes: typeof saved.notes === "string" ? saved.notes : "",
        notesReadAloud: saved.notesReadAloud === true,
      };
      const newer = editor.saved(canonical, submitted);
      setSavedMessage(newer ? "Saved. You have newer unsaved changes." : "Saved just now");
      setSaveFailed(false);
      onSaved?.(canonical);
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
  return (
    <Card
      variant="feature"
      aria-labelledby="opponent-notes-title"
      className="relative"
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <StickyNote className="h-4 w-4 text-accent" aria-hidden />
            <Heading
              id="opponent-notes-title"
              className="text-caption font-semibold uppercase tracking-wider text-text"
            >
              Opponent notes
            </Heading>
            <span className="rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-micro uppercase tracking-wider text-accent">
              Scouting widget
            </span>
          </div>
          <p className="mt-1 text-xs text-text-muted">
            {serverValue.notes ? "Keep the read short and actionable." : "Write a note about this opponent."} These private notes appear on your scouting widget when this opponent is detected.
          </p>
        </div>

        <div className="flex min-h-[44px] items-center gap-3 rounded-lg border border-border bg-bg-elevated px-3 py-2">
          {draft.notesReadAloud ? (
            <Volume2 className="h-4 w-4 text-accent" aria-hidden />
          ) : (
            <VolumeX className="h-4 w-4 text-text-dim" aria-hidden />
          )}
          <span className="min-w-0">
            <span className="block text-xs font-medium text-text">
              Read notes aloud
            </span>
            <span className="block text-micro text-text-dim">
              Requires Voice → Scouting Report
            </span>
          </span>
          <Toggle
            checked={draft.notesReadAloud}
            disabled={!draft.notes.trim() || saving}
            onChange={(checked) => {
              setDraft((current) => ({
                ...current,
                notesReadAloud: checked,
              }));
              setSavedMessage("");
              setSaveFailed(false);
            }}
            label="Read opponent notes aloud"
          />
        </div>
      </div>

      <div className="mt-4">
        {restored ? <p role="status" className="mb-2 text-caption text-warning">Unsaved draft restored · <button type="button" className="underline" onClick={discard}>Discard restored draft</button></p> : null}
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
          onChange={(event) => {
            const notes = event.target.value;
            setDraft((current) => ({
              notes,
              notesReadAloud: notes.trim()
                ? current.notesReadAloud
                : false,
            }));
            setSavedMessage("");
            setSaveFailed(false);
          }}
          className="min-h-[112px] w-full resize-y rounded-lg border-2 border-line bg-bg px-3 py-2 text-sm leading-relaxed text-text shadow-inner transition-colors placeholder:text-text-dim focus:border-accent focus:ring-2 focus:ring-accent/20"
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 text-xs text-text-dim">
          {remaining < 100 ? <span className={`tabular-nums ${remaining === 0 ? "text-danger" : ""}`}>
            {remaining.toLocaleString()} characters left
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
    </Card>
  );
}
