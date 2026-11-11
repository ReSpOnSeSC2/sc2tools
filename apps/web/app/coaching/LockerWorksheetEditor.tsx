"use client";

import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { LockerWorksheetAnnotation } from "./LockerWorksheetAnnotation";
import { WORKSHEET_BLOCK_TYPES, worksheetImage, worksheetValidation, type Worksheet, type WorksheetBlock, type WorksheetBlockType } from "./lockerWorksheetModel";
import kits from "./lockerWorksheetKits.json";

export type WorksheetPlaybook = { matchup: string; evidence: string; decision: string; practice: string; proof: string };
const PROMPTS: Record<WorksheetBlockType, string> = {
  mc: "New multiple-choice question", long: "New long-form question", scale: "Rate 1–10:",
  image: "What do you see in this frame?", replay: "Attach representative games from your next practice set.",
};

export function LockerWorksheetEditor({ initial, studentName, busy, retryNotice, playbook, onClose, onSave }: {
  initial: Worksheet;
  studentName: string;
  busy: boolean;
  retryNotice?: ReactNode;
  playbook?: WorksheetPlaybook;
  onClose: () => void;
  onSave: (worksheet: Worksheet) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(() => structuredClone(initial));
  const [annotation, setAnnotation] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [confirmClose, setConfirmClose] = useState(false);
  const dirty = JSON.stringify(initial) !== JSON.stringify(draft);
  const annotationBlock = draft.blocks.find(block => block.id === annotation);

  const patch = (id: string, changes: Partial<WorksheetBlock>) => setDraft(old => ({ ...old,
    blocks: old.blocks.map(block => block.id === id ? { ...block, ...changes } : block),
  }));
  const move = (index: number, direction: number) => setDraft(old => {
    const blocks = [...old.blocks];
    [blocks[index], blocks[index + direction]] = [blocks[index + direction], blocks[index]];
    return { ...old, blocks };
  });
  const add = (ty: WorksheetBlockType) => setDraft(old => ({ ...old, blocks: [...old.blocks,
    { id: crypto.randomUUID(), ty, q: PROMPTS[ty], ...(ty === "mc" ? { opts: ["Option A", "Option B"] } : {}), ...(ty === "image" ? { img: null } : {}) },
  ] }));
  const close = () => {
    if (busy) return;
    if (annotation) { setAnnotation(null); return; }
    if (dirty) setConfirmClose(true);
    else onClose();
  };
  const save = async (state: "draft" | "sent") => {
    if (retryNotice) return;
    const validation = state === "sent" ? worksheetValidation(draft) : null;
    if (validation) { setError(validation); return; }
    setError("");
    if (await onSave({ ...draft, state })) onClose();
  };

  return <Modal open size="xl" title={annotationBlock ? "Annotate a screenshot" : `Worksheet for ${studentName}`} onClose={close}>
    {retryNotice}
    {annotationBlock ? <LockerWorksheetAnnotation existing={annotationBlock.img} onCancel={() => setAnnotation(null)} onSave={img => {
      patch(annotationBlock.id, { img }); setAnnotation(null);
    }} /> : <div className="space-y-4">
      {playbook ? <details open className="rounded-lg border border-border p-3 text-caption">
        <summary className="cursor-pointer font-semibold">Private coach plan{playbook.matchup ? ` · ${playbook.matchup}` : ""}</summary>
        <dl className="mt-3 space-y-2">
          {(["evidence", "decision", "practice", "proof"] as const).filter(key => playbook[key]).map(key => <div key={key}>
            <dt className="font-semibold capitalize">{key}</dt><dd className="whitespace-pre-wrap text-text-muted">{playbook[key]}</dd>
          </div>)}
        </dl>
        <p className="mt-2 text-text-muted">This plan stays in this visit and is never sent to the student.</p>
      </details> : null}
      <details className="rounded-lg border border-border p-3 text-caption"><summary className="cursor-pointer font-semibold">Worksheet planning prompts</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-text-muted">{kits.guidance.prompts.map(prompt => <li key={prompt}>{prompt}</li>)}</ul>
      </details>
      <Field label="Worksheet title"><Input value={draft.title} disabled={busy} onChange={event => setDraft(old => ({ ...old, title: event.target.value }))} /></Field>
      <ol className="space-y-3" aria-label="Worksheet questions">
        {draft.blocks.map((block, index) => <li key={block.id} className="space-y-3 rounded-lg border border-border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-semibold">{WORKSHEET_BLOCK_TYPES[block.ty]}</p>
            <div className="flex flex-wrap gap-1">
              <Button size="sm" variant="ghost" disabled={busy || !index} onClick={() => move(index, -1)} aria-label={`Move question ${index + 1} up`}>Move up</Button>
              <Button size="sm" variant="ghost" disabled={busy || index + 1 === draft.blocks.length} onClick={() => move(index, 1)} aria-label={`Move question ${index + 1} down`}>Move down</Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDraft(old => ({ ...old, blocks: old.blocks.filter(row => row.id !== block.id) }))} aria-label={`Remove question ${index + 1}`}>Remove</Button>
            </div>
          </div>
          <Field label={`Question ${index + 1}`}><Input value={block.q} disabled={busy} onChange={event => patch(block.id, { q: event.target.value })} /></Field>
          {block.ty === "mc" ? <div className="space-y-2">
            {(block.opts ?? []).map((option, optionIndex) => <div key={optionIndex} className="flex flex-wrap items-end gap-2">
              <Field className="min-w-0 flex-1" label={`Question ${index + 1} option ${optionIndex + 1}`}>
                <Input value={option} disabled={busy} onChange={event => patch(block.id, { opts: (block.opts ?? []).map((text, i) => i === optionIndex ? event.target.value : text) })} />
              </Field>
              <Button size="sm" variant="ghost" disabled={busy} aria-label={`Remove option ${optionIndex + 1} from question ${index + 1}`} onClick={() => patch(block.id, { opts: (block.opts ?? []).filter((_value, i) => i !== optionIndex) })}>Remove</Button>
            </div>)}
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => patch(block.id, { opts: [...(block.opts ?? []), ""] })}>Add option</Button>
          </div> : null}
          {block.ty === "image" ? <div className="space-y-2">
            {worksheetImage(block.img) ? <img className="max-h-60 max-w-full rounded-lg" src={worksheetImage(block.img)!} alt="Annotated worksheet frame" /> : null}
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => setAnnotation(block.id)}>{block.img ? "Edit annotation" : "Upload and annotate screenshot"}</Button>
          </div> : null}
          {block.ty === "replay" ? <p className="text-caption text-text-muted">The student can attach SC2 replay files with their answers.</p> : null}
        </li>)}
      </ol>
      <div role="group" aria-label="Add question" className="flex flex-wrap gap-2">
        {(Object.keys(WORKSHEET_BLOCK_TYPES) as WorksheetBlockType[]).map(type => <Button key={type} size="sm" variant="secondary" disabled={busy} onClick={() => add(type)}>Add {WORKSHEET_BLOCK_TYPES[type].toLowerCase()}</Button>)}
      </div>
      {error ? <p className="text-caption text-danger" role="alert">{error}</p> : null}
      {confirmClose ? <div className="space-y-2 rounded-lg border border-warning/40 p-3" role="alert">
        <p>Discard your worksheet edits?</p><div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setConfirmClose(false)}>Keep editing</Button>
          <Button variant="danger" onClick={onClose}>Discard edits</Button>
        </div>
      </div> : null}
      <div className="flex flex-wrap gap-2">
        <Button loading={busy} disabled={!!retryNotice} onClick={() => void save("draft")}>Save draft</Button>
        <Button variant="secondary" disabled={busy || !!retryNotice} onClick={() => void save("sent")}>Send to {studentName}</Button>
        <Button variant="ghost" disabled={busy} onClick={close}>Close editor</Button>
      </div>
    </div>}
  </Modal>;
}
