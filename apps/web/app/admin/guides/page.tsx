"use client";

import { Suspense, useEffect, useRef, useState, type RefObject } from "react";
import { useAuth } from "@clerk/nextjs";
import { AdminPageHeader } from "@/app/admin/components/AdminPageHeader";
import { guidesEnabled } from "@/lib/guides/flags";
import { GUIDE_MATCHUPS, guideBuildOptions, guideBuildSlug, isGuideMatchup } from "@/lib/guides/slugs";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SaveBar } from "@/components/ui/SaveBar";
import { Tabs } from "@/components/ui/Tabs";
import { ForbiddenCard, LoadingRows } from "../components/AdminFragments";
import { useAdminQueryState } from "../components/useAdminQueryState";
import { useUnsavedChangesGuard } from "../components/useUnsavedChangesGuard";
import { GuideNotesEditor, GuidePicker } from "./components/GuideNotesEditor";
import { GuideNotesCoverage } from "./components/GuideNotesCoverage";
import { GuideStatusPanel } from "./components/GuideStatusPanel";
import { GuideVideosPanel } from "./components/GuideVideosPanel";
import { AdminNotice, guideNoteKey, selectionFor, type GuideSelection } from "./components/guidesAdminShared";
import { useGuidesAdmin } from "./components/useGuidesAdmin";
import { draftGuideName, useGuideDrafts } from "./components/useGuideDrafts";

const TABS = ["notes", "videos", "stats"];
const DEFAULT_QUERY = { section: "notes", matchup: "", build: "" };
const ALLOWED_QUERY = { section: TABS, matchup: ["", ...GUIDE_MATCHUPS] };
const noteCount = (count: number) => `${count} ${count === 1 ? "note" : "notes"}`;

export default function AdminGuidesPage() {
  const { userId } = useAuth();
  const owner = useRef(userId);
  owner.current = userId;
  return <Suspense fallback={<LoadingRows rows={3} />}><GuidesContent key={userId ?? "signed-out"} owner={owner} /></Suspense>;
}

function GuidesContent({ owner }: { owner: RefObject<string | null | undefined> }) {
  const { notes, status, videos, forbidden } = useGuidesAdmin();
  const [query, setQuery] = useAdminQueryState(DEFAULT_QUERY, { allowed: ALLOWED_QUERY });
  const matchup = isGuideMatchup(query.matchup) ? query.matchup : selectionFor().matchup;
  const build = guideBuildOptions(matchup).find(option => option.slug === query.build || option.name === query.build);
  const selection: GuideSelection = build ? { matchup, buildKey: build.name } : selectionFor(matchup);
  const select = (next: GuideSelection) => setQuery({ matchup: next.matchup, build: guideBuildSlug(next.matchup, next.buildKey) || "" });
  const key = guideNoteKey(selection.matchup, selection.buildKey);
  const editor = useGuideDrafts(notes, owner);
  const { save: saveNotes } = editor;
  const dirty = editor.dirtyKeys.length;
  const navigation = useUnsavedChangesGuard(dirty > 0 && !forbidden);
  const [discardAll, setDiscardAll] = useState(false);
  const busy = Boolean(editor.busy);

  useEffect(() => {
    if (query.section !== "notes" || forbidden || discardAll || navigation.open) return;
    const shortcut = (event: KeyboardEvent) => {
      if ((!event.ctrlKey && !event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      void saveNotes([key], true);
    };
    document.addEventListener("keydown", shortcut);
    return () => document.removeEventListener("keydown", shortcut);
  }, [saveNotes, key, query.section, forbidden, discardAll, navigation.open]);

  if (forbidden) return <ForbiddenCard />;
  return (
    <div className="space-y-5 pb-24">
      <AdminPageHeader anchor="guides" title="Guides" description="Manage published notes, videos and guide statistics." />
      {guidesEnabled() ? null : <p role="note" className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-caption text-warning">The public guide pages are switched off in this deployment (NEXT_PUBLIC_GUIDES_ENABLED). You can still prepare notes and videos; they appear once the flag is on.</p>}
      {editor.restoredCount ? <div className="flex flex-wrap items-center gap-2" role="status">
        <p className="text-caption">Restored {editor.restoredCount} unsaved {editor.restoredCount === 1 ? "note" : "notes"}.</p>
        <Button variant="ghost" size="sm" onClick={editor.dismissRestored}>Dismiss</Button>
      </div> : null}
      <AdminNotice notice={editor.notice} />
      {Object.keys(editor.failures).length ? <div className="rounded-lg border border-danger/40 p-3" aria-label="Notes that could not be saved">
        <ul className="space-y-2" role="alert">
          {Object.entries(editor.failures).map(([failedKey, message]) => <li key={failedKey} className="flex flex-wrap items-center gap-2">
            <span className="text-caption text-danger">{draftGuideName(failedKey)}. {message}</span>
            <Button variant="secondary" size="sm" disabled={busy || !editor.ready} onClick={() => void editor.save([failedKey])}>Retry {draftGuideName(failedKey)}</Button>
          </li>)}
        </ul>
      </div> : null}

      <Tabs value={query.section} onValueChange={section => setQuery({ section }, { history: "push" })}>
        <Tabs.List ariaLabel="Guide admin sections">
          <Tabs.Trigger value="notes">Notes</Tabs.Trigger>
          <Tabs.Trigger value="videos">Videos</Tabs.Trigger>
          <Tabs.Trigger value="stats">Stats runs</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="notes" className="space-y-4">
          <GuideNotesCoverage notes={editor.noteByKey} dirtyKeys={editor.dirtyKeys} onSelect={select} />
          <GuideNotesEditor key={key} editor={editor} error={notes.error?.message} selection={selection} onSelect={select} />
        </Tabs.Content>
        <Tabs.Content value="videos" className="space-y-4">
          <GuidePicker selection={selection} noteByKey={editor.noteByKey} drafts={editor.drafts} onSelect={select} />
          <GuideVideosPanel videos={videos} notes={notes} selection={selection} />
        </Tabs.Content>
        <Tabs.Content value="stats"><GuideStatusPanel status={status} /></Tabs.Content>
      </Tabs>

      <SaveBar visible={dirty > 0} disableUnloadGuard stackOnMobile saving={busy} saveDisabled={!editor.ready}
        saveLabel="Save all" resetLabel="Discard all" message={`${dirty} unsaved ${dirty === 1 ? "note" : "notes"}`}
        onSave={() => void editor.save(editor.dirtyKeys)} onReset={() => setDiscardAll(true)} />
      <ConfirmDialog open={discardAll} onClose={() => setDiscardAll(false)} onConfirm={() => {
        editor.discard(editor.dirtyKeys); setDiscardAll(false);
      }} title={`Discard ${noteCount(dirty)}?`} confirmLabel="Discard all" cancelLabel="Keep editing" intent="danger" focusCancel />
      <ConfirmDialog open={navigation.open} onClose={navigation.stay} onConfirm={navigation.leave}
        title={`Leave without saving ${noteCount(dirty)}?`} confirmLabel="Leave" cancelLabel="Stay" intent="danger" focusCancel />
    </div>
  );
}
