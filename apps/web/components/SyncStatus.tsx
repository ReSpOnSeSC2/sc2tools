"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { io, type Socket } from "socket.io-client";
import { API_BASE } from "@/lib/clientApi";

type Props = {
  total: number;
  latest: string | null;
  userId: string;
  compact?: boolean;
};

type ConnState =
  | { kind: "connecting" }
  | { kind: "connected" }
  | { kind: "reconnecting"; attempts: number }
  | { kind: "offline" };

/**
 * Live game-count + latest-sync indicator. Subscribes to Socket.io
 * `games:changed` so it ticks without a page refresh.
 *
 * Connection UX:
 *  - Connected: cyan dot + pulse — taps the brand glow.
 *  - Polling/connecting: dim grey dot.
 *  - Reconnecting (>=3 attempts): warning amber.
 *  - Offline: danger red, shown after several attempts.
 *
 * All colors flow through CSS variables so the bar reads cleanly in
 * both light and dark themes.
 */
export function SyncStatus({ total: initialTotal, latest, userId, compact = false }: Props) {
  const { getToken } = useAuth();
  const [total, setTotal] = useState(initialTotal);
  const [latestAt, setLatestAt] = useState(latest);
  const [conn, setConn] = useState<ConnState>({ kind: "connecting" });

  useEffect(() => {
    let socket: Socket | null = null;
    let cancelled = false;
    (async () => {
      const token = await getToken();
      if (cancelled || !token) return;
      socket = io(API_BASE, {
        auth: { token },
        transports: ["websocket", "polling"],
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 500,
        reconnectionDelayMax: 5000,
      });
      socket.on("connect", () => {
        setConn({ kind: "connected" });
        socket?.emit("subscribe:user", userId);
      });
      socket.on("disconnect", () => {
        setConn({ kind: "reconnecting", attempts: 1 });
      });
      socket.io.on("reconnect_attempt", (n: number) => {
        setConn(
          n >= 6
            ? { kind: "offline" }
            : { kind: "reconnecting", attempts: n },
        );
      });
      socket.io.on("reconnect", () => {
        setConn({ kind: "connected" });
      });
      socket.on("games:changed", (msg: { count: number }) => {
        setTotal((t) => t + (msg?.count || 0));
        setLatestAt(new Date().toISOString());
      });
    })();
    return () => {
      cancelled = true;
      socket?.disconnect();
    };
  }, [getToken, userId]);

  const visual = visualForState(conn);

  return (
    <p className={`flex items-center gap-x-2 text-caption text-text-muted ${compact ? "whitespace-nowrap" : "flex-wrap gap-y-1"}`}>
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
        {latestAt ? <span className={compact ? "sr-only sm:not-sr-only" : undefined}>{` · last ${formatRelative(latestAt)}`}</span> : null}
      </span>
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
        label: "Polling",
        dotClass: "bg-text-dim",
        textClass: "text-text-dim",
        pulse: false,
      };
  }
}

function formatRelative(iso: string): string {
  const d = new Date(iso);
  const sec = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (sec < 90) return `${Math.round(sec)}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)} hr ago`;
  return d.toLocaleDateString();
}
