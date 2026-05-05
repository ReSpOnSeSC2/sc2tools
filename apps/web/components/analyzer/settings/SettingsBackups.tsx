"use client";

import { useState } from "react";
import { useAuth } from "@clerk/nextjs";
import {
  Database,
  Download,
  Camera,
  History,
  Trash2,
} from "lucide-react";
import { apiCall, useApi, API_BASE, type ClientApiError } from "@/lib/clientApi";
import { Card, Skeleton } from "@/components/ui/Card";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { Section } from "@/components/ui/Section";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { fmtAgo } from "@/lib/format";

type Backup = {
  id: string;
  createdAt: string;
  sizeBytes: number;
  type: "manual" | "auto";
};

type BackupsResp = { items: Backup[] };

export function SettingsBackups() {
  const { getToken } = useAuth();
  const backups = useApi<BackupsResp>("/v1/me/backups");
  const { toast } = useToast();
  const [snapping, setSnapping] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<Backup | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);

  async function snap() {
    if (snapping) return;
    setSnapping(true);
    try {
      await apiCall(getToken, "/v1/me/backups", {
        method: "POST",
        body: "{}",
      });
      await backups.mutate();
      toast.success("Snapshot created");
    } catch (err) {
      const message =
        (err as ClientApiError | undefined)?.message ?? "Please try again.";
      toast.error("Couldn't create snapshot", { description: message });
    } finally {
      setSnapping(false);
    }
  }

  async function confirmRestore() {
    const target = pendingRestore;
    if (!target || restoring) return;
    setRestoring(true);
    try {
      await apiCall(
        getToken,
        `/v1/me/backups/${encodeURIComponent(target.id)}/restore`,
        { method: "POST", body: "{}" },
      );
      await backups.mutate();
      toast.success("Restore queued", {
        description: "Cloud state will swap once the restore job completes.",
      });
      setPendingRestore(null);
    } catch (err) {
      const message =
        (err as ClientApiError | undefined)?.message ?? "Please try again.";
      toast.error("Couldn't restore snapshot", { description: message });
    } finally {
      setRestoring(false);
    }
  }

  async function exportData() {
    if (exporting) return;
    setExporting(true);
    try {
      const token = await getToken();
      const res = await fetch(`${API_BASE}/v1/me/export`, {
        headers: token ? { authorization: `Bearer ${token}` } : undefined,
      });
      if (!res.ok) throw new Error(await res.text().catch(() => res.statusText));
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `sc2tools-export-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success("Export started — check your downloads.");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Please try again.";
      toast.error("Couldn't export data", { description: message });
    } finally {
      setExporting(false);
    }
  }

  async function confirmDelete() {
    if (deleting) return;
    setDeleting(true);
    try {
      await apiCall(getToken, "/v1/me", { method: "DELETE" });
      window.location.href = "/";
    } catch (err) {
      const message =
        (err as ClientApiError | undefined)?.message ?? "Please try again.";
      toast.error("Couldn't delete account", { description: message });
      setDeleting(false);
    }
  }

  if (backups.isLoading) return <Skeleton rows={3} />;
  const items = backups.data?.items ?? [];

  return (
    <div className="space-y-6">
      <Section
        title="Snapshots"
        description="Atlas takes daily continuous backups in the background. These manual snapshots are for 'before I migrate' checkpoints — labelled and restorable from this UI."
        actions={
          <Button
            variant="primary"
            onClick={snap}
            loading={snapping}
            iconLeft={<Camera className="h-4 w-4" aria-hidden />}
          >
            Take a snapshot
          </Button>
        }
      >
        <Card padded={items.length === 0}>
          {items.length === 0 ? (
            <EmptyStatePanel
              icon={<Database className="h-6 w-6" aria-hidden />}
              title="No snapshots yet"
              description="Take a manual snapshot before any risky migration or import."
            />
          ) : (
            <ul className="divide-y divide-border">
              {items.map((b) => (
                <BackupRow
                  key={b.id}
                  backup={b}
                  onRestore={() => setPendingRestore(b)}
                />
              ))}
            </ul>
          )}
        </Card>
      </Section>

      <Section
        title="Export & delete (GDPR)"
        description="Bundle every game, build, opponent record, overlay token, and ML model artifact as JSON in a zip. Account deletion is permanent."
      >
        <Card>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              onClick={exportData}
              loading={exporting}
              iconLeft={<Download className="h-4 w-4" aria-hidden />}
            >
              Export my data
            </Button>
            <Button
              variant="danger"
              onClick={() => setPendingDelete(true)}
              iconLeft={<Trash2 className="h-4 w-4" aria-hidden />}
            >
              Delete my account
            </Button>
          </div>
        </Card>
      </Section>

      <ConfirmDialog
        open={pendingRestore !== null}
        onClose={() => (restoring ? undefined : setPendingRestore(null))}
        onConfirm={confirmRestore}
        title="Restore from snapshot?"
        description={
          pendingRestore
            ? `This overwrites your current cloud state with ${pendingRestore.id}. Recent games not in the snapshot will be lost.`
            : undefined
        }
        confirmLabel="Restore"
        cancelLabel="Cancel"
        intent="danger"
        loading={restoring}
      />
      <ConfirmDialog
        open={pendingDelete}
        onClose={() => (deleting ? undefined : setPendingDelete(false))}
        onConfirm={confirmDelete}
        title="Permanently delete your account?"
        description="This wipes every game, build, and overlay token tied to your cloud user. Cannot be undone."
        confirmLabel="Delete account"
        cancelLabel="Cancel"
        intent="danger"
        loading={deleting}
      />
    </div>
  );
}

function BackupRow({
  backup,
  onRestore,
}: {
  backup: Backup;
  onRestore: () => void;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-mono text-caption text-text">{backup.id}</span>
          <Badge variant={backup.type === "auto" ? "neutral" : "cyan"} size="sm">
            {backup.type}
          </Badge>
        </div>
        <div className="mt-0.5 text-caption text-text-muted">
          {fmtAgo(backup.createdAt)} ·{" "}
          <span className="tabular-nums">
            {(backup.sizeBytes / 1024 / 1024).toFixed(1)} MB
          </span>
        </div>
      </div>
      <Button
        variant="secondary"
        size="sm"
        onClick={onRestore}
        iconLeft={<History className="h-4 w-4" aria-hidden />}
      >
        Restore
      </Button>
    </li>
  );
}
