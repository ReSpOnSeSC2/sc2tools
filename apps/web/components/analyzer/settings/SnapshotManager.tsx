"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { Camera, Database, Download, History, Trash2 } from "lucide-react";
import { apiCall, useApi } from "@/lib/clientApi";
import { Card, Skeleton } from "@/components/ui/Card";
import { Section } from "@/components/ui/Section";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { useToast } from "@/components/ui/Toast";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { fmtAgo } from "@/lib/format";
import { SettingsLoadError } from "./SettingsLoadError";
import { backupErrorMessage } from "./backupErrors";
import { toClientApiError } from "@/lib/requestErrors";

type Backup = { id: string; label?: string; createdAt: string; sizeBytes: number; type: "manual" | "auto" | "pre_action"; counts?: Record<string, number> };
type Preview = { games: { kept: number; removed: number; added: number }; customBuilds: number; opponentNotes: number; overlayTokens: number; currentRevision: string };

export function SnapshotManager({ onRestored }: { onRestored: () => Promise<void> }) {
  const { getToken } = useAuth(); const tokenRef = useRef(getToken); tokenRef.current = getToken;
  const backups = useApi<{ items: Backup[] }>("/v1/me/backups"); const { toast } = useToast();
  const [busy, setBusy] = useState(""); const [target, setTarget] = useState<Backup | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Backup | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null); const [previewError, setPreviewError] = useState(false); const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setPreview(null); setPreviewError(false); if (!target) return;
    let cancelled = false;
    void apiCall<Preview>(tokenRef.current, `/v1/me/backups/${encodeURIComponent(target.id)}/preview`)
      .then((answer) => { if (!cancelled) setPreview(answer); })
      .catch(() => { if (!cancelled) setPreviewError(true); });
    return () => { cancelled = true; };
  }, [target, attempt]);
  async function action(key: string, run: () => Promise<void>) {
    if (busy) return; setBusy(key);
    try { await run(); } catch (error) { toast.error("Couldn't complete snapshot action", { description: backupErrorMessage(error) }); }
    finally { setBusy(""); }
  }
  async function restore() {
    if (!target || !preview) return;
    await action("restore", async () => {
      let result: { counts: { games: number } };
      try { result = await apiCall(getToken, `/v1/me/backups/${encodeURIComponent(target.id)}/restore`, { method: "POST", body: JSON.stringify({ currentRevision: preview.currentRevision }) }); }
      catch (error) { if (toClientApiError(error).code === "backup_preview_changed") { setPreview(null); setAttempt((value) => value + 1); } throw error; }
      await Promise.allSettled([backups.mutate(), onRestored()]); setTarget(null);
      toast.success(`Restored ${result.counts.games.toLocaleString()} games`, { description: "Existing build orders and replay files for games in both lists were kept." });
    });
  }
  const items = backups.data?.items || [];
  return <Section title="Snapshots" description="Your own restore points for your account. Preview changes before restoring."
    actions={<Button variant="primary" loading={busy === "create"} disabled={Boolean(busy)} iconLeft={<Camera className="h-4 w-4" aria-hidden />}
      onClick={() => void action("create", async () => { await apiCall(getToken, "/v1/me/backups", { method: "POST", body: "{}" }); await backups.mutate(); toast.success("Snapshot created"); })}>Take a snapshot</Button>}>
    <Card padded={!items.length}>
      {backups.isLoading ? <Skeleton rows={3} /> : backups.error && !backups.data ? <SettingsLoadError tab="snapshots" error={backups.error} retry={backups.mutate} /> : !items.length ?
        <EmptyStatePanel icon={<Database className="h-6 w-6" aria-hidden />} title="No snapshots yet" description="Take one before a big import or a history wipe." /> :
        <ul className="divide-y divide-border">{items.map((backup) => <SnapshotRow key={backup.id} backup={backup} busy={Boolean(busy)}
          onLabel={(label) => void action(backup.id, async () => { await apiCall(getToken, `/v1/me/backups/${encodeURIComponent(backup.id)}`, { method: "PATCH", body: JSON.stringify({ label }) }); await backups.mutate(); toast.success("Snapshot renamed"); })}
          onDownload={() => void action(backup.id, async () => { const result = await apiCall<{ url: string }>(getToken, `/v1/me/backups/${encodeURIComponent(backup.id)}/download`); window.location.assign(result.url); })}
          onRestore={() => { setPreview(null); setTarget(backup); }} onDelete={() => setPendingDelete(backup)} />)}</ul>}
    </Card>
    <div className="mt-3 space-y-2 text-caption text-text-muted">
      <p>Snapshots are compressed downloads stored separately from the database. We keep your newest 5 manual snapshots, 2 weekly automatic snapshots and 3 snapshots taken before a restore, wipe or repair.</p>
      <details><summary className="cursor-pointer text-text">What does restore change?</summary><p className="mt-2">It replaces the saved games list, opponents, notes, custom builds, profile, ordinary settings and overlay tokens. Build orders, charts and replay files for games in both lists are kept. Files for removed games are deleted. Files for games absent from your current data need a desktop Re-sync. Paired PCs, onboarding progress, notification preferences, import history, community posts and coaching records stay outside this restore.</p></details>
      <LazyHelpLink slug="backups-and-export">How backups work</LazyHelpLink>
    </div>
    <Modal open={Boolean(target)} onClose={() => { if (!busy) setTarget(null); }} title="Restore from snapshot?" size="sm" footer={<>
      <Button variant="secondary" disabled={Boolean(busy)} onClick={() => setTarget(null)}>Cancel</Button>
      <Button variant="danger" disabled={!preview || Boolean(busy)} loading={busy === "restore"} onClick={() => void restore()}>Restore</Button></>}>
      {!preview ? previewError ? <div role="alert" className="space-y-3"><p>Couldn&apos;t preview this snapshot. Your saved data hasn&apos;t changed.</p><Button onClick={() => setAttempt((value) => value + 1)}>Try again</Button></div> : <p role="status">Checking snapshot changes…</p> : <div className="space-y-3 text-body-sm">
        <p>Build orders and replay files for {preview.games.kept.toLocaleString()} games are kept.</p>
        <ul className="list-inside list-disc"><li>{preview.games.removed.toLocaleString()} current games removed</li><li>{preview.games.added.toLocaleString()} saved games added</li><li>{preview.customBuilds.toLocaleString()} custom builds, {preview.opponentNotes.toLocaleString()} opponent notes and {preview.overlayTokens.toLocaleString()} overlay tokens restored</li></ul>
        <p>Games added since then are removed when absent from this snapshot. A fresh snapshot is saved before restore. Re-sync from the desktop app to recover files for games that are no longer in your current data.</p>
      </div>}
    </Modal>
    <ConfirmDialog open={Boolean(pendingDelete)} title="Delete this snapshot?" description="The compressed backup and its metadata will be deleted. Your current games stay as they are." intent="danger" confirmLabel="Delete snapshot" loading={busy === "delete"}
      onClose={() => { if (!busy) setPendingDelete(null); }} onConfirm={() => { if (pendingDelete) void action("delete", async () => { await apiCall(getToken, `/v1/me/backups/${encodeURIComponent(pendingDelete.id)}`, { method: "DELETE" }); await backups.mutate(); setPendingDelete(null); toast.success("Snapshot deleted"); }); }} />
  </Section>;
}

function SnapshotRow({ backup, busy, onLabel, onDownload, onRestore, onDelete }: { backup: Backup; busy: boolean; onLabel: (label: string) => void; onDownload: () => void; onRestore: () => void; onDelete: () => void }) {
  const [label, setLabel] = useState(backup.label || "");
  return <li className="space-y-3 px-4 py-3">
    <div className="flex flex-wrap items-center gap-2"><Badge variant={backup.type === "manual" ? "cyan" : "neutral"} size="sm">{backup.type === "pre_action" ? "Before action" : backup.type === "auto" ? "Weekly" : "Manual"}</Badge><span className="text-caption text-text-muted">{fmtAgo(backup.createdAt)} · {(backup.sizeBytes / 1024 / 1024).toFixed(1)} MB</span></div>
    <div className="flex gap-2"><Input aria-label={`Snapshot label ${backup.id}`} value={label} maxLength={80} placeholder="Add a label" disabled={busy} onChange={(event) => setLabel(event.target.value)} /><Button size="sm" disabled={busy || label === (backup.label || "")} onClick={() => onLabel(label)}>Save label</Button></div>
    <div className="flex flex-wrap gap-2 text-caption text-text-muted">{["games", "customBuilds", "opponentNotes", "overlayTokens"].filter((key) => typeof backup.counts?.[key] === "number").map((key) => <span className="rounded bg-surface-2 px-2 py-1" key={key}>{backup.counts![key].toLocaleString()} {({ games: "games", customBuilds: "builds", opponentNotes: "notes", overlayTokens: "tokens" } as Record<string, string>)[key]}</span>)}</div>
    <div className="flex flex-wrap gap-2"><Button variant="secondary" size="sm" disabled={busy} iconLeft={<Download className="h-4 w-4" aria-hidden />} onClick={onDownload}>Download</Button><Button variant="secondary" size="sm" disabled={busy} iconLeft={<History className="h-4 w-4" aria-hidden />} onClick={onRestore}>Restore</Button><Button variant="ghost" size="sm" disabled={busy} iconLeft={<Trash2 className="h-4 w-4" aria-hidden />} onClick={onDelete}>Delete snapshot</Button></div>
  </li>;
}
