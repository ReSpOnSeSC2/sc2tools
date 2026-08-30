"use client";

import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { Save, StickyNote, Volume2, VolumeX } from "lucide-react";
import { apiCall, type ClientApiError } from "@/lib/clientApi";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Toggle } from "@/components/ui/Toggle";
import { useToastOptional } from "@/components/ui/Toast";

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
};

/**
 * Private, per-opponent scouting notes editor.
 *
 * Notes always render on the scouting widget. ``notesReadAloud`` only adds
 * them to the browser-speech readout; the global Voice switch remains the
 * master safety control for every spoken overlay event.
 */
export function OpponentNotesCard({
  pulseId,
  initialNotes,
  initialNotesReadAloud = false,
  onSaved,
}: OpponentNotesCardProps) {
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
  const [draft, setDraft] = useState<OpponentNotesValue>(serverValue);
  const [baseline, setBaseline] = useState<OpponentNotesValue>(serverValue);
  const [saving, setSaving] = useState(false);
  const [savedMessage, setSavedMessage] = useState("");
  const [saveFailed, setSaveFailed] = useState(false);

  useEffect(() => {
    setDraft(serverValue);
    setBaseline(serverValue);
    setSavedMessage("");
    setSaveFailed(false);
  }, [pulseId, serverValue]);

  const dirty =
    draft.notes !== baseline.notes
    || draft.notesReadAloud !== baseline.notesReadAloud;
  const remaining = OPPONENT_NOTES_MAX_LENGTH - draft.notes.length;

  async function save() {
    if (!dirty || saving) return;
    setSaving(true);
    setSavedMessage("");
    setSaveFailed(false);
    try {
      const saved = await apiCall<OpponentNotesValue>(
        getToken,
        `/v1/opponents/${encodeURIComponent(pulseId)}/notes`,
        {
          method: "PUT",
          body: JSON.stringify(draft),
        },
      );
      const canonical: OpponentNotesValue = {
        notes: typeof saved.notes === "string" ? saved.notes : "",
        notesReadAloud: saved.notesReadAloud === true,
      };
      setDraft(canonical);
      setBaseline(canonical);
      setSavedMessage("Saved to scouting");
      setSaveFailed(false);
      onSaved?.(canonical);
      toastContext?.toast.success("Opponent notes saved");
    } catch (error) {
      const message =
        (error as ClientApiError | undefined)?.message ?? "Please try again.";
      toastContext?.toast.error("Couldn't save opponent notes", {
        description: message,
      });
      setSavedMessage(message);
      setSaveFailed(true);
    } finally {
      setSaving(false);
    }
  }

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
            <h2
              id="opponent-notes-title"
              className="text-caption font-semibold uppercase tracking-wider text-text"
            >
              Opponent notes
            </h2>
            <span className="rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-micro uppercase tracking-wider text-accent">
              Scouting widget
            </span>
          </div>
          <p className="mt-1 text-xs text-text-muted">
            Keep the read short and actionable. It appears only on your private
            overlay when this opponent is detected.
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
          className="min-h-[112px] w-full resize-y rounded-lg border-2 border-line bg-bg px-3 py-2 text-sm leading-relaxed text-text shadow-inner outline-none transition-colors placeholder:text-text-dim focus:border-accent focus:ring-2 focus:ring-accent/20"
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 text-xs text-text-dim">
          <span className="tabular-nums">
            {remaining.toLocaleString()} characters left
          </span>
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
                setDraft(baseline);
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
            Save notes
          </Button>
        </div>
      </div>
    </Card>
  );
}
