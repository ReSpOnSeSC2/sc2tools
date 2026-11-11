"use client";

import { useState, type FormEvent } from "react";
import { useAuth } from "@clerk/nextjs";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { Tabs } from "@/components/ui/Tabs";
import { useConfirm } from "@/components/ui/useConfirm";
import { LockerAccountEditor } from "./LockerAccountEditor";
import { downloadLockerBackup } from "./lockerBackup";
import {
  addRosterCoach, addRosterStudent, removeRosterCoach, removeRosterStudent, rosterCoaches,
  rosterStudents, updateRosterStudent, type LockerCoach, type LockerState, type LockerStudent,
} from "./lockerRosterModel";
import { useLockerRoster } from "./useLockerRoster";

type RosterProps = { viewerRole: "coach" | "admin"; coachId: string | null };

export default function LockerRoster(props: RosterProps) {
  const { userId } = useAuth();
  return userId ? <Roster key={userId + "/" + props.viewerRole + "/" + props.coachId} accountId={userId} {...props} /> : null;
}

type Editor = { kind: "student" | "coach"; rev: number } | { kind: "edit"; rev: number; student: LockerStudent };

function Roster({ accountId, viewerRole, coachId }: RosterProps & { accountId: string }) {
  const locker = useLockerRoster(accountId, viewerRole, coachId);
  const [section, setSection] = useState("students");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [help, setHelp] = useState(false);
  const confirmation = useConfirm(accountId);
  const doc = locker.document;

  if (!doc) return (
    <Card>
      <h2 className="text-h4 font-semibold text-text">{locker.loading ? "Loading the Locker roster…" : "The Locker roster could not load"}</h2>
      {locker.loading ? null : <Button className="mt-3" onClick={() => void locker.retry()}>Try again</Button>}
    </Card>
  );

  const isAdmin = viewerRole === "admin";
  const students = rosterStudents(doc.state);
  const coaches = rosterCoaches(doc.state);
  const assigned = coachId ?? "";
  const choices = isAdmin ? coaches : coaches.filter((coach) => coach.id === assigned);
  const save = async (next: LockerState, rev: number, message: string) => {
    if (await locker.save(next, rev, message)) setEditor(null);
  };
  const removeStudent = async (student: LockerStudent) => {
    if (!await confirmation.confirm({
      title: "Remove " + student.name + "?",
      description: "Their Locker profile, shelves and worksheets will be removed. Active sessions must be cancelled first.",
      confirmLabel: "Remove student", intent: "danger", focusCancel: true,
    })) return;
    await save(removeRosterStudent(doc.state, student.id), doc.rev, "Student removed");
  };
  const removeCoach = async (coach: LockerCoach) => {
    if (!assigned || !await confirmation.confirm({
      title: "Remove " + coach.name + "?",
      description: "The coach will lose Locker access and their students will be assigned to you.",
      confirmLabel: "Remove coach", intent: "danger", focusCancel: true,
    })) return;
    await save(removeRosterCoach(doc.state, coach.id, assigned), doc.rev, "Coach removed");
  };
  const restore = async () => {
    const backup = locker.backup;
    if (!backup || !await confirmation.confirm({
      title: "Restore previous version?",
      description: "Restore the Locker snapshot from before your last roster change on this device.",
      confirmLabel: "Restore version", focusCancel: true,
    })) return;
    await save(backup.state, doc.rev, "Previous Locker version restored");
  };

  return (
    <Card className="space-y-5">
      <Card.Header className="flex-wrap gap-3">
        <h2 className="text-h4 font-semibold text-text">Locker roster</h2>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" onClick={() => setHelp(true)}>Roster help</Button>
          <Button variant="secondary" disabled={!locker.backup || locker.busy} onClick={() => void restore()}>Restore previous version</Button>
          {locker.backup ? <Button variant="ghost" onClick={() => downloadLockerBackup(locker.backup!)}>Download backup</Button> : null}
        </div>
      </Card.Header>
      <Tabs value={section} onValueChange={setSection}>
        <Tabs.List ariaLabel="Locker roster sections">
          <Tabs.Trigger value="students">Students</Tabs.Trigger>
          {isAdmin ? <Tabs.Trigger value="team">Coaches</Tabs.Trigger> : null}
        </Tabs.List>
        <Tabs.Content value="students">
          <div className="space-y-3 pt-3">
            <Button disabled={!assigned || locker.busy} onClick={() => setEditor({ kind: "student", rev: doc.rev })}>Add student</Button>
            <RosterStudents students={students} coaches={coaches} busy={locker.busy}
              onEdit={(student) => setEditor({ kind: "edit", rev: doc.rev, student })} onRemove={(student) => void removeStudent(student)} />
          </div>
        </Tabs.Content>
        {isAdmin ? <Tabs.Content value="team">
          <div className="space-y-3 pt-3">
            <Button disabled={locker.busy} onClick={() => setEditor({ kind: "coach", rev: doc.rev })}>Add coach</Button>
            <ul aria-label="Coaches" className="space-y-2">
              {coaches.map((coach) => <li key={coach.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-3">
                <div className="min-w-0">
                  <p className="break-words font-semibold text-text">{coach.name}</p>
                  {coach.email ? <p className="break-all text-caption text-text-muted">{coach.email}</p> : null}
                </div>
                {assigned && coach.id !== assigned ? <Button variant="ghost" disabled={locker.busy} aria-label={"Remove " + coach.name} onClick={() => void removeCoach(coach)}>Remove coach</Button> : null}
              </li>)}
            </ul>
          </div>
        </Tabs.Content> : null}
      </Tabs>
      {editor?.kind === "edit" ? <EditStudent student={editor.student} coaches={isAdmin ? coaches : []} busy={locker.busy} onClose={() => setEditor(null)}
        onSave={(patch) => void save(updateRosterStudent(doc.state, editor.student.id, patch), editor.rev, "Student updated")} /> : null}
      {editor && editor.kind !== "edit" ? <LockerAccountEditor kind={editor.kind} coaches={choices} coachId={assigned} busy={locker.busy} onClose={() => setEditor(null)}
        alreadyLinked={new Set([...students, ...coaches].flatMap((row) => row.userId ? [row.userId] : []))}
        onAdd={(account, name, note, assignedCoach) => {
          const id = crypto.randomUUID();
          const next = editor.kind === "student"
            ? addRosterStudent(doc.state, id, name, note, assignedCoach, account)
            : addRosterCoach(doc.state, id, name, account);
          void save(next, editor.rev, editor.kind === "student" ? "Student added" : "Coach added");
        }} /> : null}
      {help ? <RosterHelp onClose={() => setHelp(false)} /> : null}
      {confirmation.dialog}
    </Card>
  );
}

function RosterStudents({ students, coaches, busy, onEdit, onRemove }: {
  students: LockerStudent[];
  coaches: LockerCoach[];
  busy: boolean;
  onEdit: (student: LockerStudent) => void;
  onRemove: (student: LockerStudent) => void;
}) {
  const names = new Map(coaches.map((coach) => [coach.id, coach.name]));
  return students.length ? (
    <ul aria-label="Students" className="space-y-2">
      {students.map((student) => <li key={student.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-3">
        <div className="min-w-0 flex-1 basis-48">
          <p className="break-words font-semibold text-text">{student.name}</p>
          <p className="break-words text-caption text-text-muted">{[names.get(student.coachId ?? ""), student.note].filter(Boolean).join(" · ") || "No focus note"}</p>
        </div>
        <div className="flex flex-wrap gap-1">
          <Button size="sm" variant="secondary" aria-label={"Edit " + student.name} disabled={busy} onClick={() => onEdit(student)}>Edit</Button>
          <Button size="sm" variant="ghost" aria-label={"Remove " + student.name} disabled={busy} onClick={() => onRemove(student)}>Remove</Button>
        </div>
      </li>)}
    </ul>
  ) : <p className="text-caption text-text-muted">Add a student to start their private Locker.</p>;
}

type StudentPatch = Partial<Pick<LockerStudent, "name" | "note" | "coachId">>;
function EditStudent({ student, coaches, busy, onSave, onClose }: {
  student: LockerStudent;
  coaches: LockerCoach[];
  busy: boolean;
  onSave: (patch: StudentPatch) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(student.name);
  const [note, setNote] = useState(student.note ?? "");
  const [coachId, setCoach] = useState(student.coachId ?? "");
  const changed = name !== student.name || note !== (student.note ?? "") || coachId !== (student.coachId ?? "");
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!changed || busy || !name.trim()) return;
    const patch: StudentPatch = {};
    if (name !== student.name) patch.name = name.trim();
    if (note !== (student.note ?? "")) patch.note = note.trim();
    if (coachId && coachId !== student.coachId) patch.coachId = coachId;
    onSave(patch);
  }
  return <Modal open title={"Edit " + student.name} onClose={() => { if (!busy) onClose(); }}>
    <form className="space-y-4" onSubmit={submit}>
      <Field label="Display name" required><Input value={name} required onChange={(event) => setName(event.target.value)} maxLength={120} /></Field>
      <Field label="Focus note"><Input value={note} onChange={(event) => setNote(event.target.value)} maxLength={1000} /></Field>
      {coaches.length ? <Field label="Assigned coach"><Select value={coachId} onChange={(event) => setCoach(event.target.value)}>
        {!coachId ? <option value="">Unassigned</option> : null}
        {coaches.map((coach) => <option key={coach.id} value={coach.id}>{coach.name}</option>)}
      </Select></Field> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || !changed || !name.trim()}>{busy ? "Saving…" : "Save changes"}</Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
      </div>
    </form>
  </Modal>;
}

function RosterHelp({ onClose }: { onClose: () => void }) {
  return <Modal open title="Locker roster help" desktopLayout="side" onClose={onClose}>
    <div className="space-y-3 text-body text-text-muted">
      <p>Use Students to link a signed-up account, change a display name or focus note, or remove a student. Admins can also change the assigned coach and manage linked coaches.</p>
      <p>Each save creates a backup on this device. Restore previous version is available for the last roster edit while its revision is current. Download backup keeps a JSON copy.</p>
      <p>Open Classic Locker for weekly focus, replay materials, worksheets and content studio.</p>
    </div>
  </Modal>;
}
