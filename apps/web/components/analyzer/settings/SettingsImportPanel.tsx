"use client";

import { useEffect, useState, type DragEvent } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import {
  Play,
  RefreshCw,
  Inbox,
  CheckCircle2,
  AlertCircle,
  Clock,
  Pause,
  UploadCloud,
} from "lucide-react";
import { apiCall, useApi, type ClientApiError } from "@/lib/clientApi";
import { Card, Skeleton } from "@/components/ui/Card";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { Section } from "@/components/ui/Section";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { useToast } from "@/components/ui/Toast";
import { fmtAgo } from "@/lib/format";
import { ImportProgressCard } from "@/components/imports/ImportProgressCard";
import {
  importJobBlocksStart,
  ERROR_CODE_COPY,
  useImportStatus,
  type ImportJob,
} from "@/components/imports/useImportStatus";
import { SettingsLoadError } from "./SettingsLoadError";
import { setupAgentOnline, type SetupMe } from "./setupHealth";
import { SettingsSectionsReady } from "./SettingsSectionNav";

// NOTE: this panel previously parsed a `{current: {...}}` envelope and
// `id`/`totalReplays`/`scanned` fields that the API never returned —
// so it permanently rendered "Idle", and its "Start full import"
// posted `{}` to a route that then required `folder` and 400'd. It now
// reads the real serialised-job shape via the shared useImportStatus
// hook (same source as the dashboard card), and folder-less start is
// supported server-side ("import from the folders the agent watches").

const STATUS_VARIANT: Record<
  string,
  "neutral" | "accent" | "cyan" | "success" | "warning" | "danger"
> = {
  pending: "neutral",
  scanning: "cyan",
  running: "accent",
  stalled: "warning",
  done: "success",
  error: "danger",
  cancelled: "warning",
};

const STATUS_ICON: Record<string, typeof Clock> = {
  pending: Clock,
  scanning: RefreshCw,
  running: Play,
  stalled: Pause,
  done: CheckCircle2,
  error: AlertCircle,
  cancelled: Pause,
};

export function SettingsImportPanel() {
  const { getToken } = useAuth();
  const importStatus = useImportStatus();
  const me = useApi<SetupMe>("/v1/me", { refreshInterval: 30_000 });
  const jobs = useApi<{ ok: boolean; items: ImportJob[] }>("/v1/import/jobs");
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, []);

  async function call(path: string, action: string) {
    if (busy) return;
    setBusy(true);
    try {
      await apiCall(getToken, path, {
        method: "POST",
        body: "{}",
      });
      importStatus.refresh();
      await jobs.mutate();
      toast.success(action);
    } catch (err) {
      const message =
        (err as ClientApiError | undefined)?.message ?? "Please try again.";
      toast.error("Import command failed", { description: message });
    } finally {
      setBusy(false);
    }
  }

  if (me.error && !me.data) return <><SettingsSectionsReady revision="error" /><SettingsLoadError tab="Desktop app connection" error={me.error} retry={me.mutate} /></>;
  if (importStatus.error && !importStatus.job) return <><SettingsSectionsReady revision="error" /><SettingsLoadError tab="Desktop import status" error={importStatus.error} retry={importStatus.refresh} /></>;
  if (importStatus.isLoading || !me.data) return <><SettingsSectionsReady revision="loading" /><Skeleton rows={3} /></>;
  const job = importStatus.job;
  const isRunning = importStatus.active;
  const importBlocked = importJobBlocksStart(job?.status);
  const items = (jobs.data?.items ?? []).slice(0, 10);
  const paired = Boolean(me.data.agentPaired);
  const online = setupAgentOnline(me.data, Math.max(now, Date.now()));
  const unavailable = !paired || !online || Boolean(me.error);

  return (
    <div className="space-y-6">
      <SettingsSectionsReady />
      <Section
        id="desktop-import" className="scroll-mt-28"
        title="Desktop agent import"
        description="Pull every replay from your local SC2 install into the cloud. Useful on first run, after switching machines, or to refresh the cloud copy from scratch."
      >
        <Card>
          {!paired ? <p className="mb-3 text-caption">Pair the desktop app to import your replay history. <Link href="/devices" className="text-accent underline">Pair a PC</Link></p> : !online ? <p role="status" className="mb-3 text-caption text-warning">SC2 Tools on your PC is offline. Open it to start an import.</p> : null}
          {me.error ? <SettingsLoadError tab="Desktop app connection" error={me.error} retry={me.mutate} /> : null}
          {importStatus.error ? <SettingsLoadError tab="Desktop import status" error={importStatus.error} retry={importStatus.refresh} /> : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              onClick={() => call("/v1/import/start", "Import started")}
              disabled={busy || importBlocked || unavailable}
              loading={busy && !isRunning}
              iconLeft={<Play className="h-4 w-4" aria-hidden />}
            >
              Start full import
            </Button>
            <Button
              variant="secondary"
              onClick={() => call("/v1/import/scan", "Scan started")}
              disabled={busy || unavailable}
              iconLeft={<RefreshCw className="h-4 w-4" aria-hidden />}
            >
              Re-scan only
            </Button>
          </div>
          <ImportDropZone
            disabled={busy || importBlocked || unavailable}
            onActivate={() =>
              call(
                "/v1/import/pick-folder",
                "Folder request sent to your desktop agent",
              )
            }
          />
          {job ? (
            <div className="mt-4">
              <ImportProgressCard
                job={job}
                active={isRunning}
                pct={importStatus.pct}
                etaSeconds={importStatus.etaSeconds}
                onCancelled={() => {
                  importStatus.refresh();
                  void jobs.mutate();
                }}
              />
            </div>
          ) : (
            <ImportIdleHint />
          )}
        </Card>
      </Section>

      <Section
        id="import-jobs" className="scroll-mt-28"
        title="Recent jobs"
        description="Your last 10 import runs and their outcome."
      >
        <Card padded={items.length === 0}>
          {jobs.error ? <SettingsLoadError tab="Import history" error={jobs.error} retry={jobs.mutate} /> : null}
          {!jobs.data && jobs.error ? null : !jobs.data ? <Skeleton rows={3} /> : items.length === 0 ? (
            <EmptyStatePanel
              icon={<Inbox className="h-6 w-6" aria-hidden />}
              title="No previous imports"
              description="Once you start an import the result will show up here."
            />
          ) : (
            <ul className="divide-y divide-border">
              {items.map((j) => (
                <JobRow key={j.jobId} job={j} />
              ))}
            </ul>
          )}
        </Card>
      </Section>
    </div>
  );
}

function ImportIdleHint() {
  return (
    <p className="mt-4 text-caption text-text-muted">
      Idle. Live replay watching is always on — start a bulk import only when
      you need to backfill historical games.
    </p>
  );
}

function ImportDropZone({
  disabled,
  onActivate,
}: {
  disabled: boolean;
  onActivate: () => void;
}) {
  const [hover, setHover] = useState(false);

  const onDragOver = (e: DragEvent<HTMLButtonElement>) => {
    e.preventDefault();
    if (disabled) return;
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    setHover(true);
  };
  const onDragLeave = () => setHover(false);
  const onDrop = (e: DragEvent<HTMLButtonElement>) => {
    e.preventDefault();
    setHover(false);
    if (disabled) return;
    onActivate();
  };

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onActivate}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      aria-label="Browse for replay folder via desktop agent"
      className={[
        "relative mt-4 flex w-full flex-col items-center gap-2 rounded-xl border-2 border-dashed px-4 py-6 text-center transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
        disabled
          ? "cursor-not-allowed border-border bg-bg-elevated/40 opacity-60"
          : hover
            ? "border-accent-cyan bg-accent-cyan/10 shadow-halo-cyan"
            : "border-border bg-bg-elevated/60 hover:border-accent-cyan/60 hover:bg-accent-cyan/5",
      ].join(" ")}
    >
      <UploadCloud
        className={[
          "h-6 w-6 transition-colors",
          hover ? "text-accent-cyan" : "text-text-muted",
        ].join(" ")}
        aria-hidden
      />
      <div className="space-y-0.5">
        <div className="text-body font-medium text-text">
          Choose a replay folder
        </div>
        <p className="text-caption text-text-muted">
          Opens a folder picker in SC2 Tools on your gaming PC.
        </p>
      </div>
    </button>
  );
}

function JobRow({ job }: { job: ImportJob }) {
  const seconds = job.finishedAt && job.startedAt ? Math.round((Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 1000) : NaN;
  const duration = Number.isFinite(seconds) && seconds >= 0 ? seconds >= 60 ? `${Math.round(seconds / 60)} min` : `${seconds} sec` : null;
  const reasons = Object.entries(job.errorBreakdown || {}).filter(([, count]) => count > 0);
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-caption">
      <div className="flex min-w-0 items-center gap-2">
        <StatusBadge status={String(job.status)} />
        <span className="tabular-nums text-text-muted">
          {(job.completed || 0).toLocaleString()}/
          {(job.total || 0).toLocaleString()}
          {job.errors ? (
            <span className="text-danger"> · {job.errors} failed</span>
          ) : null}
        </span>
        {job.kind ? (
          <span className="text-micro uppercase tracking-wider text-text-dim">
            {job.kind}
          </span>
        ) : null}
      </div>
      <span className="text-text-dim">
        {job.startedAt ? `started ${fmtAgo(job.startedAt)}` : "Start time not reported"}{duration ? ` · took ${duration}` : ""}
      </span>
      {reasons.length ? <details className="basis-full"><summary className="cursor-pointer text-text-muted">Files that couldn&apos;t be imported</summary><ul className="mt-2 space-y-1">{reasons.map(([code, count]) => <li key={code}><span className="font-medium">{count.toLocaleString()}</span> · {ERROR_CODE_COPY[code] || code.replaceAll("_", " ")}</li>)}</ul></details> : null}
    </li>
  );
}

function StatusBadge({ status }: { status: string }) {
  const Icon = STATUS_ICON[status] || Clock;
  return (
    <Badge
      variant={STATUS_VARIANT[status] || "neutral"}
      size="sm"
      iconLeft={
        <Icon
          className={[
            "h-3 w-3",
            status === "scanning" ? "animate-spin" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          aria-hidden
        />
      }
    >
      {status}
    </Badge>
  );
}
