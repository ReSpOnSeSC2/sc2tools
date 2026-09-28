"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { apiCall } from "@/lib/clientApi";
import { fmtDate } from "@/lib/format";
import { guidesEnabled } from "@/lib/guides/flags";
import { GUIDE_MARKDOWN_MAX_CHARS, GuideMarkdown } from "@/lib/guides/markdown";
import { GUIDE_MATCHUPS, guideBuildOptions, guideBuildPath, guideDisplayName, isGuideMatchup } from "@/lib/guides/slugs";
import type {
  GuideAdminNote,
  GuideAdminNoteSaveBody,
  GuideAdminNoteSaveResponse,
  GuideAdminNotesPayload,
} from "@/lib/guides/types";
import { GUIDE_LINK_CLASS, GUIDE_PANEL_CLASS } from "@/components/guides/guideUi";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { ConfirmInline } from "../../components/AdminFragments";
import {
  ADMIN_TEXTAREA_CLASS,
  AdminNotice,
  AdminSectionHeader,
  adminErrorText,
  guideNoteApiPath,
  guideNoteKey,
  selectionFor,
  withDraft,
  type AdminNoticeValue,
  type AdminResource,
  type GuideSelection,
} from "./guidesAdminShared";

const HEADING_ID = "guide-notes-heading";
const PREVIEW_HEADING_ID = "guide-notes-preview-heading";
const TEXTAREA_ROWS = 14;
const NOTES_PLACEHOLDER = "### Game plan\n- Chrono the first Adepts\n- **Scout** before the third";
const MARKDOWN_HELP =
  "Shown on the public build guide under “Coach's notes”. Supports ### headings, - lists, **bold**, *italic*, `code` and https links. Empty notes are not shown.";

type Busy = "save" | "delete" | null;

export interface GuideNotesEditorProps {
  notes: AdminResource<GuideAdminNotesPayload>;
  selection: GuideSelection;
  onSelect: (next: GuideSelection) => void;
}

function useNotesEditor(notes: AdminResource<GuideAdminNotesPayload>, selection: GuideSelection) {
  const { getToken } = useAuth();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Busy>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [notice, setNotice] = useState<AdminNoticeValue | null>(null);
  const noteByKey = useMemo(() => {
    const map = new Map<string, GuideAdminNote>();
    for (const note of notes.data?.items ?? []) map.set(guideNoteKey(note.matchup, note.buildKey), note);
    return map;
  }, [notes.data]);

  const key = guideNoteKey(selection.matchup, selection.buildKey);
  const stored = noteByKey.get(key) ?? null;
  const draft = drafts[key] ?? stored?.body ?? "";
  const apiPath = guideNoteApiPath(selection.matchup, selection.buildKey);
  const name = guideDisplayName(selection.buildKey);

  function forgetDraft() {
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  async function run(kind: Exclude<Busy, null>, init: RequestInit, done: string, lead: string) {
    if (!apiPath || busy) return;
    setBusy(kind);
    setNotice(null);
    try {
      await apiCall<GuideAdminNoteSaveResponse | null>(getToken, apiPath, init);
      await notes.mutate();
      forgetDraft();
      setConfirmDelete(false);
      setNotice({ tone: "success", text: done });
    } catch (err) {
      setNotice({ tone: "error", text: adminErrorText(lead, err) });
    } finally {
      setBusy(null);
    }
  }

  return {
    drafts, busy, confirmDelete, notice, noteByKey, stored, draft, apiPath, name,
    dirty: draft !== (stored?.body ?? ""),
    setDraft: (value: string) => setDrafts((prev) => withDraft(prev, key, value, stored?.body ?? "")),
    discard: forgetDraft,
    askDelete: (open: boolean) => { setNotice(null); setConfirmDelete(open); },
    resetForSelection: () => { setConfirmDelete(false); setNotice(null); },
    save: () => run("save", { method: "PUT", body: JSON.stringify({ body: draft } satisfies GuideAdminNoteSaveBody) }, `Saved the coach's notes for ${name}.`, "Couldn't save the notes."),
    remove: () => run("delete", { method: "DELETE" }, `Deleted the coach's notes for ${name}.`, "Couldn't delete the notes."),
  };
}

/**
 * Coach's notes editor: pick a matchup + build from the web catalog,
 * edit the markdown with a live preview rendered by the SAME renderer
 * the public build page uses (so the preview is exact), then save or
 * delete through the admin notes API. Unsaved drafts are kept per guide
 * while switching between builds.
 */
export function GuideNotesEditor({ notes, selection, onSelect }: GuideNotesEditorProps) {
  const editor = useNotesEditor(notes, selection);
  const { draft, apiPath, name } = editor;
  // Editable only once the saved notes are loaded, so a save can never
  // overwrite a stored note the page hasn't shown yet.
  const ready = Boolean(notes.data) && !notes.error && Boolean(apiPath);
  return (
    <section aria-labelledby={HEADING_ID} className="space-y-4">
      <AdminSectionHeader id={HEADING_ID} title="Coach's notes" description={MARKDOWN_HELP} />
      <Card>
        <div className="space-y-4">
          <GuidePicker
            selection={selection}
            noteByKey={editor.noteByKey}
            drafts={editor.drafts}
            onSelect={(next) => { editor.resetForSelection(); onSelect(next); }}
          />
          {notes.error ? <p role="alert" className="text-body text-danger">Couldn&apos;t load saved notes. {notes.error.message}</p> : null}
          <div className="grid gap-4 lg:grid-cols-2">
            <Field label={`Notes for ${name || "this build"} (markdown)`} hint={`${draft.length.toLocaleString()} / ${GUIDE_MARKDOWN_MAX_CHARS.toLocaleString()} characters`}>
              <textarea
                rows={TEXTAREA_ROWS}
                className={ADMIN_TEXTAREA_CLASS}
                maxLength={GUIDE_MARKDOWN_MAX_CHARS}
                value={draft}
                disabled={!ready}
                placeholder={NOTES_PLACEHOLDER}
                onChange={(event) => editor.setDraft(event.target.value)}
              />
            </Field>
            <NotesPreview source={draft} />
          </div>
          <NotesActions
            stored={editor.stored}
            dirty={editor.dirty}
            busy={editor.busy}
            canSave={ready && draft.length <= GUIDE_MARKDOWN_MAX_CHARS}
            publicPath={guidesEnabled() ? guideBuildPath(selection.matchup, selection.buildKey) : null}
            onSave={() => void editor.save()}
            onDiscard={editor.discard}
            onDelete={() => editor.askDelete(true)}
          />
          {editor.confirmDelete ? (
            <ConfirmInline
              prompt={`Delete the coach's notes for ${name}? This guide's video pins and hides are deleted with them.`}
              confirmLabel="Yes, delete notes"
              busy={editor.busy === "delete"}
              onConfirm={() => void editor.remove()}
              onCancel={() => editor.askDelete(false)}
            />
          ) : null}
          <AdminNotice notice={editor.notice} />
        </div>
      </Card>
    </section>
  );
}

function GuidePicker({
  selection,
  noteByKey,
  drafts,
  onSelect,
}: {
  selection: GuideSelection;
  noteByKey: ReadonlyMap<string, GuideAdminNote>;
  drafts: Readonly<Record<string, string>>;
  onSelect: (next: GuideSelection) => void;
}) {
  const options = guideBuildOptions(selection.matchup);
  return (
    <div className="grid gap-4 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
      <Field label="Matchup">
        <Select
          value={selection.matchup}
          onChange={(event) => { if (isGuideMatchup(event.target.value)) onSelect(selectionFor(event.target.value)); }}
        >
          {GUIDE_MATCHUPS.map((matchup) => <option key={matchup} value={matchup}>{matchup}</option>)}
        </Select>
      </Field>
      <Field label="Build guide">
        <Select value={selection.buildKey} onChange={(event) => onSelect({ matchup: selection.matchup, buildKey: event.target.value })}>
          {options.map((option) => {
            const optionKey = guideNoteKey(selection.matchup, option.name);
            const tags = [noteByKey.get(optionKey)?.body ? "has notes" : null, optionKey in drafts ? "unsaved" : null].filter(Boolean);
            return <option key={option.slug} value={option.name}>{option.name}{tags.length ? ` · ${tags.join(" · ")}` : ""}</option>;
          })}
        </Select>
      </Field>
    </div>
  );
}

/** Exact preview: the public page wraps GuideMarkdown in this same panel. */
function NotesPreview({ source }: { source: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h3 id={PREVIEW_HEADING_ID} className="text-caption font-medium text-text">Preview</h3>
      <div role="region" aria-labelledby={PREVIEW_HEADING_ID} data-testid="guide-notes-preview" className={`${GUIDE_PANEL_CLASS} min-h-24 p-4`}>
        {source.trim() ? <GuideMarkdown source={source} /> : <p className="text-body text-text-dim">Nothing to preview yet.</p>}
      </div>
    </div>
  );
}

function NotesActions({
  stored,
  dirty,
  busy,
  canSave,
  publicPath,
  onSave,
  onDiscard,
  onDelete,
}: {
  stored: GuideAdminNote | null;
  dirty: boolean;
  busy: Busy;
  canSave: boolean;
  publicPath: string | null;
  onSave: () => void;
  onDiscard: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button loading={busy === "save"} disabled={!dirty || !canSave || Boolean(busy)} onClick={onSave}>Save notes</Button>
      <Button variant="secondary" disabled={!dirty || Boolean(busy)} onClick={onDiscard}>Discard changes</Button>
      <Button variant="danger" disabled={!stored || Boolean(busy)} onClick={onDelete}>Delete notes</Button>
      <span className="text-caption text-text-dim">
        {dirty ? "Unsaved changes. " : ""}
        {stored ? `Last saved ${fmtDate(stored.updatedAt)}.` : "No notes saved for this guide yet."}
      </span>
      {publicPath ? (
        <Link href={publicPath} target="_blank" rel="noopener" className={`${GUIDE_LINK_CLASS} text-caption`}>
          View the public guide
        </Link>
      ) : null}
    </div>
  );
}
