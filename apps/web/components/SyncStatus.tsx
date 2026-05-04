"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { io, type Socket } from "socket.io-client";
import { API_BASE } from "@/lib/clientApi";

type Props = {
  total: number;
  latest: string | null;
  userId: string;
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
 *  - On first connect: green dot, no extra text.
 *  - On disconnect: dot goes amber and we show "reconnecting…" once
 *    we've passed the 3rd retry — one or two transient blips are
 *    invisible, but a sustained loss is surfaced.
 *  - After several attempts: dot goes red with "offline" label.
 */
export function SyncStatus({ total: initialTotal, latest, userId }: Props) {
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

  const dot =
    conn.kind === "connected"
      ? { color: "var(--success, #3ec07a)", label: "live" }
      : conn.kind === "reconnecting"
        ? { color: "#e6b450", label: `reconnecting (${conn.attempts})` }
        : conn.kind === "offline"
          ? { color: "#ff6b6b", label: "offline" }
          : { color: "#6b7280", label: "connecting…" };

  const showHint = conn.kind === "reconnecting" && conn.attempts >= 3;
  const showOffline = conn.kind === "offline";

  return (
    <p className="text-sm text-text-muted">
      <span className="font-mono text-text">{total}</span>{" "}
      games synced
      {latestAt ? ` · last ${formatRelative(latestAt)}` : ""}
      <span
        className="ml-2 inline-block h-2 w-2 rounded-full align-middle"
        style={{ background: dot.color }}
        aria-label={dot.label}
        title={dot.label}
      />
      {showHint && (
        <span className="ml-2 text-xs text-warning">
          reconnecting… (try {conn.attempts})
        </span>
      )}
      {showOffline && (
        <span className="ml-2 text-xs text-danger">offline — click to retry</span>
      )}
    </p>
  );
}

function formatRelative(iso: string): string {
  const d = new Date(iso);
  const sec = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (sec < 90) return `${Math.round(sec)}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)} hr ago`;
  return d.toLocaleDateString();
}
