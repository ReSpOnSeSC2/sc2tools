"use client";

import { useEffect, useRef, useState } from "react";
import { useSWRConfig } from "swr";
import { localDayStartIso, localNextDayStartIso } from "@/lib/localDateRange";
import { SettingsLoadError } from "./SettingsLoadError";
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
import { DestructiveConfirmDialog } from "@/components/ui/DestructiveConfirmDialog";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { fmtAgo } from "@/lib/format";
import { ReplayArchiveStatusCard } from "./ReplayArchiveStatusCard";

type Backup = {
  id: string;
  createdAt: string;
  sizeBytes: number;
  type: "manual" | "auto";
};

type BackupsResp = { items: Backup[] };

export function SettingsBackups() {
  const { getToken } = useAuth();
  const tokenRef = useRef(getToken);
  tokenRef.current = getToken;
  const backups = useApi<BackupsResp>("/v1/me/backups");
  const { toast } = useToast();
  const { mutate: refresh } = useSWRConfig();
  const [snapping, setSnapping] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<Backup | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [wipeSince, setWipeSince] = useState("");
  const [wipeUntil, setWipeUntil] = useState("");
  const [pendingWipe, setPendingWipe] = useState(false);
  const [wiping, setWiping] = useState(false);
  const [count, setCount] = useState<number | null>(null);
  const [counting, setCounting] = useState(false);
  const [countFailed, setCountFailed] = useState(false);
  const invalidRange = Boolean(wipeSince && wipeUntil && wipeSince > wipeUntil);
  const range = {
    ...(wipeSince ? { since: localDayStartIso(wipeSince) } : {}),
    ...(wipeUntil ? { until: localNextDayStartIso(wipeUntil) } : {}),
  };
  const rangeKey = JSON.stringify(range);
  useEffect(() => {
    if (!pendingWipe) return;
    let cancelled = false;
    setCounting(true); setCount(null); setCountFailed(false);
    void apiCall<{ counts: { games: number } }>(tokenRef.current, "/v1/me/games/wipe", {
      method: "POST", body: JSON.stringify({ ...JSON.parse(rangeKey), dryRun: true }),
    }).then((answer) => { if (!cancelled) setCount(answer.counts.games); })
      .catch(() => { if (!cancelled) setCountFailed(true); })
      .finally(() => { if (!cancelled) setCounting(false); });
    return () => { cancelled = true; };
  }, [pendingWipe, rangeKey]);

  async function refreshHistory() {
    try { await refresh((key) => {
      const path = Array.isArray(key) ? key.find((part) => typeof part === "string" && part.startsWith("/v1/")) : key;
      return typeof path === "string" && /^\/v1\/(?:me(?:\?|$|\/doctor)|games|opponents|timeseries|streak|matchups|builds|macro|maps|trends|strategies|dashboard)/.test(path);
    }); } catch { /* A refresh failure must not turn a completed wipe or restore into a reported failure. */ }
  }

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
      const result = await apiCall<{ counts?: { games?: number } }>(
        getToken,
        `/v1/me/backups/${encodeURIComponent(target.id)}/restore`,
        { method: "POST", body: "{}" },
      );
      await Promise.allSettled([backups.mutate(), refreshHistory()]);
      toast.success(`Restored ${(result.counts?.games ?? 0).toLocaleString()} games`, {
        description:
          "Click Re-sync in the desktop app to bring back build orders, charts and replay files.",
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

  async function confirmWipeGames() {
    if (wiping || counting || count === 0 || invalidRange) return;
    setWiping(true);
    try {
      const body = range;
      const res = await apiCall<{
        deleted: boolean;
        counts: {
          games: number;
          opponents: number;
          macroJobs: number;
        };
      }>(
        getToken,
        "/v1/me/games/wipe",
        { method: "POST", body: JSON.stringify(body) },
      );
      const c = res.counts;
      await refreshHistory();
      toast.success(
        `Deleted ${c.games} game${c.games === 1 ? "" : "s"}`,
        {
          description:
            "Open your SC2 Tools agent and click Resync to upload fresh records.",
        },
      );
      setPendingWipe(false);
      setWipeSince("");
      setWipeUntil("");
    } catch (err) {
      const message =
        (err as ClientApiError | undefined)?.message ?? "Please try again.";
      toast.error("Couldn't wipe game history", { description: message });
    } finally {
      setWiping(false);
    }
  }

  if (backups.isLoading) {
    return (
      <div className="space-y-6">
        <ReplayArchiveStatusCard />
        <Skeleton rows={3} />
      </div>
    );
  }
  const items = backups.data?.items ?? [];

  return (
    <div className="space-y-6">
      <ReplayArchiveStatusCard />

      <Section
        title="Snapshots"
        description="Your own restore points for your account. Take one before a big import or a history wipe, and restore it here if something goes wrong."
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
          {backups.error && backups.data === undefined ? <SettingsLoadError tab="snapshots" error={backups.error} retry={backups.mutate} /> : items.length === 0 ? (
            <EmptyStatePanel
              icon={<Database className="h-6 w-6" aria-hidden />}
              title="No snapshots yet"
              description="Take one before a big import or a history wipe."
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
        <div className="mt-3 space-y-2 text-caption text-text-muted">
          <p>
            A snapshot holds your games list, opponents, notes, custom builds
            and settings. Build orders, charts and original replay files
            aren&apos;t in it: after a restore, click Re-sync in the
            desktop app to upload them again.
          </p>
          <p>
            Separately, the whole SC2 Tools database is backed up every day
            with MongoDB Atlas, so the site can be recovered after a server
            failure. Those backups cover everyone at once, so they
            can&apos;t bring back just your account; a snapshot here can.{" "}
            <LazyHelpLink slug="backups-and-export">How backups work</LazyHelpLink>
          </p>
        </div>
      </Section>

      <Section
        title="Delete game history"
        description="Wipes your replays, opponent records, and macro jobs. Your Build library, device pairings, overlay tokens, and your account stay intact. Use this before a fresh agent re-sync."
      >
        <Card>
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-caption text-text-muted">
                <span>From</span>
                <Input
                  type="date"
                  value={wipeSince}
                  onChange={(e) => setWipeSince(e.target.value)}
                  aria-label="Wipe games on or after this date"
                />
              </label>
              <label className="space-y-1 text-caption text-text-muted">
                <span>Through (inclusive)</span>
                <Input
                  type="date"
                  value={wipeUntil}
                  onChange={(e) => setWipeUntil(e.target.value)}
                  aria-label="Wipe games through this date (inclusive)"
                />
              </label>
            </div>
            <p className="text-caption text-text-muted">
              Dates use your local time. Leave both empty to wipe every game.
            </p>
            {invalidRange ? <p role="alert" className="text-caption text-danger">From must be on or before Through.</p> : null}
            <div>
              <Button
                variant="danger"
                disabled={invalidRange}
                onClick={() => { setCount(null); setCounting(true); setCountFailed(false); setPendingWipe(true); }}
                iconLeft={<Trash2 className="h-4 w-4" aria-hidden />}
              >
                {wipeSince || wipeUntil
                  ? "Delete games in range"
                  : "Delete all games"}
              </Button>
            </div>
          </div>
        </Card>
      </Section>

      <Section
        title="Export & delete account (GDPR)"
        description="Download everything stored for your account as one JSON file: your games list, opponents, notes, custom builds, settings and overlay tokens. Build orders and charts aren't in the file; original replays download from your replay history. Deleting your account is permanent."
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
            ? `This replaces your games list, opponents, notes, custom builds and settings with the snapshot from ${new Date(pendingRestore.createdAt).toLocaleString()}. Games added since then are removed, and build orders, charts and replay files are cleared until you click Re-sync in the desktop app.`
            : undefined
        }
        confirmLabel="Restore"
        cancelLabel="Cancel"
        intent="danger"
        loading={restoring}
      />
      <DestructiveConfirmDialog
        open={pendingDelete}
        onClose={() => (deleting ? undefined : setPendingDelete(false))}
        onConfirm={confirmDelete}
        title="Permanently delete your account?"
        description="This wipes every game, build, and overlay token tied to your cloud user. Cannot be undone."
        confirmWord="DELETE"
        confirmLabel="Delete account"
        loading={deleting}
      />
      <DestructiveConfirmDialog
        open={pendingWipe}
        onClose={() => (wiping ? undefined : setPendingWipe(false))}
        onConfirm={confirmWipeGames}
        title="Delete game history?"
        description={
          counting ? "Counting games…" : count === 0 ? "No games in this range" :
          `${countFailed ? "Couldn't count the games in this range. " : ""}This deletes ${!wipeSince && !wipeUntil ? "all " : ""}${count === null ? "the matching" : count.toLocaleString()} games${wipeSince || wipeUntil ? ` ${wipeSince ? `from ${new Date(localDayStartIso(wipeSince)).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}${wipeUntil ? ` through ${new Date(localDayStartIso(wipeUntil)).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""} (your time)` : ""}. Opponent records and macro data for those games go too. Your Build library, devices and overlay tokens are kept.`
        }
        confirmDisabled={counting || count === 0 || invalidRange}
        confirmWord="DELETE"
        confirmLabel="Delete games"
        loading={wiping}
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
