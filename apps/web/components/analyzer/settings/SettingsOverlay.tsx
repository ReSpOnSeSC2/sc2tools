"use client";

import { useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall, useApi } from "@/lib/clientApi";
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";

type OverlayToken = {
  token: string;
  label: string;
  createdAt: string;
  lastSeenAt?: string | null;
  revokedAt?: string | null;
  enabledWidgets?: string[];
};

type OverlayResp = { items: OverlayToken[] };

const WIDGETS = [
  "opponent",
  "match-result",
  "post-game",
  "mmr-delta",
  "streak",
  "cheese",
  "rematch",
  "rival",
  "rank",
  "meta",
  "topbuilds",
  "fav-opening",
  "best-answer",
  "scouting",
  "session",
];

export function SettingsOverlay({ origin }: { origin?: string }) {
  const { getToken } = useAuth();
  const { data, isLoading, mutate } = useApi<OverlayResp>(
    "/v1/overlay-tokens",
  );

  const [label, setLabel] = useState("Default");
  const [busy, setBusy] = useState(false);

  async function mint() {
    if (busy) return;
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

  async function revoke(token: string) {
    if (busy) return;
    setBusy(true);
    try {
      await apiCall(
        getToken,
        `/v1/overlay-tokens/${encodeURIComponent(token)}`,
        { method: "DELETE" },
      );
      await mutate();
    } finally {
      setBusy(false);
    }
  }

  async function toggleWidget(token: string, widget: string, on: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      await apiCall(
        getToken,
        `/v1/overlay-tokens/${encodeURIComponent(token)}/widgets`,
        {
          method: "PATCH",
          body: JSON.stringify({ widget, enabled: on }),
        },
      );
      await mutate();
    } finally {
      setBusy(false);
    }
  }

  if (isLoading) return <Skeleton rows={3} />;
  const items = (data?.items || []).filter((i) => !i.revokedAt);

  return (
    <div className="space-y-4">
      <Card title="Mint a new overlay URL">
        <div className="flex gap-2">
          <input
            className="input"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label (e.g. main stream, friend test)"
          />
          <button type="button" className="btn" onClick={mint} disabled={busy}>
            Mint
          </button>
        </div>
        <p className="mt-2 text-xs text-text-muted">
          Each token is a hidden bearer credential. Paste the resulting URL
          into OBS as a Browser Source.
        </p>
      </Card>

      <Card title="Active overlay tokens">
        {items.length === 0 ? (
          <EmptyState title="No active overlays" />
        ) : (
          <ul className="space-y-3">
            {items.map((t) => {
              const url = `${origin || ""}/overlay/${t.token}`;
              const enabled = new Set(
                t.enabledWidgets || WIDGETS,
              );
              return (
                <li key={t.token} className="rounded border border-border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <div>
                      <strong>{t.label}</strong>
                      <span className="ml-2 font-mono text-[11px] text-text-dim">
                        {t.token.slice(0, 6)}…{t.token.slice(-4)}
                      </span>
                    </div>
                    <div className="flex gap-1">
                      <button
                        type="button"
                        className="btn btn-secondary text-xs"
                        onClick={() => navigator.clipboard?.writeText(url)}
                      >
                        Copy URL
                      </button>
                      <button
                        type="button"
                        className="btn btn-danger text-xs"
                        onClick={() => revoke(t.token)}
                        disabled={busy}
                      >
                        Revoke
                      </button>
                    </div>
                  </div>
                  <details className="mt-3 text-xs">
                    <summary className="cursor-pointer text-text-muted">
                      Configure widgets ({enabled.size} of {WIDGETS.length})
                    </summary>
                    <div className="mt-2 grid grid-cols-2 gap-1 sm:grid-cols-3">
                      {WIDGETS.map((w) => (
                        <label key={w} className="flex items-center gap-1.5">
                          <input
                            type="checkbox"
                            checked={enabled.has(w)}
                            onChange={(e) =>
                              toggleWidget(t.token, w, e.target.checked)
                            }
                          />
                          {w}
                        </label>
                      ))}
                    </div>
                  </details>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
