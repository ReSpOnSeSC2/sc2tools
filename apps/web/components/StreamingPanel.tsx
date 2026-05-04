"use client";

import { useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { useApi, apiCall } from "@/lib/clientApi";

type Token = {
  token: string;
  label: string;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
};

type ListResponse = { items: Token[] };

const overlayBase =
  typeof window !== "undefined" ? window.location.origin : "";

export function StreamingPanel() {
  const { getToken } = useAuth();
  const { data, error, isLoading, mutate } = useApi<ListResponse>(
    "/v1/overlay-tokens",
  );
  const [label, setLabel] = useState("Default");
  const [busy, setBusy] = useState(false);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await apiCall(getToken, "/v1/overlay-tokens", {
        method: "POST",
        body: JSON.stringify({ label }),
      });
      setLabel("Default");
      await mutate();
    } finally {
      setBusy(false);
    }
  }

  async function onRevoke(token: string) {
    setBusy(true);
    try {
      await apiCall(getToken, `/v1/overlay-tokens/${encodeURIComponent(token)}`, {
        method: "DELETE",
      });
      await mutate();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className="card space-y-3 p-6">
        <h2 className="text-lg font-semibold">Create a new overlay URL</h2>
        <form onSubmit={onCreate} className="flex flex-wrap gap-3">
          <label className="sr-only" htmlFor="overlay-label">
            Label
          </label>
          <input
            id="overlay-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Twitch · Main scene"
            className="input max-w-sm"
          />
          <button type="submit" className="btn" disabled={busy}>
            Create
          </button>
        </form>
      </section>

      <section className="card divide-y divide-border">
        {isLoading ? (
          <p className="p-6 text-text-muted">Loading…</p>
        ) : error ? (
          <p className="p-6 text-danger">Failed to load: {error.message}</p>
        ) : !data || data.items.length === 0 ? (
          <p className="p-6 text-text-muted">No overlay URLs yet.</p>
        ) : (
          data.items
            .filter((t) => !t.revokedAt)
            .map((t) => (
              <article key={t.token} className="space-y-2 p-5">
                <div className="flex items-center justify-between gap-4">
                  <h3 className="text-lg font-semibold">{t.label}</h3>
                  <button
                    onClick={() => onRevoke(t.token)}
                    className="btn btn-danger"
                    disabled={busy}
                  >
                    Revoke
                  </button>
                </div>
                <p className="text-text-muted">
                  Browser Source URL — copy this into OBS:
                </p>
                <code className="block break-all rounded bg-bg-elevated p-3 font-mono text-sm">
                  {overlayBase}/overlay/{t.token}
                </code>
              </article>
            ))
        )}
      </section>
    </div>
  );
}
