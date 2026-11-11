"use client";

import { useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { Tabs } from "@/components/ui/Tabs";
import { useConfirm } from "@/components/ui/useConfirm";
import { downloadLockerBackup } from "./lockerBackup";
import { rosterStudents } from "./lockerRosterModel";
import { LockerShelfEditor } from "./LockerShelfEditor";
import { LockerShelfItem } from "./LockerShelfItem";
import { changeShelf, cloneShelfItem, hasShelfId, reusableShelfItem, shelfItems, shelfTitle, type ShelfAsset, type ShelfItem } from "./lockerShelfModel";
import { useLockerView } from "./useLockerView";

type ShelfProps = { viewerRole: "coach" | "admin" | "student"; memberId: string | null };
type AddTarget = { studentId: string | null; rev: number };

export default function LockerShelf(props: ShelfProps) {
  const { userId } = useAuth();
  return userId ? <Shelf key={userId + "/" + props.viewerRole + "/" + props.memberId} accountId={userId} {...props} /> : null;
}

function Shelf({ accountId, viewerRole, memberId }: ShelfProps & { accountId: string }) {
  const locker = useLockerView(accountId, "shelf", viewerRole, memberId);
  const confirmation = useConfirm(accountId);
  const [view, setView] = useState("shelf"), [selected, setSelected] = useState("");
  const [editor, setEditor] = useState<AddTarget | null>(null), [help, setHelp] = useState(false);
  const doc = locker.document;
  if (!doc) return <Card>
    <h2 className="text-h4 font-semibold text-text">{locker.loading ? "Loading the Locker shelf…" : "The Locker shelf could not load"}</h2>
    {!locker.loading ? <Button className="mt-3" onClick={() => void locker.retry()}>Try again</Button> : null}
  </Card>;

  const staff = viewerRole !== "student";
  const students = rosterStudents(doc.state).filter(student => staff || student.id === memberId);
  const student = students.find(row => row.id === selected) ?? students[0];
  const library = staff && view === "library";
  const target = library ? null : student?.id;
  const cards = shelfItems(library ? doc.state.shelfLibrary : student?.shelf);
  const backup = locker.backup;

  function add(item: ShelfItem, attachment?: [string, ShelfAsset]) {
    if (!doc || !editor) return Promise.resolve(false);
    const stamped = editor.studentId ? { ...item, d: new Date().toISOString() } : item;
    return locker.save(changeShelf(doc.state, editor.studentId, rows => [stamped, ...rows], attachment), editor.rev, "Item added");
  }

  async function remove(item: ShelfItem) {
    if (!doc || target === undefined || !await confirmation.confirm({
      title: `Remove ${shelfTitle(item)}?`, description: "Copies on other shelves and stored attachments remain available.",
      confirmLabel: "Remove item", intent: "danger", focusCancel: true,
    })) return;
    await locker.save(changeShelf(doc.state, target, rows => rows.filter(row => !hasShelfId(row, item.id))), doc.rev, "Item removed");
  }

  async function copy(item: ShelfItem) {
    if (!doc || !student || (!library && !reusableShelfItem(item))) return;
    if (!await confirmation.confirm({
      title: library ? `Add to ${student.name}’s shelf?` : "Save to the shared library?",
      description: library ? "The student will see a copy of this item." : "Other coaches can read and reuse this item.",
      confirmLabel: library ? "Add to shelf" : "Save to library", focusCancel: true,
    })) return;
    const destination = library ? student.id : null;
    const copy = cloneShelfItem(item, crypto.randomUUID(), destination ? new Date().toISOString() : undefined);
    await locker.save(changeShelf(doc.state, destination, rows => [copy, ...rows]), doc.rev, library ? "Copied to student shelf" : "Saved to library");
  }

  async function restore() {
    if (!doc || !backup || !await confirmation.confirm({
      title: "Restore previous version?", description: "Restore the shelf and library from before your last Shelf change on this device.",
      confirmLabel: "Restore version", focusCancel: true,
    })) return;
    await locker.save(backup.state, doc.rev, "Previous Shelf version restored");
  }

  const content = <div className="space-y-3 pt-3">
    {staff && students.length ? <div className="max-w-sm"><Field label={library ? "Copy to student" : "Student shelf"}>
      <Select value={student?.id ?? ""} disabled={locker.busy} onChange={event => setSelected(event.target.value)}>
        {students.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
      </Select>
    </Field></div> : null}
    {staff && target !== undefined ? <Button disabled={locker.busy} onClick={() => setEditor({ studentId: target, rev: doc.rev })}>
      {library ? "Add library item" : "Add shelf item"}
    </Button> : null}
    {cards.length ? <ul className="space-y-2" aria-label={library ? "Library items" : "Shelf items"}>
      {cards.map(item => <LockerShelfItem key={item.id} state={doc.state} item={item}>
        {staff ? <>
          {student && (library || reusableShelfItem(item)) ? <Button size="sm" variant="secondary" disabled={locker.busy}
            aria-label={(library ? "Copy to shelf: " : "Save to library: ") + shelfTitle(item)} onClick={() => void copy(item)}>
            {library ? "Copy to shelf" : "Save to library"}
          </Button> : null}
          <Button size="sm" variant="ghost" aria-label={"Remove " + shelfTitle(item)} disabled={locker.busy} onClick={() => void remove(item)}>Remove</Button>
        </> : null}
      </LockerShelfItem>)}
    </ul> : <p className="text-caption text-text-muted">{library ? "The shared library is empty." : "No feedback on this shelf yet."}</p>}
  </div>;

  return <Card className="space-y-4">
    <Card.Header className="flex-wrap gap-3">
      <h2 className="text-h4 font-semibold text-text">{staff ? "Locker shelf" : "Your shelf"}</h2>
      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" onClick={() => setHelp(true)}>Shelf help</Button>
        {staff ? <Button variant="secondary" disabled={!backup || locker.busy} onClick={() => void restore()}>Restore previous version</Button> : null}
        {staff && backup ? <Button variant="ghost" onClick={() => downloadLockerBackup(backup)}>Download backup</Button> : null}
      </div>
    </Card.Header>
    {staff ? <Tabs value={view} onValueChange={setView}>
      <Tabs.List ariaLabel="Locker shelf sections">
        <Tabs.Trigger value="shelf">Student shelves</Tabs.Trigger>
        <Tabs.Trigger value="library">Shared library</Tabs.Trigger>
      </Tabs.List>
      <Tabs.Content value="shelf">{!library ? content : null}</Tabs.Content>
      <Tabs.Content value="library">{library ? content : null}</Tabs.Content>
    </Tabs> : content}
    {editor ? <LockerShelfEditor library={editor.studentId === null} onClose={() => setEditor(null)} onAdd={add} busy={locker.busy} /> : null}
    {help ? <Modal open title="Shelf help" onClose={() => setHelp(false)}>
      <div className="space-y-3 text-body text-text">
        <p>Student shelves hold notes, media, replays and practice PDFs from coaching sessions.</p>
        {staff ? <>
          <p>Keep individual replay feedback on the student’s shelf. Save reusable resources to the shared library, then copy a resource to the selected student.</p>
          <p>Before a change, your browser stores a backup. Restore previous version is available on this device while the Locker revision still matches that change.</p>
        </> : null}
        <Button variant="secondary" onClick={() => setHelp(false)}>Close</Button>
      </div>
    </Modal> : null}
    {confirmation.dialog}
  </Card>;
}
