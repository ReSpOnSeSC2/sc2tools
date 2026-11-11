"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { useConfirm } from "@/components/ui/useConfirm";
import { downloadLockerBackup, type loadLockerBackup } from "./lockerBackup";
import { rosterCoaches, rosterStudents, type LockerDocument, type LockerState } from "./lockerRosterModel";
import { LockerWorksheetAnswers, LockerWorksheetReview } from "./LockerWorksheetAnswers";
import { LockerWorksheetEditor, type WorksheetPlaybook } from "./LockerWorksheetEditor";
import {
  newWorksheet, templatesFor, worksheetsFor, withWorksheet, withWorksheetSubmission, withWorksheetTemplate,
  type Worksheet, type WorksheetPrompt, type WorksheetTemplate,
} from "./lockerWorksheetModel";
import kits from "./lockerWorksheetKits.json";

const MAX_LOCKER_BYTES = 12 * 1048576;
const MATCHUPS = kits.templates.flatMap(template => template.matchup ? [template.matchup] : []);
const PLANNING_QUESTIONS = [
  ["evidence", "Evidence", "What moment or pattern keeps repeating?"],
  ["decision", "Decision", "Which cue should change the student's choice?"],
  ["practice", "Practice", "Which repetition isolates it?"],
  ["proof", "Proof", "What would show that the idea transferred?"],
] as const;
const GUIDED_PROMPTS: WorksheetPrompt[] = [
  { ty: "long", q: "Describe the moment we discussed. Which facts were confirmed, and which parts were assumptions?" },
  { ty: "long", q: "What visible cue should guide your next decision, and what will you do when you see it?" },
  { ty: "scale", q: "Rate your confidence from 1–10. I can recognize this situation early enough to respond deliberately." },
  { ty: "replay", q: "Attach representative games from your next practice set. Mark the timestamp where you recognized or missed the cue." },
];

export type WorksheetLockerView = {
  document?: LockerDocument;
  loading: boolean;
  retry: () => Promise<unknown>;
  backup: Awaited<ReturnType<typeof loadLockerBackup>>;
  busy: boolean;
  save: (state: LockerState, revision: number, message: string) => Promise<boolean>;
};

type OpenPanel = { kind: "edit" | "review" | "answer"; worksheet: Worksheet; revision: number }
  | { kind: "templates" | "playbook"; revision: number };

export function LockerWorksheetsPanel({ accountId, role, memberId, locker }: {
  accountId: string;
  role: "admin" | "coach" | "student";
  memberId: string | null;
  locker: WorksheetLockerView;
}) {
  const [studentId, setStudentId] = useState("");
  const [panel, setPanel] = useState<OpenPanel | null>(null);
  const [plans, setPlans] = useState<Record<string, WorksheetPlaybook>>({});
  const [error, setError] = useState("");
  const confirmation = useConfirm(accountId);
  const doc = locker.document;
  if (!doc) return <Card>
    <p role={locker.loading ? "status" : "alert"}>{locker.loading ? "Loading worksheets…" : "Worksheets could not load."}</p>
    {locker.loading ? null : <Button className="mt-3" onClick={() => void locker.retry()}>Try again</Button>}
  </Card>;

  const studentRole = role === "student";
  const students = rosterStudents(doc.state).filter(student => role === "admin" || (studentRole ? student.id === memberId : student.coachId === memberId));
  const selected = students.find(student => student.id === studentId) ?? students[0];
  const worksheets = selected ? worksheetsFor(selected).filter(worksheet => !studentRole || worksheet.state !== "draft") : [];
  const coachName = rosterCoaches(doc.state).find(coach => coach.id === selected?.coachId)?.name || "your coach";

  const save = async (state: LockerState, revision: number, message: string) => {
    if (new Blob([JSON.stringify(state)]).size > MAX_LOCKER_BYTES) {
      setError("There is not enough Locker storage for this change. Remove an attachment and try again.");
      return false;
    }
    setError("");
    return locker.save(state, revision, message);
  };
  const saveWorksheet = (worksheet: Worksheet, revision: number, message: string) => selected
    ? save(withWorksheet(doc.state, selected.id, worksheet.id, worksheet), revision, message)
    : Promise.resolve(false);
  const removeWorksheet = async (worksheet: Worksheet) => {
    if (!selected || !await confirmation.confirm({ title: `Delete ${worksheet.title}?`, confirmLabel: "Delete worksheet", intent: "danger", focusCancel: true })) return;
    await save(withWorksheet(doc.state, selected.id, worksheet.id, null), doc.rev, "Worksheet deleted");
  };
  const saveTemplate = async (worksheet: Worksheet) => {
    const template = { id: crypto.randomUUID(), title: worksheet.title, blocks: structuredClone(worksheet.blocks) };
    await save(withWorksheetTemplate(doc.state, template.id, template), doc.rev, "Worksheet template saved");
  };
  const restore = async () => {
    if (!locker.backup || !await confirmation.confirm({ title: "Restore previous version?",
      description: "Restore the worksheet changes from before your last save in this view.", confirmLabel: "Restore version", focusCancel: true })) return;
    await save(locker.backup.state, doc.rev, "Previous worksheet version restored");
  };

  return <Card className="space-y-4">
    <Card.Header className="flex-wrap gap-3">
      <h2 className="text-h4 font-semibold">Worksheets</h2>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" disabled={!locker.backup || locker.busy} onClick={() => void restore()}>Restore previous version</Button>
        {locker.backup ? <Button variant="ghost" onClick={() => downloadLockerBackup(locker.backup!)}>Download backup</Button> : null}
      </div>
    </Card.Header>
    {!studentRole && students.length ? <Field label="Student"><Select value={selected?.id ?? ""} onChange={event => {
      setStudentId(event.target.value); setPanel(null); setError("");
    }}>{students.map(student => <option key={student.id} value={student.id}>{student.name}</option>)}</Select></Field> : null}
    {!studentRole && selected ? <div className="flex flex-wrap gap-2">
      <Button disabled={locker.busy} onClick={() => setPanel({ kind: "edit", worksheet: newWorksheet(`Check-in · ${selected.name}`), revision: doc.rev })}>Start blank</Button>
      <Button variant="secondary" disabled={locker.busy} onClick={() => setPanel({ kind: "templates", revision: doc.rev })}>Template library</Button>
      <Button variant="secondary" disabled={locker.busy} onClick={() => setPanel({ kind: "playbook", revision: doc.rev })}>Guided planning</Button>
    </div> : null}
    {error ? <p role="alert" className="text-caption text-danger">{error}</p> : null}
    {worksheets.length ? <ul aria-label="Worksheets" className="space-y-2">
      {worksheets.map(worksheet => <li key={worksheet.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3">
        <div className="min-w-0 space-y-1">
          <p className="break-words font-semibold">{worksheet.title || "Untitled worksheet"}</p>
          <div className="flex flex-wrap items-center gap-2 text-caption text-text-muted">
            <Badge variant={worksheet.state === "submitted" ? "success" : "neutral"}>{worksheet.state === "draft" ? "Draft" : worksheet.state === "sent" ? "Waiting for answers" : "Submitted"}</Badge>
            <span>{worksheet.blocks.length} {worksheet.blocks.length === 1 ? "question" : "questions"}</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {worksheet.state === "draft" ? <Button size="sm" variant="secondary" disabled={locker.busy} onClick={() => setPanel({ kind: "edit", worksheet, revision: doc.rev })}>Edit {worksheet.title || "draft"}</Button> :
            <Button size="sm" variant="secondary" disabled={locker.busy} onClick={() => setPanel({ kind: studentRole && worksheet.state === "sent" ? "answer" : "review", worksheet, revision: doc.rev })}>
              {worksheet.state === "submitted" ? "Review answers" : studentRole ? "Answer worksheet" : "View worksheet"}
            </Button>}
          {!studentRole ? <>
            <Button size="sm" variant="ghost" disabled={locker.busy} onClick={() => void saveTemplate(worksheet)}>Save as template</Button>
            {worksheet.state !== "submitted" ? <Button size="sm" variant="ghost" disabled={locker.busy} onClick={() => void removeWorksheet(worksheet)}>Delete worksheet</Button> : null}
          </> : null}
        </div>
      </li>)}
    </ul> : <p className="text-caption text-text-muted">{studentRole ? "No worksheets have been assigned." : selected ? "No worksheets for this student yet." : "Add a student to create worksheets."}</p>}

    {selected && panel?.kind === "edit" ? <LockerWorksheetEditor initial={panel.worksheet} studentName={selected.name} busy={locker.busy}
      playbook={plans[panel.worksheet.id]} onClose={() => setPanel(null)} onSave={worksheet => saveWorksheet(worksheet, panel.revision, worksheet.state === "sent" ? "Worksheet sent" : "Worksheet draft saved")} /> : null}
    {panel?.kind === "review" ? <LockerWorksheetReview worksheet={panel.worksheet} onClose={() => setPanel(null)} /> : null}
    {selected && panel?.kind === "answer" ? <LockerWorksheetAnswers accountId={accountId} worksheet={panel.worksheet} coachName={coachName} busy={locker.busy}
      onClose={() => setPanel(null)} onSubmit={(answers, replays) => save(withWorksheetSubmission(doc.state, selected.id, panel.worksheet, answers, replays, new Date().toISOString()), panel.revision, "Worksheet submitted")} /> : null}
    {selected && panel?.kind === "templates" ? <WorksheetTemplates privateTemplates={templatesFor(doc.state)} busy={locker.busy} onClose={() => setPanel(null)}
      onUse={async (title, blocks, customize) => {
        const worksheet = newWorksheet(title, blocks);
        if (customize) setPanel({ kind: "edit", worksheet, revision: panel.revision });
        else if (await saveWorksheet(worksheet, panel.revision, "Worksheet template copied")) setPanel(null);
      }} onDelete={async template => {
        if (!await confirmation.confirm({ title: `Delete ${template.title}?`, confirmLabel: "Delete template", intent: "danger", focusCancel: true })) return;
        await save(withWorksheetTemplate(doc.state, template.id, null), doc.rev, "Worksheet template deleted");
      }} /> : null}
    {selected && panel?.kind === "playbook" ? <GuidedWorksheet onClose={() => setPanel(null)} onPlan={plan => {
      const worksheet = newWorksheet(`${plan.matchup || "Coaching"} decision check-in`, GUIDED_PROMPTS);
      setPlans(old => ({ ...old, [worksheet.id]: plan }));
      setPanel({ kind: "edit", worksheet, revision: panel.revision });
    }} /> : null}
    {confirmation.dialog}
  </Card>;
}

function WorksheetTemplates({ privateTemplates, busy, onUse, onDelete, onClose }: {
  privateTemplates: WorksheetTemplate[];
  busy: boolean;
  onUse: (title: string, blocks: WorksheetPrompt[], customize: boolean) => Promise<void>;
  onDelete: (template: WorksheetTemplate) => Promise<void>;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState("");
  const system = kits.templates.filter(template => !filter || (filter === "Core" ? !template.matchup : template.matchup === filter));
  const actions = (title: string, blocks: WorksheetPrompt[]) => <div className="flex flex-wrap gap-2">
    <Button size="sm" variant="secondary" disabled={busy} onClick={() => void onUse(title, blocks, false)}>Use as-is</Button>
    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void onUse(title, blocks, true)}>Customize</Button>
  </div>;
  return <Modal open size="xl" title="Worksheet template library" onClose={() => { if (!busy) onClose(); }}>
    <div className="space-y-4">
      <Field label="Template matchup"><Select value={filter} onChange={event => setFilter(event.target.value)}><option value="">All</option><option>Core</option>{MATCHUPS.map(value => <option key={value}>{value}</option>)}</Select></Field>
      <ul className="grid gap-3 sm:grid-cols-2" aria-label="System worksheet templates">
        {system.map(template => <li key={template.id} className="space-y-2 rounded-lg border border-border p-3">
          <p className="font-semibold">{template.title}</p><p className="text-caption text-text-muted">{template.description}</p>
          <details className="text-caption"><summary className="cursor-pointer">Preview {template.blocks.length} questions</summary>
            <ol className="mt-2 list-decimal space-y-1 pl-5">{template.blocks.map((block, index) => <li key={index}>{block.q}</li>)}</ol>
          </details>
          <details className="text-caption"><summary className="cursor-pointer">Private coach prompts</summary>
            <ul className="mt-2 list-disc space-y-1 pl-5">{template.coachPrompts.map(prompt => <li key={prompt}>{prompt}</li>)}</ul>
          </details>
          {actions(template.title, template.blocks as WorksheetPrompt[])}
        </li>)}
      </ul>
      <h3 className="font-semibold">Saved templates</h3>
      {privateTemplates.length ? <ul aria-label="Saved worksheet templates" className="space-y-2">
        {privateTemplates.map(template => <li key={template.id} className="space-y-2 rounded-lg border border-border p-3">
          <p className="font-semibold">{template.title}</p>
          <p className="text-caption text-text-muted">{template.blocks.length} {template.blocks.length === 1 ? "question" : "questions"}</p>
          {actions(template.title, template.blocks)}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void onDelete(template)}>Delete template</Button>
        </li>)}
      </ul> : <p className="text-caption text-text-muted">No saved templates yet.</p>}
    </div>
  </Modal>;
}

function GuidedWorksheet({ onClose, onPlan }: { onClose: () => void; onPlan: (plan: WorksheetPlaybook) => void }) {
  const [draft, setDraft] = useState<WorksheetPlaybook>({ matchup: "", evidence: "", decision: "", practice: "", proof: "" });
  const disabled = PLANNING_QUESTIONS.every(([key]) => !draft[key].trim());
  return <Modal open size="lg" title="Plan a worksheet" description="Your playbook stays in this visit. It is never saved to the worksheet or shared with the student." onClose={onClose}>
    <div className="space-y-3">
      <Field label="Matchup"><Select value={draft.matchup} onChange={event => setDraft(old => ({ ...old, matchup: event.target.value }))}><option value="">Any matchup</option>{MATCHUPS.map(value => <option key={value}>{value}</option>)}</Select></Field>
      {PLANNING_QUESTIONS.map(([key, label, hint]) => <Field key={key} label={label} hint={hint}>
        <textarea rows={2} className="w-full rounded-lg border border-border bg-bg-surface p-2" value={draft[key]} onChange={event => setDraft(old => ({ ...old, [key]: event.target.value }))} />
      </Field>)}
      <Button disabled={disabled} onClick={() => onPlan(draft)}>Keep plan beside a draft</Button>
    </div>
  </Modal>;
}
