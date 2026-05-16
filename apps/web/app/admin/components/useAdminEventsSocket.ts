"use client";

import { useEffect, useRef } from "react";
import { useAuth } from "@clerk/nextjs";
import { io, type Socket } from "socket.io-client";
import { API_BASE } from "@/lib/clientApi";
import type { AdminEvent } from "./adminTypes";

/**
 * Subscribe the current admin session to the live ``admin:event``
 * fan-out so the dashboard counters and the notification feed
 * update the moment a signup or download lands — no polling. The
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
): void {
  const handlerRef = useRef<typeof onEvent>(onEvent);
  handlerRef.current = onEvent;
  const { getToken, isLoaded, isSignedIn } = useAuth();

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    let cancelled = false;
    let socket: Socket | null = null;

    (async () => {
      let token: string | null = null;
      try {
        token = await getToken();
      } catch {
        return;
      }
      if (cancelled || !token) return;
      socket = io(API_BASE, {
        auth: { token },
        transports: ["websocket", "polling"],
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 500,
        reconnectionDelayMax: 5000,
      });
      socket.on("admin:event", (payload: AdminEvent) => {
        const fn = handlerRef.current;
        if (fn && payload && typeof payload === "object") fn(payload);
      });
    })();

    return () => {
      cancelled = true;
      if (socket) {
        try {
          socket.disconnect();
        } catch {
          /* best-effort */
        }
        socket = null;
      }
    };
  }, [isLoaded, isSignedIn, getToken]);
}
