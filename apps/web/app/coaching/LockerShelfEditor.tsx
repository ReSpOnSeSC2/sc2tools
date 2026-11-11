"use client";

import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { readShelfFile, shelfLink, SHELF_KINDS, type ShelfAsset, type ShelfItem, type ShelfKind } from "./lockerShelfModel";

const FILE_TYPES: Partial<Record<ShelfKind, string>> = {
  voice: "audio/*", video: "video/*", image: "image/png,image/jpeg,image/webp,image/gif,image/avif", replay: ".SC2Replay", pdf: ".pdf",
};

export function LockerShelfEditor({ library, onClose, onAdd, busy, retryNotice }: {
  library: boolean; onClose: () => void; busy: boolean;
  onAdd: (item: ShelfItem, asset?: [string, ShelfAsset]) => Promise<boolean>; retryNotice?: ReactNode;
}) {
  const [kind, setKind] = useState<ShelfKind>("notes"), [title, setTitle] = useState(""), [notes, setNotes] = useState("");
  const [file, setFile] = useState<File>(), [link, setLink] = useState("");
  const [reading, setReading] = useState(false), [error, setError] = useState("");
  const inFlight = useRef(false);
  const acceptsLink = kind === "video" || kind === "replay" || kind === "pdf";
  const working = reading || busy;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (working || retryNotice || inFlight.current || !title.trim()) return;
    setError("");
    const href = shelfLink(link);
    if (link.trim() && !href) { setError("Enter a valid HTTP or HTTPS link."); return; }
    if (kind !== "notes" && !file && !href) { setError("Choose a file or supply an attachment link."); return; }
    if (file && href) { setError("Choose a file or a link for this item."); return; }
    inFlight.current = true;
    setReading(true);
    try {
      const attachment = file ? [crypto.randomUUID(), await readShelfFile(file, kind)] as [string, ShelfAsset] : undefined;
      const item = { id: crypto.randomUUID(), ty: kind, t: title.trim(), n: notes.trim(),
        ...(href ? { link: href } : {}), ...(attachment ? { asset: attachment[0] } : {}) };
      if (await onAdd(item, attachment)) onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The item could not be added.");
    } finally {
      setReading(false);
      inFlight.current = false;
    }
  }
  return <Modal open title={library ? "Add library item" : "Add shelf item"} onClose={() => { if (!working) onClose(); }}>
    <form className="space-y-4" onSubmit={event => void submit(event)}>
      {retryNotice}
      {library ? <p className="text-caption text-text-muted">Coaches share this library. Choose resources you can reuse with any student.</p> : null}
      <Field label="Item type"><Select value={kind} disabled={working} onChange={event => {
        setKind(event.target.value as ShelfKind); setFile(undefined); setLink(""); setError("");
      }}>{Object.entries(SHELF_KINDS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select></Field>
      <Field label="Title" required><Input required maxLength={180} value={title} disabled={working} onChange={event => setTitle(event.target.value)} /></Field>
      <Field label="Notes"><textarea className="w-full rounded-lg border border-border bg-bg-surface p-3 text-body text-text" rows={4} maxLength={5000}
        value={notes} disabled={working} onChange={event => setNotes(event.target.value)} /></Field>
      {kind !== "notes" ? <Field label="Attachment file"><input key={kind} type="file" accept={FILE_TYPES[kind]} disabled={working} onChange={event => setFile(event.target.files?.[0])} /></Field> : null}
      {acceptsLink ? <Field label="Attachment link"><Input value={link} inputMode="url" maxLength={2048} disabled={working} onChange={event => setLink(event.target.value)} /></Field> : null}
      {error ? <p role="alert" className="text-caption text-danger">{error}</p> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="secondary" disabled={working} onClick={onClose}>Cancel</Button>
        <Button type="submit" disabled={working || !!retryNotice || !title.trim()}>{working ? "Adding…" : "Add item"}</Button>
      </div>
    </form>
  </Modal>;
}
