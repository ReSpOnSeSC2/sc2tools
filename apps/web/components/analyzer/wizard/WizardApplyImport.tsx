"use client";

import { useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall, useApi } from "@/lib/clientApi";
import { Card, Skeleton } from "@/components/ui/Card";
import { fmtAgo } from "@/lib/format";

type Status = {
  current?: {
    id: string;
    status: string;
    scanned?: number;
    totalReplays?: number;
    inserted?: number;
  } | null;
};

export function WizardApplyImport() {
  const { getToken } = useAuth();
  const status = useApi<Status>("/v1/import/status", {
    refreshInterval: 2000,
  });
  const [busy, setBusy] = useState(false);

  async function start() {
    if (busy) return;
    setBusy(true);
    try {
      await apiCall(getToken, "/v1/import/start", {
        method: "POST",
        body: JSON.stringify({ source: "wizard" }),
      });
      await status.mutate();
    } finally {
      setBusy(false);
    }
  }

  if (status.isLoading) return <Skeleton rows={3} />;
  const cur = status.data?.current;
  const running = cur && (cur.status === "running" || cur.status === "scanning");
  const total = cur?.totalReplays || 0;
  const done = cur?.scanned || 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <Card title="Import your replay history">
      <p className="mb-3 text-sm text-text-muted">
        The agent is sitting on years of historic replays. Pull them all
        into the cloud now — happens once, then live syncing takes over.
      </p>

      <button
        type="button"
        className="btn"
        onClick={start}
        disabled={busy || !!running}
      >
        {running ? "Import running…" : "Start import"}
      </button>

      {running && (
        <div className="mt-3 space-y-1.5">
          <div className="flex justify-between text-xs">
            <span>{cur.status}</span>
            <span className="tabular-nums">
              {done} / {total} ({pct}%)
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded bg-bg-elevated">
            <div
              className="h-full bg-accent"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}

      {cur && cur.status === "done" && (
        <p className="mt-3 text-sm text-success">
          ✓ Imported {cur.inserted || 0} replays. You&rsquo;re good to go.
        </p>
      )}
    </Card>
  );
}
