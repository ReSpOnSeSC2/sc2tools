"use client";

import { useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { useApi, apiCall } from "@/lib/clientApi";

type Device = {
  deviceId: string;
  userId: string;
  createdAt: string;
  lastSeenAt: string | null;
  hostname?: string;
  agentVersion?: string;
  agentOs?: string;
  agentOsRelease?: string;
};

type DevicesResponse = { items: Device[] };

/**
 * Build the human label for a device row. We always have *something*
 * to show (the agent has at minimum sent a heartbeat with version+os
 * by the time it appears here), but a brand-new pairing that hasn't
 * heartbeat yet has no metadata at all — fall back to "Unknown device"
 * + the pair date so the row is still distinguishable.
 */
function deviceLabel(d: Device): string {
  const parts: string[] = [];
  if (d.hostname) parts.push(d.hostname);
  if (d.agentOs) parts.push(d.agentOs);
  if (d.agentVersion) parts.push(`v${d.agentVersion}`);
  return parts.length > 0 ? parts.join(" · ") : "Unknown device";
}

export function DevicesPanel() {
  const { getToken } = useAuth();
  const { data, error, isLoading, mutate } =
    useApi<DevicesResponse>("/v1/devices");
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{
    kind: "ok" | "err";
    msg: string;
  } | null>(null);
  const [unpairing, setUnpairing] = useState<string | null>(null);

  async function onClaim(e: React.FormEvent) {
    e.preventDefault();
    setFeedback(null);
    setSubmitting(true);
    try {
      const trimmed = code.trim();
      if (!/^\d{6}$/.test(trimmed)) {
        throw { status: 400, message: "Enter the 6-digit code from the agent." };
      }
      await apiCall(getToken, "/v1/device-pairings/claim", {
        method: "POST",
        body: JSON.stringify({ code: trimmed }),
      });
      setFeedback({
        kind: "ok",
        msg: "Pairing confirmed. The agent will pick this up within a few seconds.",
      });
      setCode("");
      await mutate();
    } catch (err: unknown) {
      const m =
        typeof err === "object" && err !== null && "message" in err
          ? String((err as { message: unknown }).message)
          : "pairing_failed";
      setFeedback({ kind: "err", msg: m });
    } finally {
      setSubmitting(false);
    }
  }

  async function onUnpair(d: Device) {
    const label = deviceLabel(d);
    if (
      !window.confirm(
        `Unpair "${label}"? The agent on that PC will stop syncing until you pair it again.`,
      )
    ) {
      return;
    }
    setFeedback(null);
    setUnpairing(d.deviceId);
    try {
      await apiCall(getToken, `/v1/devices/${encodeURIComponent(d.deviceId)}`, {
        method: "DELETE",
      });
      setFeedback({ kind: "ok", msg: `Unpaired ${label}.` });
      await mutate();
    } catch (err: unknown) {
      const m =
        typeof err === "object" && err !== null && "message" in err
          ? String((err as { message: unknown }).message)
          : "unpair_failed";
      setFeedback({ kind: "err", msg: m });
    } finally {
      setUnpairing(null);
    }
  }

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <section className="card space-y-4 p-6">
        <h2 className="text-lg font-semibold">Pair a new device</h2>
        <p className="text-text-muted">
          On your gaming PC, run <code>sc2tools-agent</code>. It will
          show a 6-digit code in the tray menu. Enter it here.
        </p>
        <form onSubmit={onClaim} className="space-y-3">
          <label className="block text-sm text-text-muted" htmlFor="code">
            Pairing code
          </label>
          <input
            id="code"
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="input font-mono text-2xl tracking-[0.4em]"
            placeholder="123456"
            aria-label="6-digit pairing code"
          />
          <button type="submit" className="btn" disabled={submitting}>
            {submitting ? "Pairing…" : "Pair device"}
          </button>
          {feedback && (
            <p
              className={feedback.kind === "ok" ? "text-success" : "text-danger"}
              role="status"
            >
              {feedback.msg}
            </p>
          )}
        </form>
      </section>

      <section className="card space-y-4 p-6">
        <h2 className="text-lg font-semibold">Connected devices</h2>
        {isLoading ? (
          <p className="text-text-muted">Loading…</p>
        ) : error ? (
          <p className="text-danger">Failed to load: {error.message}</p>
        ) : !data || data.items.length === 0 ? (
          <p className="text-text-muted">
            No devices paired yet. The agent shows up here once you submit
            a code.
          </p>
        ) : (
          <ul className="space-y-2">
            {data.items.map((d) => {
              const isBusy = unpairing === d.deviceId;
              return (
                <li
                  key={d.deviceId}
                  className="flex flex-wrap items-center justify-between gap-3 rounded border border-border bg-bg-elevated p-3 text-sm"
                >
                  <div className="space-y-1">
                    <div className="font-medium">{deviceLabel(d)}</div>
                    <div className="text-xs text-text-muted">
                      Paired {new Date(d.createdAt).toLocaleString()} · last
                      seen{" "}
                      {d.lastSeenAt
                        ? new Date(d.lastSeenAt).toLocaleString()
                        : "never"}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn btn-danger text-xs"
                    onClick={() => onUnpair(d)}
                    disabled={isBusy}
                    aria-label={`Unpair ${deviceLabel(d)}`}
                  >
                    {isBusy ? "Unpairing…" : "Unpair"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
