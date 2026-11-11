"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { WORKSHEET_BLOCK_TYPES, worksheetImage, type Worksheet, type WorksheetAnswer, type WorksheetAnswers, type WorksheetBlock, type WorksheetReplay } from "./lockerWorksheetModel";

const MAX_REPLAY_BYTES = 900 * 1024;
const ANSWER_STYLE = "w-full rounded-lg border border-border bg-bg-surface px-3 py-2 text-body focus-visible:outline focus-visible:outline-accent";

export function worksheetAnswerDraftKey(accountId: string, worksheetId: string) {
  return `locker.worksheet.answers.${encodeURIComponent(accountId)}.${encodeURIComponent(worksheetId)}`;
}

function readDraft(key: string, worksheet: Worksheet): WorksheetAnswers {
  try {
    const data = JSON.parse(sessionStorage.getItem(key) ?? "{}");
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    return Object.fromEntries(worksheet.blocks.flatMap(block => {
      if (!Object.hasOwn(data, block.id)) return [];
      const value = data[block.id];
      if ((block.ty === "long" || block.ty === "image") && typeof value === "string") return [[block.id, value]];
      if (block.ty === "scale" && Number.isInteger(value) && value >= 1 && value <= 10) return [[block.id, value]];
      if (block.ty === "mc" && Number.isInteger(value) && value >= 0 && value < (block.opts?.length ?? 0)) return [[block.id, value]];
      return [];
    }));
  } catch { return {}; }
}

function writeDraft(key: string, value: WorksheetAnswers | null) {
  try {
    if (!value || !Object.keys(value).length) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
  } catch { /* Answers remain editable while this view is open. */ }
}

function readReplay(file: File, title: string): Promise<WorksheetReplay> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.onload = () => {
      const b64 = typeof reader.result === "string" ? reader.result.split(",")[1] : "";
      if (!b64) { reject(new Error(`Could not read ${file.name}.`)); return; }
      resolve({ id: crypto.randomUUID(), name: file.name, size: file.size, b64, build: `worksheet: ${title}`, at: new Date().toISOString(), exported: false });
    };
    reader.readAsDataURL(file);
  });
}

function ResponseText({ block, answer }: { block: WorksheetBlock; answer?: WorksheetAnswer }) {
  const image = worksheetImage(block.img);
  const text = block.ty === "mc" && typeof answer === "number" ? block.opts?.[answer]
    : block.ty === "scale" && typeof answer === "number" ? `${answer} / 10`
      : block.ty === "replay" && answer && typeof answer === "object" ? `${answer.count} ${answer.count === 1 ? "replay" : "replays"} submitted`
        : typeof answer === "string" ? answer : undefined;
  return <>
    {image ? <img className="max-h-64 max-w-full rounded-lg" src={image} alt="Coach-annotated frame" /> : null}
    {text !== undefined ? <p className="whitespace-pre-wrap text-text-muted">{text || "No answer"}</p> : null}
  </>;
}

export function LockerWorksheetReview({ worksheet, onClose, retryNotice }: { worksheet: Worksheet; onClose: () => void; retryNotice?: ReactNode }) {
  return <Modal open size="lg" title={worksheet.title} onClose={onClose}>
    {retryNotice}
    <ol className="space-y-3" aria-label={worksheet.state === "submitted" ? "Worksheet answers" : "Worksheet questions"}>
      {worksheet.blocks.map(block => <li key={block.id} className="space-y-2 rounded-lg border border-border p-3">
        <p className="text-caption text-text-muted">{WORKSHEET_BLOCK_TYPES[block.ty]}</p>
        <p className="whitespace-pre-wrap font-semibold">{block.q}</p>
        {worksheet.state !== "submitted" && block.ty === "mc" ? <ul className="list-disc pl-5 text-text-muted">{block.opts?.map((option, index) => <li key={index}>{option}</li>)}</ul> : null}
        <ResponseText block={block} answer={worksheet.answers[block.id]} />
      </li>)}
    </ol>
    <Button className="mt-4" variant="secondary" onClick={onClose}>Close</Button>
  </Modal>;
}

export function LockerWorksheetAnswers({ accountId, worksheet, coachName, busy, retryNotice, onClose, onSubmit }: {
  accountId: string;
  worksheet: Worksheet;
  coachName: string;
  busy: boolean;
  retryNotice?: ReactNode;
  onClose: () => void;
  onSubmit: (answers: WorksheetAnswers, replays: WorksheetReplay[]) => Promise<boolean>;
}) {
  const key = worksheetAnswerDraftKey(accountId, worksheet.id);
  const [answers, setAnswers] = useState(() => readDraft(key, worksheet));
  const [replays, setReplays] = useState<Record<string, WorksheetReplay[]>>({});
  const [reading, setReading] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [error, setError] = useState("");
  const fieldId = useId();
  const attachments = Object.values(replays).flat();

  useEffect(() => writeDraft(key, answers), [key, answers]);
  const close = () => {
    if (busy || reading) return;
    if (attachments.length) setConfirmClose(true);
    else onClose();
  };
  const attach = async (id: string, files: File[]) => {
    if (!files.length) return;
    setReading(true); setError("");
    const valid = files.filter(file => /\.SC2Replay$/i.test(file.name) && file.size > 0 && file.size <= MAX_REPLAY_BYTES);
    try {
      const added = await Promise.all(valid.map(file => readReplay(file, worksheet.title)));
      setReplays(previous => ({ ...previous, [id]: [...(previous[id] ?? []), ...added] }));
      if (valid.length !== files.length) setError("Some files were skipped. Attach SC2Replay files no larger than 900 KB.");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Could not read the replay files."); }
    finally { setReading(false); }
  };
  const setAnswer = (id: string, answer: WorksheetAnswer) => setAnswers(previous => ({ ...previous, [id]: answer }));
  const submit = async () => {
    if (retryNotice) return;
    const counts = Object.fromEntries(Object.entries(replays).map(([id, files]) => [id, { count: files.length }]));
    if (await onSubmit({ ...answers, ...counts }, attachments)) {
      writeDraft(key, null); onClose();
    }
  };
  return <Modal open size="lg" title={worksheet.title} description="Your answers are shared when you send the worksheet." onClose={close}>
    {retryNotice}
    <ol className="space-y-4" aria-label="Worksheet questions">
      {worksheet.blocks.map((block, index) => {
        const prompt = block.q;
        const value = answers[block.id];
        const image = worksheetImage(block.img);
        return <li key={block.id} className="space-y-2 rounded-lg border border-border p-3">
          {block.ty === "mc" ? <fieldset className="space-y-2"><legend className="font-semibold">{prompt}</legend>
            {block.opts?.map((option, optionIndex) => <label key={optionIndex} className="flex min-h-10 items-center gap-2">
              <input type="radio" name={`${fieldId}-${block.id}`} checked={value === optionIndex} disabled={busy}
                onChange={() => setAnswer(block.id, optionIndex)} className="accent-accent" />{option}
            </label>)}
          </fieldset> : null}
          {block.ty === "scale" ? <fieldset><legend className="font-semibold">{prompt}</legend>
            <div className="mt-2 flex flex-wrap gap-1">{Array.from({ length: 10 }, (_, i) => i + 1).map(choice =>
              <Button key={choice} size="sm" variant={value === choice ? "secondary" : "ghost"} disabled={busy} aria-pressed={value === choice}
                onClick={() => setAnswer(block.id, choice)}>{choice}</Button>)}</div>
          </fieldset> : null}
          {block.ty === "long" || block.ty === "image" ? <>
            {image ? <img className="max-h-64 max-w-full rounded-lg" src={image} alt="Coach-annotated frame" /> : null}
            <Field label={prompt}><textarea className={ANSWER_STYLE} rows={3} disabled={busy} value={typeof value === "string" ? value : ""}
              onChange={event => setAnswer(block.id, event.target.value)} /></Field>
          </> : null}
          {block.ty === "replay" ? <>
            <p className="font-semibold">{prompt}</p>
            <Field label={`Attach replays for question ${index + 1}`} hint="SC2Replay files, up to 900 KB each.">
              <Input type="file" multiple accept=".SC2Replay" disabled={busy || reading} onChange={event => {
                const files = [...(event.target.files ?? [])]; event.target.value = ""; void attach(block.id, files);
              }} />
            </Field>
            {(replays[block.id] ?? []).map(replay => <div key={replay.id} className="flex flex-wrap items-center gap-2 text-caption">
              <span className="break-all">{replay.name}</span><Button size="sm" variant="ghost" disabled={busy || reading}
                onClick={() => setReplays(old => ({ ...old, [block.id]: (old[block.id] ?? []).filter(item => item.id !== replay.id) }))}>Remove {replay.name}</Button>
            </div>)}
          </> : null}
        </li>;
      })}
    </ol>
    {error ? <p role="alert" className="mt-3 text-caption text-danger">{error}</p> : null}
    {confirmClose ? <div className="mt-3 space-y-2 rounded-lg border border-warning/40 p-3" role="alert">
      <p>Your answers will be kept in this tab. Closing removes the files you attached here.</p>
      <div className="flex flex-wrap gap-2"><Button variant="secondary" onClick={() => setConfirmClose(false)}>Keep answering</Button>
        <Button variant="danger" onClick={onClose}>Close and remove attachments</Button></div>
    </div> : null}
    <div className="mt-4 flex flex-wrap gap-2">
      <Button loading={busy} disabled={reading || !!retryNotice} onClick={() => void submit()}>Send to {coachName}</Button>
      <Button variant="secondary" disabled={busy || reading} onClick={close}>Close</Button>
    </div>
  </Modal>;
}
