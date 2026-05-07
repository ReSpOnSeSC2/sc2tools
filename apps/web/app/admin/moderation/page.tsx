"use client";

import { useState } from "react";
import { useAuth } from "@clerk/nextjs";

import { apiCall, useApi } from "@/lib/clientApi";
import { Card } from "@/components/ui/Card";
import { ForbiddenCard } from "../components/AdminFragments";

type Report = {
  id: string;
  reporterUserId: string;
  targetType: "build" | "opponent";
  targetId: string;
  reason: string;
  note?: string;
  createdAt: string;
};

type ReportsResp = { items: Report[] };

/**
 * /admin/moderation — community moderation queue.
 *
 * Same handler set the original ``/admin`` page used (POST
 * ``/v1/community/admin/reports/:id`` with ``{action: 'dismiss' |
 * 'remove'}``). Lifted into the new admin shell so the moderation
 * queue lives next to dashboard, users, tools, and health under a
 * single nav.
 */
export default function AdminModerationPage() {
  const { getToken } = useAuth();
  const { data, error, isLoading, mutate } = useApi<ReportsResp>(
    "/v1/community/admin/reports",
  );
  const [busy, setBusy] = useState(false);

  async function resolve(id: string, action: "dismiss" | "remove") {
    if (busy) return;
    setBusy(true);
    try {
      await apiCall(getToken, `/v1/community/admin/reports/${id}`, {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      await mutate();
    } finally {
      setBusy(false);
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold">Moderation</h1>
        </header>
        <div className="h-32 animate-pulse rounded-xl bg-bg-elevated" />
      </div>
    );
  }
  if (error) {
    if (error.status === 403) return <ForbiddenCard />;
    return (
      <Card padded>
        <p className="text-danger">
          Failed to load reports: {error.message}
        </p>
      </Card>
    );
  }

  const items = data?.items || [];

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold">Moderation queue</h1>
        <p className="text-text-muted">
          Open community reports awaiting review. Resolve by either
          dismissing (no action) or removing (unpublishes the
          target).
        </p>
      </header>

      {items.length === 0 ? (
        <Card padded>
          <p className="text-text-muted">No open reports.</p>
        </Card>
      ) : (
        <ul className="space-y-3">
          {items.map((r) => (
            <li key={r.id}>
              <Card padded>
                <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                  <strong className="break-all">
                    {r.targetType} · {r.targetId}
                  </strong>
                  <span className="text-caption text-text-dim">
                    {new Date(r.createdAt).toLocaleString()}
                  </span>
                </div>
                <div className="mt-2 text-sm">
                  <span className="font-semibold text-warning">Reason:</span>{" "}
                  {r.reason}
                </div>
                {r.note ? (
                  <p className="mt-2 rounded-lg border border-border bg-bg-elevated/40 p-2 text-sm">
                    {r.note}
                  </p>
                ) : null}
                <div className="mt-3 text-caption text-text-dim">
                  Reporter:{" "}
                  <code className="font-mono break-all">
                    {r.reporterUserId}
                  </code>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="btn btn-secondary text-sm"
                    onClick={() => resolve(r.id, "dismiss")}
                    disabled={busy}
                  >
                    Dismiss
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger text-sm"
                    onClick={() => resolve(r.id, "remove")}
                    disabled={busy}
                  >
                    Remove target
                  </button>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
