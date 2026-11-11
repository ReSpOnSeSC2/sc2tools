"use client";

import { useState } from "react";
import Link from "next/link";
import { fmtDate } from "@/lib/format";
import { guidesEnabled } from "@/lib/guides/flags";
import { GUIDE_MARKDOWN_MAX_CHARS, GuideMarkdown } from "@/lib/guides/markdown";
import { GUIDE_MATCHUPS, guideBuildOptions, guideBuildPath, guideDisplayName, isGuideMatchup } from "@/lib/guides/slugs";
import type { GuideAdminNote } from "@/lib/guides/types";
import { GUIDE_LINK_CLASS, GUIDE_PANEL_CLASS } from "@/components/guides/guideUi";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { ConfirmInline } from "../../components/AdminFragments";
import {
  ADMIN_TEXTAREA_CLASS,
  AdminSectionHeader,
  guideNoteApiPath,
  guideNoteKey,
  selectionFor,
  type GuideSelection,
} from "./guidesAdminShared";
import type { useGuideDrafts } from "./useGuideDrafts";
import { formatNumber } from "@/lib/i18n/format";

const HEADING_ID = "guide-notes-heading";
const PREVIEW_HEADING_ID = "guide-notes-preview-heading";
const TEXTAREA_ROWS = 14;
const NOTES_PLACEHOLDER = "### Game plan\n- Chrono the first Adepts\n- **Scout** before the third";
const MARKDOWN_HELP =
  "Shown on the public build guide under “Coach's notes”. Supports ### headings, - lists, **bold**, *italic*, `code` and https links. Empty notes are not shown.";

type Busy = "save" | "delete" | null;

export interface GuideNotesEditorProps {
  editor: ReturnType<typeof useGuideDrafts>;
  error?: string;
  selection: GuideSelection;
  onSelect: (next: GuideSelection) => void;
}

/** Edit one guide while the page owns all drafts and pending writes. */
export function GuideNotesEditor({ editor, error, selection, onSelect }: GuideNotesEditorProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const key = guideNoteKey(selection.matchup, selection.buildKey);
  const stored = editor.noteByKey.get(key) ?? null;
  const draft = editor.drafts[key] ?? stored?.body ?? "";
  const name = guideDisplayName(selection.buildKey);
  const ready = editor.ready && Boolean(guideNoteApiPath(selection.matchup, selection.buildKey));
  return (
    <section aria-labelledby={HEADING_ID} className="space-y-4">
      <AdminSectionHeader id={HEADING_ID} title="Coach's notes" description={MARKDOWN_HELP} />
      <Card>
        <div className="space-y-4">
          <GuidePicker
            selection={selection}
            noteByKey={editor.noteByKey}
            drafts={editor.drafts}
            onSelect={onSelect}
          />
          {error ? <p role="alert" className="text-body text-danger">Couldn&apos;t load saved notes. {error}</p> : null}
          <div className="grid gap-4 lg:grid-cols-2">
            <Field label={`Notes for ${name || "this build"} (markdown)`} hint={`${formatNumber(draft.length)} / ${formatNumber(GUIDE_MARKDOWN_MAX_CHARS)} characters`}>
              <textarea
                rows={TEXTAREA_ROWS}
                className={ADMIN_TEXTAREA_CLASS}
                maxLength={GUIDE_MARKDOWN_MAX_CHARS}
                value={draft}
                disabled={!ready || !!editor.busy}
                placeholder={NOTES_PLACEHOLDER}
                onChange={(event) => editor.edit(key, event.target.value)}
              />
            </Field>
            <NotesPreview source={draft} />
          </div>
          <NotesActions
            stored={stored}
            dirty={editor.dirtyKeys.includes(key)}
            busy={editor.busy}
            canSave={ready && draft.length <= GUIDE_MARKDOWN_MAX_CHARS}
            publicPath={guidesEnabled() ? guideBuildPath(selection.matchup, selection.buildKey) : null}
            onSave={() => void editor.save([key])}
            onDiscard={() => editor.discard([key])}
            onDelete={() => setConfirmDelete(true)}
          />
          {confirmDelete ? (
            <ConfirmInline
              prompt={`Delete the coach's notes for ${name}? This guide's video pins and hides are deleted with them.`}
              confirmLabel="Yes, delete notes"
              busy={editor.busy === "delete"}
              onConfirm={() => void editor.remove(selection).then(removed => { if (removed) setConfirmDelete(false); })}
              onCancel={() => setConfirmDelete(false)}
            />
          ) : null}
        </div>
      </Card>
    </section>
  );
}

export function GuidePicker({
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
