"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall, useApi } from "@/lib/clientApi";
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";
import { fmtAgo } from "@/lib/format";

type ImportJob = {
  id: string;
  status: "queued" | "scanning" | "running" | "done" | "error" | "cancelled";
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

/**
 * Bulk-import panel — orchestrates the local agent via
 * /v1/import/{scan,start,cancel,status,jobs}.
 */
export function SettingsImportPanel() {
  const { getToken } = useAuth();
  const status = useApi<ImportStatus>("/v1/import/status", {
    refreshInterval: 2000,
  });
  const jobs = useApi<{ items: ImportJob[] }>("/v1/import/jobs");
  const [busy, setBusy] = useState(false);

  async function call(path: string, body: unknown = {}) {
    if (busy) return;
    setBusy(true);
    try {
      await apiCall(getToken, path, {
        method: "POST",
        body: JSON.stringify(body),
      });
      await status.mutate();
      await jobs.mutate();
    } finally {
      setBusy(false);
    }
  }

  if (status.isLoading) return <Skeleton rows={3} />;
  const cur = status.data?.current;
  const items = jobs.data?.items || [];

  return (
    <div className="space-y-4">
      <Card title="Bulk import">
        <p className="mb-3 text-xs text-text-muted">
          Pull every replay from your local SC2 install. Useful for first
          run, after switching machines, or if you want to refresh the cloud
          copy from scratch.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn"
            disabled={busy || (cur && cur.status === "running") || false}
            onClick={() => call("/v1/import/start")}
          >
            Start full import
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={() => call("/v1/import/scan")}
          >
            Re-scan only
          </button>
          {cur && cur.status === "running" && (
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              onClick={() => call("/v1/import/cancel")}
            >
              Cancel
            </button>
          )}
        </div>
        {cur && (
          <ImportProgress job={cur} />
        )}
      </Card>

      <Card title="Recent jobs">
        {items.length === 0 ? (
          <EmptyState title="No previous imports" />
        ) : (
          <ul className="divide-y divide-border text-sm">
            {items.map((j) => (
              <li
                key={j.id}
                className="flex items-center justify-between gap-3 py-2"
              >
                <span>
                  <span className="font-mono text-xs">{j.id}</span>
                  <span
                    className={`ml-2 rounded px-1.5 py-0.5 text-[10px] ${statusClass(j.status)}`}
                  >
                    {j.status}
                  </span>
                </span>
                <span className="text-xs text-text-dim">
                  {j.finishedAt
                    ? `finished ${fmtAgo(j.finishedAt)}`
                    : j.startedAt
                      ? `started ${fmtAgo(j.startedAt)}`
                      : "—"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function ImportProgress({ job }: { job: ImportJob }) {
  const total = job.totalReplays || 0;
  const done = job.scanned || 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div className="mt-4 space-y-1.5">
      <div className="flex justify-between text-xs">
        <span>
          Status: <strong>{job.status}</strong>
        </span>
        <span className="tabular-nums">
          {done} / {total} ({pct}%)
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded bg-bg-elevated">
        <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
      <div className="flex gap-3 text-[11px] text-text-dim">
        <span>inserted: {job.inserted || 0}</span>
        <span>failed: {job.failed || 0}</span>
      </div>
      {job.message && (
        <div className="text-[11px] text-text-muted">{job.message}</div>
      )}
    </div>
  );
}

function statusClass(s: string): string {
  if (s === "running" || s === "scanning")
    return "bg-accent/15 text-accent ring-1 ring-accent/30";
  if (s === "done") return "bg-success/15 text-success ring-1 ring-success/30";
  if (s === "error") return "bg-danger/15 text-danger ring-1 ring-danger/30";
  if (s === "cancelled")
    return "bg-warning/15 text-warning ring-1 ring-warning/30";
  return "bg-bg-elevated text-text-dim";
}
