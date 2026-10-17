"use client";

import { useEffect, useRef } from "react";
import { useAuth } from "@clerk/nextjs";
import { io, type Socket } from "socket.io-client";
import { API_BASE } from "@/lib/clientApi";
import type { AdminEvent } from "./adminTypes";

/**
 * Subscribe the current admin session to the live ``admin:event``
 * fan-out so the dashboard counters and the notification feed
 * update the moment a signup, download, or agent connection lands. The
 * server only joins the ``admin`` Socket.io room for sockets whose
 * Clerk user id is on the ``SC2TOOLS_ADMIN_USER_IDS`` allowlist, so
 * a non-admin's session is a no-op even if it called this hook.
 *
 * The handler reference is captured in a ref so a parent that
 * recreates the callback on every render doesn't churn the socket
 * connection.
 */
export function useAdminEventsSocket(
  onEvent: ((event: AdminEvent) => void) | null,
  onConnected: (() => void) | null = null,
): void {
  const handlerRef = useRef<typeof onEvent>(onEvent);
  handlerRef.current = onEvent;
  const connectedRef = useRef<typeof onConnected>(onConnected);
  connectedRef.current = onConnected;
  const { getToken, isLoaded, isSignedIn, userId } = useAuth();

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !userId) return;
    let cancelled = false;
    let socket: Socket | null = null;
    let retryTimer: number | null = null;
    let authRetry = 0;
    socket = io(API_BASE, {
      // A tab can outlive its Clerk JWT. Socket.io invokes this callback on
      // each namespace connection, so reconnects always use current auth.
      auth: async (done) => {
        try {
          const token = await getToken();
          if (!cancelled) done(token ? { token } : {});
        } catch {
          if (!cancelled) done({});
        }
      },
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
    });
    socket.on("admin:event", (payload: AdminEvent) => {
      const fn = handlerRef.current;
      if (!cancelled && fn && payload && typeof payload === "object") fn(payload);
    });
    const clearRetry = () => {
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      retryTimer = null;
    };
    const retryConnect = () => {
      if (cancelled || !socket || socket.connected || retryTimer !== null) return;
      const delay = Math.min(30000, 1000 * 2 ** Math.min(authRetry, 5));
      authRetry += 1;
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        socket?.connect();
      }, delay);
    };
    socket.on("connect", () => {
      if (cancelled) return;
      authRetry = 0;
      clearRetry();
      // Admin events are durable, but the socket does not replay missed ones.
      // Refresh both counters and rows after the initial connect or reconnect.
      connectedRef.current?.();
    });
    socket.on("connect_error", retryConnect);
    window.addEventListener("online", retryConnect);

    return () => {
      cancelled = true;
      clearRetry();
      window.removeEventListener("online", retryConnect);
      if (socket) {
        try {
          socket.disconnect();
        } catch {
          /* best-effort */
        }
        socket = null;
      }
    };
  }, [isLoaded, isSignedIn, getToken, userId]);
}
