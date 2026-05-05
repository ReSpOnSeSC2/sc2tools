"use client";

import { useState, type DragEvent } from "react";
import { useAuth } from "@clerk/nextjs";
import {
  Play,
  RefreshCw,
  StopCircle,
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
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { fmtAgo } from "@/lib/format";

type ImportStatusValue =
  | "queued"
  | "scanning"
  | "running"
  | "done"
  | "error"
  | "cancelled";

type ImportJob = {
  id: string;
  status: ImportStatusValue;
  startedAt?: string;
  finishedAt?: string;
  totalReplays?: number;
  scanned?: number;
  inserted?: number;
  failed?: number;
  message?: string;
};

type ImportStatus = {
  current?: ImportJob | null;
  history?: ImportJob[];
};

const STATUS_VARIANT: Record<
  ImportStatusValue,
  "neutral" | "accent" | "cyan" | "success" | "warning" | "danger"
> = {
  queued: "neutral",
  scanning: "cyan",
  running: "accent",
  done: "success",
  error: "danger",
  cancelled: "warning",
};

const STATUS_ICON: Record<ImportStatusValue, typeof Clock> = {
  queued: Clock,
  scanning: RefreshCw,
  running: Play,
  done: CheckCircle2,
  error: AlertCircle,
  cancelled: Pause,
};

export function SettingsImportPanel() {
  const { getToken } = useAuth();
  const status = useApi<ImportStatus>("/v1/import/status", {
    refreshInterval: 2000,
  });
  const jobs = useApi<{ items: ImportJob[] }>("/v1/import/jobs");
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  async function call(path: string, action: string) {
    if (busy) return;
    setBusy(true);
    try {
      await apiCall(getToken, path, {
        method: "POST",
        body: "{}",
      });
      await Promise.all([status.mutate(), jobs.mutate()]);
      toast.success(action);
    } catch (err) {
      const message =
        (err as ClientApiError | undefined)?.message ?? "Please try again.";
      toast.error("Import command failed", { description: message });
    } finally {
      setBusy(false);
    }
  }

  if (status.isLoading) return <Skeleton rows={3} />;
  const cur = status.data?.current ?? null;
  const items = jobs.data?.items ?? [];
  const isRunning = cur && (cur.status === "running" || cur.status === "scanning");

  return (
    <div className="space-y-6">
      <Section
        title="Bulk import"
        description="Pull every replay from your local SC2 install into the cloud. Useful on first run, after switching machines, or to refresh the cloud copy from scratch."
      >
        <Card>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              onClick={() => call("/v1/import/start", "Import started")}
              disabled={busy || !!isRunning}
              loading={busy && !isRunning}
              iconLeft={<Play className="h-4 w-4" aria-hidden />}
            >
              Start full import
            </Button>
            <Button
              variant="secondary"
              onClick={() => call("/v1/import/scan", "Scan started")}
              disabled={busy}
              iconLeft={<RefreshCw className="h-4 w-4" aria-hidden />}
            >
              Re-scan only
            </Button>
            {isRunning ? (
              <Button
                variant="danger"
                onClick={() => setConfirmCancel(true)}
                disabled={busy}
                iconLeft={<StopCircle className="h-4 w-4" aria-hidden />}
              >
                Cancel
              </Button>
            ) : null}
          </div>
          <ImportDropZone
            disabled={busy || !!isRunning}
            onActivate={() =>
              call(
                "/v1/import/pick-folder",
                "Folder picker sent to your desktop agent",
              )
            }
          />
          {cur ? <ImportProgress job={cur} /> : <ImportIdleHint />}
        </Card>
      </Section>

      <Section
        title="Recent jobs"
        description="The last few import runs and their outcome."
      >
        <Card padded={items.length === 0}>
          {items.length === 0 ? (
            <EmptyStatePanel
              icon={<Inbox className="h-6 w-6" aria-hidden />}
              title="No previous imports"
              description="Once you start an import the result will show up here."
            />
          ) : (
            <ul className="divide-y divide-border">
              {items.map((j) => (
                <JobRow key={j.id} job={j} />
              ))}
            </ul>
          )}
        </Card>
      </Section>

      <ConfirmDialog
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        onConfirm={async () => {
          setConfirmCancel(false);
          await call("/v1/import/cancel", "Cancel signal sent");
        }}
        title="Cancel running import?"
        description="Already-imported games stay in the cloud. The agent stops scanning and you can resume later."
        confirmLabel="Cancel import"
        cancelLabel="Keep running"
        intent="danger"
      />
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
          Drop replays or click to browse
        </div>
        <p className="text-caption text-text-muted">
          The desktop agent reads files from your machine — drop here to open
          its folder picker on your computer.
        </p>
      </div>
    </button>
  );
}

function ImportProgress({ job }: { job: ImportJob }) {
  const total = job.totalReplays ?? 0;
  const done = job.scanned ?? 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const isDone = job.status === "done";
  const isError = job.status === "error";
  return (
    <div className="mt-4 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-caption">
        <div className="flex items-center gap-2">
          <span className="text-text-muted">Status</span>
          <StatusBadge status={job.status} />
        </div>
        <span className="tabular-nums text-text-muted">
          {done.toLocaleString()} / {total.toLocaleString()} ({pct}%)
        </span>
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="h-2 w-full overflow-hidden rounded-full bg-bg-elevated"
      >
        <div
          className={[
            "h-full rounded-full transition-[width] duration-300",
            isError
              ? "bg-danger"
              : "bg-gradient-to-r from-accent-cyan to-accent shadow-halo-cyan",
          ].join(" ")}
          style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
        />
      </div>
      <div className="flex flex-wrap gap-3 text-caption text-text-dim">
        <span>inserted: {(job.inserted ?? 0).toLocaleString()}</span>
        <span>failed: {(job.failed ?? 0).toLocaleString()}</span>
      </div>
      {job.message ? (
        <p
          className={[
            "text-caption",
            isError ? "text-danger" : "text-text-muted",
          ].join(" ")}
        >
          {job.message}
        </p>
      ) : null}
      {isDone ? (
        <p className="text-caption text-success">
          Imported {(job.inserted ?? 0).toLocaleString()} replays. Live sync
          will keep things current from here.
        </p>
      ) : null}
    </div>
  );
}

function JobRow({ job }: { job: ImportJob }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-caption">
      <div className="flex min-w-0 items-center gap-2">
        <StatusBadge status={job.status} />
        <span className="truncate font-mono text-[11px] text-text-muted">
          {job.id}
        </span>
      </div>
      <span className="text-text-dim">
        {job.finishedAt
          ? `finished ${fmtAgo(job.finishedAt)}`
          : job.startedAt
            ? `started ${fmtAgo(job.startedAt)}`
            : "—"}
      </span>
    </li>
  );
}

function StatusBadge({ status }: { status: ImportStatusValue }) {
  const Icon = STATUS_ICON[status];
  return (
    <Badge
      variant={STATUS_VARIANT[status]}
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
