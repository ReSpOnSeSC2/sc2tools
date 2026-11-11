"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { useConfirm } from "@/components/ui/useConfirm";
import { downloadLockerBackup } from "./lockerBackup";
import { rosterStudents } from "./lockerRosterModel";
import { changeShelf, readShelfFile, shelfItems, type ShelfAsset, type ShelfItem } from "./lockerShelfModel";
import { LockerShelfItem } from "./LockerShelfItem";
import { LockerReadRetry } from "./LockerReadRetry";
import { LockerViewScope } from "./LockerViewScope";
import { LockerWorksheetAnnotation } from "./LockerWorksheetAnnotation";
import { LockerContentStudioEditor } from "./LockerContentStudioEditor";
import { STUDIO_TITLES, type StudioDraft } from "./lockerContentStudioModel";
import type { StudioKind } from "./LockerStudioGuides";
import { useLockerView } from "./useLockerView";

type Props = { viewerRole: "coach" | "admin"; memberId: string | null };
type EditTarget = { studentId: string; studentName: string; rev: number; kind: StudioKind };

export default function LockerContentStudio(props: Props) {
  const { userId } = useAuth();
  return userId ? <LockerViewScope key={JSON.stringify([userId, props.viewerRole, props.memberId])}>
    <ContentStudio accountId={userId} {...props} />
  </LockerViewScope> : null;
}

function ContentStudio({ accountId, viewerRole, memberId }: Props & { accountId: string }) {
  const locker = useLockerView(accountId, "content-studio", viewerRole, memberId);
  if (!locker.document) return <Card>
    <h2 className="text-h4 font-semibold text-text">{locker.loading ? "Loading Content Studio…" : "Content Studio could not load"}</h2>
    {!locker.loading ? <Button className="mt-3" onClick={() => void locker.retry()}>Try again</Button> : null}
  </Card>;
  return <ContentStudioDocument accountId={accountId} locker={locker} latest={locker.document} />;
}

function ContentStudioDocument({ accountId, locker, latest }: {
  accountId: string;
  locker: ReturnType<typeof useLockerView>;
  latest: NonNullable<ReturnType<typeof useLockerView>["document"]>;
}) {
  const confirm = useConfirm(accountId);
  const cancelConfirmation = confirm.cancel;
  const [selected, setSelected] = useState("");
  const [editor, setEditor] = useState<EditTarget | null>(null);
  const [help, setHelp] = useState(false);
  const students = rosterStudents(latest.state);
  const student = students.find(row => row.id === selected) ?? students[0];
  const target = editor ? students.find(row => row.id === editor.studentId) : null;
  const items = shelfItems(student?.shelf);
  const backup = locker.backup;
  const writeBlocked = locker.busy || locker.refreshRequired;
  const retryNotice = locker.refreshRequired ? <LockerReadRetry retry={locker.retry} retrying={locker.retrying} /> : null;
  useEffect(() => {
    if (locker.refreshRequired) cancelConfirmation();
  }, [locker.refreshRequired, cancelConfirmation]);

  async function add(draft: StudioDraft) {
    if (writeBlocked || !editor || !target || latest.rev !== editor.rev) return false;
    const attachment = draft.file ? [crypto.randomUUID(), await readShelfFile(draft.file, draft.kind)] as [string, ShelfAsset] : undefined;
    const item: ShelfItem = {
      id: crypto.randomUUID(), d: new Date().toISOString(), ty: draft.kind, t: draft.title, n: draft.notes,
      ...(draft.link ? { link: draft.link } : {}), ...(draft.replay ? { game: draft.replay } : {}), ...(attachment ? { asset: attachment[0] } : {}),
    };
    return locker.save(changeShelf(latest.state, target.id, rows => [item, ...rows], attachment), editor.rev, "Item added to the shelf");
  }

  async function restore() {
    if (writeBlocked || !backup || !await confirm.confirm({
      title: "Restore previous version?", description: "Restore the shelf data from before your last Content Studio change on this device.",
      confirmLabel: "Restore version", focusCancel: true,
    })) return;
    await locker.save(backup.state, latest.rev, "Previous Content Studio version restored");
  }

  return <Card className="space-y-4">
    <Card.Header className="flex-wrap gap-3">
      <div><h2 className="text-h4 font-semibold text-text">Content Studio</h2>
        <p className="mt-1 text-caption text-text-muted">Create a coaching item and add it to a student’s shelf.</p></div>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" disabled={!backup || writeBlocked} onClick={() => void restore()}>Restore previous version</Button>
        {backup ? <Button variant="ghost" onClick={() => downloadLockerBackup(backup)}>Download backup</Button> : null}
        <Button variant="ghost" onClick={() => setHelp(true)}>Content Studio help</Button>
      </div>
    </Card.Header>
    {editor || help ? null : retryNotice}
    {!student ? <p className="text-caption text-text-muted">Add a student to the roster before creating a shelf item.</p> : null}
    {student ? <>
      <div className="max-w-sm"><Field label="Student shelf"><Select value={student.id} disabled={locker.busy || !!editor} onChange={event => setSelected(event.target.value)}>
        {students.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
      </Select></Field></div>
      <details className="space-y-2 rounded-md border border-border p-3 text-caption"><summary className="cursor-pointer font-semibold">Plan a coaching item</summary>
        <ul className="list-disc space-y-1 pl-5 text-text-muted"><li>Identify what repeated in the games.</li><li>Explain why the decision mattered.</li>
          <li>Give the student one cue and response to practice.</li><li>Choose how you’ll check whether it worked.</li></ul>
      </details>
      <div role="group" aria-label="Coaching item type" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {(Object.entries(STUDIO_TITLES) as [StudioKind, string][]).map(([kind, label]) => <Button key={kind} variant="secondary" disabled={writeBlocked || !!editor}
          onClick={() => setEditor({ studentId: student.id, studentName: student.name, rev: latest.rev, kind })}>{label}</Button>)}
      </div>
      <section className="space-y-2" aria-label="Items on the student’s shelf">
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-body font-semibold">On the shelf</h3>
          <Link href="/coaching?locker=shelf" prefetch={false} className="inline-flex min-h-11 items-center text-caption underline">Open Shelf and shared library</Link></div>
        {items.length ? <ul className="space-y-2">{items.map(item => <LockerShelfItem key={item.id} state={latest.state} item={item} />)}</ul>
          : <p className="text-caption text-text-muted">Nothing has been added to this shelf yet.</p>}
      </section>
    </> : null}
    {editor ? <LockerContentStudioEditor key={`${editor.studentId}/${editor.kind}`} kind={editor.kind} studentName={target?.name ?? editor.studentName} studentUserId={target?.userId}
      busy={locker.busy} retryNotice={retryNotice} revisionChanged={editor.rev !== latest.rev} targetUnavailable={!target}
      onReviewLatest={() => { if (!writeBlocked) setEditor({ ...editor, rev: latest.rev }); }}
      onClose={() => setEditor(null)} onAdd={add} Annotation={LockerWorksheetAnnotation} /> : null}
    {help ? <Modal open title="Content Studio help" desktopLayout="side" onClose={() => setHelp(false)}>
      {retryNotice}
      <div className="space-y-3 text-body text-text">
        <p>Choose a student and the format for the next coaching item. Start a note from a guide, record up to 90 seconds of audio, or attach an image, short video or PDF.</p>
        <p>A replay picked from the library adds game context. Give the student an authorized share link or replay file if they need to open the game.</p>
        <p>Your browser saves a backup before every change. Use Restore previous version on this device while the Locker revision still matches the change.</p>
        <Button variant="secondary" onClick={() => setHelp(false)}>Done</Button>
      </div>
    </Modal> : null}
    {confirm.dialog}
  </Card>;
}
