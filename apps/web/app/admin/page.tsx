"use client";

import { useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall, useApi } from "@/lib/clientApi";

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
 * /admin — moderation dashboard. Server gates by checking the caller's
 * userId against SC2TOOLS_ADMIN_USER_IDS in the API config; non-admins
 * see an empty queue (the API returns 403 and SWR surfaces an error).
 */
export default function AdminPage() {
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

  if (isLoading) return <p className="card p-5 text-text-muted">Loading…</p>;
  if (error) {
    return (
      <p className="card p-5 text-danger">
        {error.status === 403
          ? "Forbidden — your account isn't on the moderator list."
          : `Failed to load reports: ${error.message}`}
      </p>
    );
  }

  const items = data?.items || [];

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold">Moderation queue</h1>
        <p className="text-text-muted">
          Open reports awaiting review. Resolve by either dismissing
          (no action) or removing (unpublishes the target).
        </p>
      </header>

      {items.length === 0 ? (
        <p className="card p-5 text-text-muted">No open reports.</p>
      ) : (
        <ul className="space-y-3">
          {items.map((r) => (
            <li key={r.id} className="card space-y-2 p-5">
              <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                <strong>
                  {r.targetType} · {r.targetId}
                </strong>
                <span className="text-xs text-text-dim">
                  {new Date(r.createdAt).toLocaleString()}
                </span>
              </div>
              <div className="text-sm">
                <span className="font-semibold text-warning">
                  Reason:
                </span>{" "}
                {r.reason}
              </div>
              {r.note && (
                <p className="rounded bg-bg-elevated p-2 text-sm">
                  {r.note}
                </p>
              )}
              <div className="text-xs text-text-dim">
                Reporter: <code className="font-mono">{r.reporterUserId}</code>
              </div>
              <div className="flex gap-2 pt-1">
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
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
