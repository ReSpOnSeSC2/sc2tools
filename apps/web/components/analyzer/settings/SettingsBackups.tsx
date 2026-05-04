"use client";

import { useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall, useApi, API_BASE } from "@/lib/clientApi";
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";
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
  const [busy, setBusy] = useState(false);

  async function snap() {
    if (busy) return;
    setBusy(true);
    try {
      await apiCall(getToken, "/v1/me/backups", {
        method: "POST",
        body: "{}",
      });
      await backups.mutate();
    } finally {
      setBusy(false);
    }
  }

  async function restore(id: string) {
    if (busy) return;
    if (!confirm(`Restore from backup ${id}? This overwrites cloud state.`)) return;
    setBusy(true);
    try {
      await apiCall(
        getToken,
        `/v1/me/backups/${encodeURIComponent(id)}/restore`,
        { method: "POST", body: "{}" },
      );
      await backups.mutate();
    } finally {
      setBusy(false);
    }
  }

  async function exportData() {
    const token = await getToken();
    const res = await fetch(`${API_BASE}/v1/me/export`, {
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
    });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sc2tools-export-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function deleteAccount() {
    if (
      !confirm(
        "Permanently delete your SC2 Tools account? This wipes every game, build, and overlay token. Cannot be undone.",
      )
    )
      return;
    await apiCall(getToken, "/v1/me", { method: "DELETE" });
    location.href = "/";
  }

  if (backups.isLoading) return <Skeleton rows={3} />;
  const items = backups.data?.items || [];

  return (
    <div className="space-y-4">
      <Card title="Snapshots">
        <p className="mb-3 text-xs text-text-muted">
          Atlas takes daily continuous backups. These manual snapshots are
          for &ldquo;before I migrate&rdquo; checkpoints — labelled and
          restorable from this UI.
        </p>
        <button
          type="button"
          className="btn"
          onClick={snap}
          disabled={busy}
        >
          {busy ? "Snapshotting…" : "Take a snapshot now"}
        </button>
        {items.length === 0 ? (
          <div className="mt-3">
            <EmptyState title="No snapshots yet" />
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-border text-sm">
            {items.map((b) => (
              <li
                key={b.id}
                className="flex items-center justify-between gap-3 py-2"
              >
                <span>
                  <span className="font-mono text-xs">{b.id}</span>
                  <span className="ml-2 text-text-dim">
                    {fmtAgo(b.createdAt)} ·{" "}
                    {(b.sizeBytes / 1024 / 1024).toFixed(1)} MB
                  </span>
                </span>
                <button
                  type="button"
                  className="btn btn-secondary text-xs"
                  onClick={() => restore(b.id)}
                  disabled={busy}
                >
                  Restore
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Export / delete (GDPR)">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={exportData}
          >
            Export my data
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={deleteAccount}
          >
            Delete my account
          </button>
        </div>
        <p className="mt-2 text-xs text-text-muted">
          Export bundles every game, build, opponent record, overlay token,
          and ML model artifact as JSON in a zip. Account deletion is
          permanent.
        </p>
      </Card>
    </div>
  );
}
