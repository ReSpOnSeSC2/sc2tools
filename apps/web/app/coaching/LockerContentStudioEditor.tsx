"use client";

import Image from "next/image";
import { useEffect, useRef, useState, type ComponentType, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { LockerStudioGuides, appendStudioPrompt, type StudioKind } from "./LockerStudioGuides";
import { LockerStudioReplayPicker } from "./LockerStudioReplayPicker";
import { shelfReplayContext, studioReplayTitle, type StudioReplay } from "./lockerStudioReplays";
import { STUDIO_FILE_LIMITS, STUDIO_FILE_TYPES, STUDIO_TITLES, studioAnnotatedFile, validateStudioDraft, type StudioDraft } from "./lockerContentStudioModel";
import { useLockerVoiceRecorder } from "./useLockerVoiceRecorder";

export type StudioAnnotationProps = { existing?: string | null; onSave: (data: string) => void; onCancel: () => void };

const TEXTAREA = "w-full rounded-lg border border-border bg-bg-surface p-3 text-body text-text";
const FILE_HINTS: Partial<Record<StudioKind, string>> = {
  voice: "Audio up to 2.5 MiB", video: "MP4 or WebM up to 6 MiB", replay: "SC2Replay up to 900 KiB", pdf: "PDF up to 4 MiB",
};

export function LockerContentStudioEditor({ kind, studentName, studentUserId, busy, retryNotice, revisionChanged, targetUnavailable = false, onReviewLatest, onClose, onAdd, Annotation }: {
  kind: StudioKind; studentName: string; studentUserId?: string; busy: boolean; retryNotice?: ReactNode; revisionChanged: boolean;
  targetUnavailable?: boolean;
  onReviewLatest: () => void; onClose: () => void; onAdd: (draft: StudioDraft) => Promise<boolean>;
  Annotation: ComponentType<StudioAnnotationProps>;
}) {
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [outline, setOutline] = useState("");
  const [file, setFile] = useState<File>();
  const [link, setLink] = useState("");
  const [replay, setReplay] = useState<StudioReplay>();
  const [chooser, setChooser] = useState<"replay" | "annotation" | null>(null);
  const [annotation, setAnnotation] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const saving = useRef(false);
  const working = busy || submitting;
  const recorder = useLockerVoiceRecorder(setFile);
  const recording = recorder.phase !== "idle";
  const media = kind === "voice" || kind === "video" || kind === "image";
  const canLink = kind === "replay" || kind === "video";

  function chooseFile(next?: File) {
    setError("");
    if (next && (!next.size || next.size > (STUDIO_FILE_LIMITS[kind] ?? 0))) {
      setError(`Choose a nonempty file that meets the size limit. ${FILE_HINTS[kind] ?? ""}`.trim());
      return;
    }
    setFile(next);
    if (next) { setReplay(undefined); setLink(""); }
  }

  function chooseReplay(next: StudioReplay) {
    setReplay(next); setChooser(null); setFile(undefined); setError("");
    setTitle(previous => previous || studioReplayTitle(next));
  }

  function saveAnnotation(data: string) {
    try {
      setFile(studioAnnotatedFile(data));
      setAnnotation(data); setChooser(null); setError("");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "The screenshot could not be saved."); }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving.current || working || recording || chooser || retryNotice || revisionChanged || targetUnavailable) return;
    saving.current = true; setSubmitting(true); setError("");
    try {
      const draft = await validateStudioDraft({ kind, title, notes, file, link, replay: replay ? shelfReplayContext(replay) : undefined });
      if (await onAdd(draft)) onClose();
      else setError("The item was not added. Your draft is still here.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The item could not be added.");
    } finally { saving.current = false; setSubmitting(false); }
  }

  return <Modal open title={STUDIO_TITLES[kind]} onClose={() => { if (!working) onClose(); }}>
    <form className="min-w-0 space-y-4" onSubmit={event => void submit(event)}>
      <p className="break-words text-caption text-text-muted">This item will be added to {studentName}’s shelf.</p>
      <LockerStudioGuides kind={kind} disabled={working} onInsert={(text, suggestedTitle) => {
        if (kind === "voice") setOutline(previous => appendStudioPrompt(previous, text, 2500));
        else {
          setNotes(previous => appendStudioPrompt(previous, text));
          if (suggestedTitle) setTitle(previous => previous || suggestedTitle);
        }
      }} />
      {kind === "voice" ? <VoiceControls recorder={recorder} outline={outline} setOutline={setOutline} working={working} /> : null}
      {kind === "image" && chooser !== "annotation" ? <Button type="button" variant="secondary" disabled={working}
        onClick={() => setChooser("annotation")}>{file ? "Edit screenshot annotation" : "Annotate a screenshot"}</Button> : null}
      {chooser === "annotation" ? <Annotation existing={annotation} onSave={saveAnnotation} onCancel={() => setChooser(null)} /> : null}
      {kind === "replay" && chooser !== "replay" ? <Button type="button" variant="secondary" disabled={working}
        onClick={() => setChooser("replay")}>{replay ? "Choose another replay" : "Browse SC2 Tools replays"}</Button> : null}
      {chooser === "replay" ? <LockerStudioReplayPicker studentName={studentName} studentUserId={studentUserId} onPick={chooseReplay} onCancel={() => setChooser(null)} /> : null}
      {replay ? <div className="flex flex-wrap items-center gap-2 rounded border border-border p-2 text-caption">
        <span className="break-words">Selected replay · {studioReplayTitle(replay)}</span>
        <Button type="button" size="sm" variant="ghost" disabled={working} onClick={() => setReplay(undefined)}>Clear replay</Button>
      </div> : null}
      {STUDIO_FILE_TYPES[kind] ? <Field label={kind === "voice" ? "Attach an audio file" : "Attach a file"} hint={FILE_HINTS[kind]}>
        <Input type="file" accept={STUDIO_FILE_TYPES[kind]} disabled={working || recording} onChange={event => {
          chooseFile(event.target.files?.[0]); event.target.value = "";
        }} />
      </Field> : null}
      {file ? <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2"><p className="break-all text-caption text-text-muted">{file.name}</p>
          <Button type="button" size="sm" variant="ghost" disabled={working || recording} onClick={() => { setFile(undefined); setAnnotation(null); }}>Remove attachment</Button></div>
        {media ? <MediaPreview file={file} kind={kind} /> : null}
      </div> : null}
      {canLink ? <Field label={kind === "replay" ? "Replay share link (optional when a replay is selected)" : "Video link"}
        hint={kind === "replay" && replay ? "Paste a replay share link if the student should be able to open the game." : undefined}>
        <Input inputMode="url" maxLength={2048} value={link} disabled={working} onChange={event => {
          setLink(event.target.value); if (event.target.value) setFile(undefined);
        }} />
      </Field> : null}
      <Field label="Title"><Input value={title} maxLength={180} placeholder={STUDIO_TITLES[kind]} disabled={working} onChange={event => setTitle(event.target.value)} /></Field>
      <Field label={kind === "notes" ? "Session notes" : "Coaching note"} required={kind === "notes"}>
        <textarea className={TEXTAREA} rows={5} value={notes} maxLength={5000} disabled={working} onChange={event => setNotes(event.target.value)} />
      </Field>
      {retryNotice}
      {targetUnavailable ? <p role="alert" className="text-caption text-danger">This student is no longer available. You can copy your draft before closing.</p> : null}
      {revisionChanged && !targetUnavailable && !retryNotice ? <div className="space-y-2" role="status"><p className="text-caption text-text-muted">The shelf changed while you were editing. Review the shelf before adding your draft to the latest version.</p>
        <Button type="button" size="sm" variant="secondary" disabled={working} onClick={onReviewLatest}>Use the latest shelf revision</Button></div> : null}
      {error ? <p role="alert" className="text-caption text-danger">{error}</p> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="secondary" disabled={working} onClick={onClose}>Cancel</Button>
        <Button type="submit" disabled={working || recording || !!chooser || !!retryNotice || revisionChanged || targetUnavailable}>{working ? "Adding…" : "Add to shelf"}</Button>
      </div>
    </form>
  </Modal>;
}

function VoiceControls({ recorder, outline, setOutline, working }: { recorder: ReturnType<typeof useLockerVoiceRecorder>; outline: string; setOutline: (value: string) => void; working: boolean }) {
  return <div className="space-y-2">
    <Field label="Private speaking outline" hint="This draft helps you record and stays in this editor.">
      <textarea className={TEXTAREA} rows={4} value={outline} maxLength={2500} disabled={working} onChange={event => setOutline(event.target.value)} />
    </Field>
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" variant="secondary" disabled={working} onClick={() => recorder.phase === "idle" ? void recorder.start() : recorder.stop()}>
        {recorder.phase === "recording" ? "Stop recording" : recorder.phase === "requesting" ? "Cancel microphone request" : "Start recording"}
      </Button>
      <span className="text-caption text-text-muted">{recorder.phase === "recording" ? `${recorder.seconds} / 90 seconds` : "Up to 90 seconds"}</span>
    </div>
    {recorder.error ? <p role="alert" className="text-caption text-danger">{recorder.error}</p> : null}
  </div>;
}

function MediaPreview({ file, kind }: { file: File; kind: StudioKind }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);
  if (!url) return null;
  if (kind === "voice" || kind === "video") return <a href={url} target="_blank" rel="noopener noreferrer"
    className="inline-flex min-h-11 items-center text-caption underline">
    {kind === "voice" ? "Preview voice memo" : "Preview video attachment"}<span className="sr-only"> (opens in new tab)</span>
  </a>;
  return <div className="relative aspect-video max-h-48"><Image src={url} unoptimized fill alt="Annotated screenshot preview" className="object-contain" /></div>;
}
