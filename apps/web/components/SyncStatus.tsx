"use client";

import { useEffect, useMemo, useState } from "react";
import { useRealtimeState } from "@/components/realtime/RealtimeProvider";
import { gamesChanged } from "@/lib/realtime/gamesRefresh";

type Props = {
  total: number;
  latest: string | null;
  userId: string;
  compact?: boolean;
};

type ConnState = { kind: "connecting" | "connected" | "reconnecting" | "offline"; attempts: number };

/**
 * Live game-count + latest-sync indicator. Subscribes to Socket.io
 * `games:changed` so it ticks without a page refresh.
 *
 * Connection UX:
 *  - Connected: cyan dot + pulse — taps the brand glow.
 *  - Connecting: dim grey dot.
 *  - Reconnecting: warning amber.
 *  - Offline: danger red, shown after several attempts.
 *
 * All colors flow through CSS variables so the bar reads cleanly in
 * both light and dark themes.
 */
export function SyncStatus({ total: initialTotal, latest, userId, compact = false }: Props) {
  const [total, setTotal] = useState(initialTotal);
  const [latestAt, setLatestAt] = useState(latest);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { setTotal(initialTotal); setLatestAt(latest); }, [initialTotal, latest, userId]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer); }, []);
  const handlers = useMemo(() => ({ "games:changed": (payload: unknown) => {
    const value = gamesChanged(payload);
    if (value.inserted > 0) { setTotal((count) => count + value.inserted); setLatestAt(new Date().toISOString()); }
  } }), []);
  const realtime = useRealtimeState(handlers, true);
  const conn: ConnState = { kind: realtime.status, attempts: realtime.attempts };

  const visual = visualForState(conn);

  return (
    <p className={`flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-text-muted ${compact ? "whitespace-nowrap" : ""}`}>
      <span
        role="status"
        aria-live="polite"
        className={`inline-flex shrink-0 items-center gap-1.5 font-medium ${compact ? "xl:rounded-full xl:border xl:border-border xl:bg-bg-elevated xl:px-2 xl:py-0.5" : "rounded-full border border-border bg-bg-elevated px-2 py-0.5"}`}
      >
        <span
          aria-hidden
          className={[
            "inline-block h-2 w-2 rounded-full",
            visual.dotClass,
            visual.pulse ? "motion-safe:animate-pulse" : "",
          ]
            .filter(Boolean)
            .join(" ")}
        />
        <span className={visual.textClass}>{visual.label}</span>
      </span>
      <span>
        <span className="font-mono tabular-nums text-text">
          {compact && total >= 100_000 ? (
            <span title={String(total)}>
              <span aria-hidden className="sm:hidden">{new Intl.NumberFormat("en-US", { notation: "compact", maximumSignificantDigits: 3 }).format(total)}</span>
              <span className="sr-only sm:not-sr-only">{total}</span>
            </span>
          ) : total}
        </span> games
        synced
        {latestAt ? <span title={new Date(latestAt).toLocaleString()} className={compact ? "sr-only sm:not-sr-only" : undefined}>{` · last ${formatRelative(latestAt, now)}`}</span> : null}
      </span>
      {realtime.bulk ? <span role="status" className="max-w-[14rem] basis-full whitespace-normal text-micro text-text-muted xl:basis-auto">Syncing — charts refresh every 30 s</span> : null}
      {conn.kind === "reconnecting" && conn.attempts >= 3 ? (
        <span className={`text-caption text-warning ${compact ? "sr-only sm:not-sr-only" : ""}`}>
          retry {conn.attempts}…
        </span>
      ) : null}
    </p>
  );
}

type Visual = {
  label: string;
  dotClass: string;
  textClass: string;
  pulse: boolean;
};

function visualForState(conn: ConnState): Visual {
  switch (conn.kind) {
    case "connected":
      return {
        label: "Live",
        dotClass: "bg-accent-cyan",
        textClass: "text-accent-cyan",
        pulse: true,
      };
    case "reconnecting":
      return {
        label: "Reconnecting",
        dotClass: "bg-warning",
        textClass: "text-warning",
        pulse: true,
      };
    case "offline":
      return {
        label: "Offline",
        dotClass: "bg-danger",
        textClass: "text-danger",
        pulse: false,
      };
    case "connecting":
    default:
      return {
        label: "Connecting…",
        dotClass: "bg-text-dim",
        textClass: "text-text-dim",
        pulse: false,
      };
  }
}

function formatRelative(iso: string, now: number): string {
  const d = new Date(iso);
  const sec = Math.max(0, (now - d.getTime()) / 1000);
  if (sec < 90) return `${Math.round(sec)}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)} hr ago`;
  return d.toLocaleDateString();
}
