"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall, useApi } from "@/lib/clientApi";
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";

type Folder = {
  path: string;
  enabled: boolean;
  isCore?: boolean;
  lastScannedAt?: string | null;
};

type FoldersResp = {
  items: Folder[];
};

export function SettingsFolders() {
  const { getToken } = useAuth();
  const { data, isLoading, mutate } = useApi<FoldersResp>(
    "/v1/import/cores",
  );
  const [saving, setSaving] = useState(false);
  const [picking, setPicking] = useState(false);

  async function toggle(path: string, enabled: boolean) {
    if (saving) return;
    setSaving(true);
    try {
      await apiCall(getToken, "/v1/import/cores", {
        method: "PATCH",
        body: JSON.stringify({ path, enabled }),
      });
      await mutate();
    } finally {
      setSaving(false);
    }
  }

  async function pickFolder() {
    if (picking) return;
    setPicking(true);
    try {
      await apiCall(getToken, "/v1/import/pick-folder", {
        method: "POST",
        body: "{}",
      });
      await mutate();
    } finally {
      setPicking(false);
    }
  }

  if (isLoading) return <Skeleton rows={3} />;
  const items = data?.items || [];

  return (
    <Card
      title="Replay folders"
      right={
        <button
          type="button"
          className="btn btn-secondary text-xs"
          onClick={pickFolder}
          disabled={picking}
        >
          {picking ? "Asking agent…" : "Add folder…"}
        </button>
      }
    >
      <p className="mb-3 text-xs text-text-muted">
        These are the folders the local agent scans for replays. The agent
        watches in real time — disabling a folder pauses it without
        deleting the games already imported.
      </p>
      {items.length === 0 ? (
        <EmptyState title="No folders configured" />
      ) : (
        <ul className="divide-y divide-border">
          {items.map((f) => (
            <li
              key={f.path}
              className="flex items-center justify-between gap-3 py-2 text-sm"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-xs">{f.path}</div>
                {f.lastScannedAt && (
                  <div className="text-[11px] text-text-dim">
                    last scanned {new Date(f.lastScannedAt).toLocaleString()}
                  </div>
                )}
              </div>
              {f.isCore && (
                <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] uppercase text-accent">
                  Core
                </span>
              )}
              <label className="flex items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  checked={f.enabled}
                  onChange={(e) => toggle(f.path, e.target.checked)}
                />
                Enabled
              </label>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
