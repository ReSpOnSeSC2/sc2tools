"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Save } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { BUILD_INTENT_NOTES_MAX_LENGTH } from "@/lib/buildIntent";

export interface CheckInNotesDraft {
  draft: string;
  setDraft: (next: string) => void;
  dirty: boolean;
  discard: () => void;
  /** Adopt the server's canonical notes after a successful save. */
  markSaved: (canonical: string) => void;
}

/**
 * Draft state for a game's check-in notes. A server refresh replaces the
 * draft only while it is clean, so a realtime refetch never wipes text
 * the player is still typing.
 */
export function useCheckInNotes(serverNotes: string): CheckInNotesDraft {
  const [draft, setDraft] = useState(serverNotes);
  const [baseline, setBaseline] = useState(serverNotes);
  const latest = useRef({ draft, baseline });
  latest.current = { draft, baseline };

  useEffect(() => {
    const { draft: currentDraft, baseline: currentBaseline } = latest.current;
    if (serverNotes === currentBaseline) return;
    if (currentDraft === currentBaseline) setDraft(serverNotes);
    setBaseline(serverNotes);
  }, [serverNotes]);

  return {
    draft,
    setDraft,
    dirty: draft !== baseline,
    discard: () => setDraft(baseline),
    markSaved: (canonical) => {
      setDraft(canonical);
      setBaseline(canonical);
    },
  };
}

/**
 * Notes textarea in the OpponentNotesCard style: character counter,
 * Discard while dirty, Save, and a polite live region for the outcome.
 */
export function CheckInNotesEditor({
  notes,
  saving,
  disabled = false,
  status,
  statusIsError = false,
  onSave,
  onEdit,
}: {
  notes: CheckInNotesDraft;
  saving: boolean;
  disabled?: boolean;
  /** Last save outcome ("Notes saved" / an error message). */
  status: string;
  statusIsError?: boolean;
  onSave: () => void;
  /** Called on every keystroke, e.g. to clear a stale status line. */
  onEdit?: () => void;
}) {
  const id = useId();
  const counterId = `${id}-counter`;
  const remaining = BUILD_INTENT_NOTES_MAX_LENGTH - notes.draft.length;
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-caption font-semibold text-text">
        What threw the build off?{" "}
        <span className="font-normal text-text-dim">(optional)</span>
      </label>
      <textarea
        id={id}
        value={notes.draft}
        maxLength={BUILD_INTENT_NOTES_MAX_LENGTH}
        rows={3}
        disabled={disabled}
        aria-describedby={counterId}
        placeholder="Example: Scouted early pool, skipped the third and held with Shield Batteries."
        onChange={(event) => {
          notes.setDraft(event.target.value);
          onEdit?.();
        }}
        className="min-h-[88px] w-full resize-y rounded-lg border-2 border-line bg-bg px-3 py-2 text-body leading-relaxed text-text shadow-inner transition-colors placeholder:text-text-dim focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-3 text-micro text-text-dim">
          <span id={counterId} className="tabular-nums">
            {remaining.toLocaleString("en-US")} characters left
          </span>
          <span
            role={statusIsError ? "alert" : "status"}
            aria-live="polite"
            className={statusIsError ? "text-danger" : "text-success"}
          >
            {status}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {notes.dirty ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={saving || disabled}
              onClick={() => {
                notes.discard();
                onEdit?.();
              }}
            >
              Discard
            </Button>
          ) : null}
          <Button
            variant="secondary"
            size="sm"
            loading={saving}
            disabled={!notes.dirty || disabled}
            onClick={onSave}
            iconLeft={<Save className="h-4 w-4" aria-hidden />}
          >
            Save notes
          </Button>
        </div>
      </div>
    </div>
  );
}
