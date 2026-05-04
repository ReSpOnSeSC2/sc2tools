"use client";

import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall, useApi } from "@/lib/clientApi";
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";

type CustomBuild = {
  name: string;
  notes?: string;
  synonyms?: string[];
  updatedAt?: string;
};

type CustomBuildsResp = { items: CustomBuild[] };

export function SettingsBuilds() {
  const { getToken } = useAuth();
  const { data, isLoading, mutate } = useApi<CustomBuildsResp>(
    "/v1/custom-builds",
  );

  const [draftName, setDraftName] = useState("");
  const [draftSyn, setDraftSyn] = useState("");
  const [busy, setBusy] = useState(false);

  async function add() {
    if (busy || !draftName.trim()) return;
    setBusy(true);
    try {
      await apiCall(getToken, "/v1/custom-builds", {
        method: "POST",
        body: JSON.stringify({
          name: draftName.trim(),
          synonyms: draftSyn
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        }),
      });
      setDraftName("");
      setDraftSyn("");
      await mutate();
    } finally {
      setBusy(false);
    }
  }

  async function remove(name: string) {
    if (busy) return;
    setBusy(true);
    try {
      await apiCall(getToken, `/v1/custom-builds/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      await mutate();
    } finally {
      setBusy(false);
    }
  }

  if (isLoading) return <Skeleton rows={3} />;
  const items = data?.items || [];

  return (
    <div className="space-y-4">
      <Card title="Add a custom build">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_2fr_auto]">
          <input
            className="input"
            placeholder="Name"
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
          />
          <input
            className="input"
            placeholder="Synonyms (comma-separated)"
            value={draftSyn}
            onChange={(e) => setDraftSyn(e.target.value)}
          />
          <button type="button" className="btn" onClick={add} disabled={busy}>
            Add
          </button>
        </div>
      </Card>

      <Card title="Your custom builds">
        {items.length === 0 ? (
          <EmptyState title="No custom builds yet" />
        ) : (
          <ul className="divide-y divide-border text-sm">
            {items.map((b) => (
              <li
                key={b.name}
                className="flex items-center justify-between gap-3 py-2"
              >
                <span>
                  <strong>{b.name}</strong>
                  {b.synonyms && b.synonyms.length > 0 && (
                    <span className="ml-2 text-xs text-text-dim">
                      aka {b.synonyms.join(", ")}
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  className="btn btn-secondary text-xs"
                  onClick={() => remove(b.name)}
                  disabled={busy}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
