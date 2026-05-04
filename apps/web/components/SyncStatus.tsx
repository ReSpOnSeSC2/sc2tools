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

/**
 * Live game-count + latest-sync indicator. Subscribes to Socket.io
 * `games:changed` so it ticks without a page refresh.
 */
export function SyncStatus({ total: initialTotal, latest, userId }: Props) {
  const { getToken } = useAuth();
  const [total, setTotal] = useState(initialTotal);
  const [latestAt, setLatestAt] = useState(latest);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let socket: Socket | null = null;
    let cancelled = false;
    (async () => {
      const token = await getToken();
      if (cancelled || !token) return;
      socket = io(API_BASE, {
        auth: { token },
        transports: ["websocket", "polling"],
      });
      socket.on("connect", () => {
        setConnected(true);
        socket?.emit("subscribe:user", userId);
      });
      socket.on("disconnect", () => setConnected(false));
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

  return (
    <p className="text-sm text-text-muted">
      <span className="font-mono text-text">{total}</span>{" "}
      games synced
      {latestAt ? ` · last ${formatRelative(latestAt)}` : ""}
      <span
        className="ml-2 inline-block h-2 w-2 rounded-full align-middle"
        style={{
          background: connected ? "var(--success, #3ec07a)" : "#6b7280",
        }}
        aria-label={connected ? "live" : "offline"}
      />
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
