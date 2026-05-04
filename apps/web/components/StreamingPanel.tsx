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
  enabledWidgets?: string[];
};

type ListResponse = { items: Token[] };

const overlayBase =
  typeof window !== "undefined" ? window.location.origin : "";

const WIDGETS: { id: string; label: string; hint: string }[] = [
  { id: "opponent", label: "Opponent identity", hint: "Pre-game dossier — race, MMR, head-to-head" },
  { id: "match-result", label: "Match result", hint: "Victory / Defeat card after the game" },
  { id: "post-game", label: "Post-game build", hint: "Build summary at end of game" },
  { id: "mmr-delta", label: "MMR delta", hint: "± MMR change from this game" },
  { id: "streak", label: "Streak", hint: "Active 3+ win/loss run" },
  { id: "cheese", label: "Cheese alert", hint: "Triggers on cheese probability ≥ 0.4" },
  { id: "rematch", label: "Rematch", hint: "Flags when you've played this opponent recently" },
  { id: "rival", label: "Rival", hint: "Frequent-opponent context" },
  { id: "rank", label: "Rank", hint: "Player's league / tier / MMR" },
  { id: "meta", label: "Meta snapshot", hint: "Current ladder top builds for the matchup" },
  { id: "topbuilds", label: "Top builds", hint: "Your best builds vs this matchup" },
  { id: "fav-opening", label: "Favourite opening", hint: "Opponent's most-shown opening" },
  { id: "best-answer", label: "Best answer", hint: "Your best counter vs that opening" },
  { id: "scouting", label: "Scouting tells", hint: "Predicted strategies + tell timings" },
  { id: "session", label: "Session record", hint: "Today's W-L + MMR drift" },
];

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

  async function onToggleWidget(token: string, widgetId: string, on: boolean) {
    setBusy(true);
    try {
      await apiCall(
        getToken,
        `/v1/overlay-tokens/${encodeURIComponent(token)}/widgets`,
        {
          method: "PATCH",
          body: JSON.stringify({ widget: widgetId, enabled: on }),
        },
      );
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
        <p className="text-sm text-text-muted">
          Each token below gives you a complete overlay URL plus 15 individual
          widget URLs. Add only the widgets you want into OBS as separate
          Browser Sources — each one is transparent and positioned
          independently.
        </p>
      </section>

      <section className="space-y-4">
        {isLoading ? (
          <p className="card p-6 text-text-muted">Loading…</p>
        ) : error ? (
          <p className="card p-6 text-danger">Failed to load: {error.message}</p>
        ) : !data || data.items.filter((t) => !t.revokedAt).length === 0 ? (
          <p className="card p-6 text-text-muted">No overlay URLs yet.</p>
        ) : (
          data.items
            .filter((t) => !t.revokedAt)
            .map((t) => (
              <TokenCard
                key={t.token}
                token={t}
                onRevoke={() => onRevoke(t.token)}
                onToggleWidget={(widget, on) =>
                  onToggleWidget(t.token, widget, on)
                }
                busy={busy}
              />
            ))
        )}
      </section>
    </div>
  );
}

function TokenCard({
  token,
  onRevoke,
  onToggleWidget,
  busy,
}: {
  token: Token;
  onRevoke: () => void;
  onToggleWidget: (widget: string, on: boolean) => void;
  busy: boolean;
}) {
  const enabled = new Set(token.enabledWidgets || WIDGETS.map((w) => w.id));
  const allUrl = `${overlayBase}/overlay/${token.token}`;
  return (
    <article className="card space-y-4 p-5">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">{token.label}</h3>
          <p className="font-mono text-xs text-text-dim">
            {token.token.slice(0, 6)}…{token.token.slice(-4)}
          </p>
        </div>
        <button
          type="button"
          onClick={onRevoke}
          className="btn btn-danger text-xs"
          disabled={busy}
        >
          Revoke
        </button>
      </header>

      <div className="space-y-2">
        <h4 className="text-sm font-semibold uppercase tracking-wide text-text-muted">
          All-in-one URL
        </h4>
        <p className="text-xs text-text-muted">
          One Browser Source with every enabled widget composited together.
        </p>
        <UrlRow url={allUrl} />
      </div>

      <div className="space-y-2">
        <h4 className="text-sm font-semibold uppercase tracking-wide text-text-muted">
          Browser Source URLs (copy whichever widgets you want)
        </h4>
        <p className="text-xs text-text-muted">
          Add only the ones you actually use to OBS, position each
          independently. All share the same socket connection back to the
          API so they stay in sync.
        </p>
        <ul className="divide-y divide-border rounded border border-border">
          {WIDGETS.map((w) => {
            const url = `${overlayBase}/overlay/${token.token}/widget/${w.id}`;
            const isOn = enabled.has(w.id);
            return (
              <li
                key={w.id}
                className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm"
              >
                <input
                  type="checkbox"
                  checked={isOn}
                  onChange={(e) => onToggleWidget(w.id, e.target.checked)}
                  aria-label={`Toggle ${w.label}`}
                  disabled={busy}
                />
                <div className="min-w-[10rem] flex-shrink-0">
                  <div className="font-medium">{w.label}</div>
                  <div className="text-xs text-text-dim">{w.hint}</div>
                </div>
                <code className="block flex-1 break-all rounded bg-bg-elevated p-2 font-mono text-xs">
                  {url}
                </code>
                <button
                  type="button"
                  className="btn btn-secondary text-xs"
                  onClick={() => navigator.clipboard?.writeText(url)}
                >
                  Copy
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </article>
  );
}

function UrlRow({ url }: { url: string }) {
  return (
    <div className="flex flex-wrap items-stretch gap-2">
      <code className="flex-1 break-all rounded bg-bg-elevated p-3 font-mono text-sm">
        {url}
      </code>
      <button
        type="button"
        className="btn btn-secondary"
        onClick={() => navigator.clipboard?.writeText(url)}
      >
        Copy
      </button>
    </div>
  );
}
