"use client";

import { useState } from "react";
import { AlertTriangle, Check, RefreshCw, Sparkles } from "lucide-react";
import { io } from "socket.io-client";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { API_BASE } from "@/lib/clientApi";
import { fmtAgo } from "@/lib/format";
import { clientTimezone } from "@/lib/timeseries";

/*
 * Settings · Overlay: the pre-stream connection check and the "widget
 * stuck on the last opponent?" help card. Split out of SettingsOverlay.tsx
 * unchanged.
 */

type ProbeResult = {
  connected: boolean;
  config: boolean;
  session: boolean;
  rttMs: number | null;
  error: string | null;
};

const PROBE_TIMEOUT_MS = 8_000;
const PROBE_SETTLE_MS = 2_500;

/**
 * Pre-stream connection diagnostic. Opens a short-lived overlay socket
 * with the SAME token + auth shape an OBS Browser Source uses and
 * reports what arrived: connect ✓, the connect-replay's
 * ``overlay:config`` and ``overlay:session`` snapshots ✓, and the
 * heartbeat round-trip time. Zero new server surface — these are
 * exactly the events the cloud already emits to every fresh overlay
 * connection, so a green checklist here means a Browser Source with
 * this token will paint.
 */
export function ConnectionCheck({
  token,
  lastSeenAt,
}: {
  token: string;
  lastSeenAt?: string | null;
}) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ProbeResult | null>(null);

  async function run() {
    if (running) return;
    setRunning(true);
    const outcome: ProbeResult = {
      connected: false,
      config: false,
      session: false,
      rttMs: null,
      error: null,
    };
    setResult(null);
    await new Promise<void>((resolve) => {
      const socket = io(API_BASE, {
        auth: { overlayToken: token, timezone: clientTimezone() },
        transports: ["websocket", "polling"],
        reconnection: false,
      });
      let heartbeatSentAt = 0;
      const finish = () => {
        window.clearTimeout(deadline);
        try {
          socket.disconnect();
        } catch {
          /* already closed */
        }
        resolve();
      };
      const deadline = window.setTimeout(() => {
        if (!outcome.connected) {
          outcome.error =
            "Couldn't connect — the token may be revoked or the API unreachable.";
        }
        finish();
      }, PROBE_TIMEOUT_MS);
      socket.on("connect", () => {
        outcome.connected = true;
        heartbeatSentAt = performance.now();
        socket.emit("overlay:heartbeat");
        // Give the connect-replay a beat to deliver config + session,
        // then wrap up.
        window.setTimeout(finish, PROBE_SETTLE_MS);
      });
      socket.on("connect_error", (err: Error) => {
        outcome.error = err?.message || "Connection refused.";
        finish();
      });
      socket.on("overlay:config", () => {
        outcome.config = true;
      });
      socket.on("overlay:session", () => {
        outcome.session = true;
      });
      socket.on("overlay:heartbeat", () => {
        if (heartbeatSentAt && outcome.rttMs == null) {
          outcome.rttMs = Math.max(
            1,
            Math.round(performance.now() - heartbeatSentAt),
          );
        }
      });
    });
    setResult(outcome);
    setRunning(false);
  }

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 px-2 py-2">
        <div className="min-w-0">
          <p className="text-body font-medium text-text">
            Overlay connection check
          </p>
          <p className="text-caption text-text-muted">
            Verifies this token connects and receives data — run it before
            going live.{" "}
            {lastSeenAt
              ? `An overlay last connected ${fmtAgo(lastSeenAt)}.`
              : "No overlay has connected with this token yet."}
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void run()}
          disabled={running}
          loading={running}
          iconLeft={<Sparkles className="h-4 w-4" aria-hidden />}
        >
          Check connection
        </Button>
      </div>
      {result ? (
        <div className="space-y-1 border-t border-border px-2 pb-1 pt-3">
          <ProbeRow ok={result.connected} label="Socket connected with this token" />
          <ProbeRow
            ok={result.config}
            label="Widget configuration received (overlay:config)"
          />
          <ProbeRow
            ok={result.session}
            label="Session snapshot received (overlay:session)"
          />
          <ProbeRow
            ok={result.rttMs != null}
            label={
              result.rttMs != null
                ? `Heartbeat round-trip: ${result.rttMs} ms`
                : "Heartbeat round-trip"
            }
          />
          {result.error ? (
            <p className="pt-1 text-caption text-danger" role="alert">
              {result.error}
            </p>
          ) : result.connected && result.config && result.session ? (
            <p className="pt-1 text-caption text-success">
              All clear — Browser Sources with this token will paint.
            </p>
          ) : (
            <p className="pt-1 text-caption text-warning">
              Partially healthy — try again; if a row stays red, re-copy the
              URL or mint a fresh token.
            </p>
          )}
        </div>
      ) : null}
    </Card>
  );
}

function ProbeRow({ ok, label }: { ok: boolean; label: string }) {
  return (
    <p className="flex items-center gap-2 text-caption">
      {ok ? (
        <Check className="h-3.5 w-3.5 flex-shrink-0 text-success" aria-hidden />
      ) : (
        <AlertTriangle
          className="h-3.5 w-3.5 flex-shrink-0 text-danger"
          aria-hidden
        />
      )}
      <span className={ok ? "text-text" : "text-text-muted"}>{label}</span>
    </p>
  );
}

/**
 * Help block explaining how to clear a stuck widget in OBS / Streamlabs.
 *
 * Stale widgets are normally cleared after ~6 minutes of no new game,
 * but if the streamer wants the panel gone NOW (e.g. the dossier is
 * sitting on the previous opponent and they're about to queue), the
 * Browser Source's cache holds the page state across show/hide. The
 * vendor-specific "Refresh cache" action forces OBS to redraw the page
 * and our overlay re-mounts in a clean state.
 */
export function StuckWidgetHelp() {
  return (
    <Card>
      <div className="flex items-start gap-3 px-2 py-2 text-caption text-text-muted">
        <RefreshCw
          className="mt-0.5 h-4 w-4 flex-shrink-0 text-accent-cyan"
          aria-hidden
        />
        <div className="space-y-2">
          <p className="text-text">Widget stuck on the last opponent?</p>
          <p>
            Most widgets auto-hide on a per-panel timer (Match result and
              Streak in seconds, Scouting after its short opening window,
              and Opponent identity after the match). The persistent panels &mdash;{" "}
            <strong className="text-text">Session record</strong> and{" "}
            <strong className="text-text">Top builds</strong> &mdash; stay
            on screen by design. If a widget&apos;s sitting stale, force the
            Browser Source to redraw:
          </p>
          <ul className="ml-4 list-disc space-y-1">
            <li>
              <strong className="text-text">OBS Studio:</strong> right-click the
              Browser Source for the widget &rarr; <em>Refresh cache of current
              page</em>.
            </li>
            <li>
              <strong className="text-text">Streamlabs Desktop:</strong> click
              the Browser Source&apos;s gear icon (or right-click) &rarr;{" "}
              <em>Refresh cache</em>. The widget reloads with no stored state.
            </li>
            <li>
              <strong className="text-text">Streamlabs OBS / OBS.live:</strong>{" "}
              same as Streamlabs Desktop &mdash; the option lives on the source
              context menu.
            </li>
          </ul>
          <p>
            <strong className="text-text">Tip:</strong> in OBS Studio you can
            also tick <em>Shutdown source when not visible</em> and{" "}
            <em>Refresh browser when scene becomes active</em> on the Browser
            Source so the widget always re-mounts when you switch scenes.
          </p>
          <p>
              <strong className="text-text">Test fires</strong> cover real data
              for about 20 s. Stop or expiry removes only the sample and restores
              the latest real opponent and session. During a live match,
              Settings asks before sending samples to viewers; choose{" "}
              <strong className="text-text">Preview here instead</strong> to open
              a local sample page that sends nothing to OBS.
          </p>
        </div>
      </div>
    </Card>
  );
}
