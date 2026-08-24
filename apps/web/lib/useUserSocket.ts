"use client";

import { useEffect } from "react";
import { useAuth } from "@clerk/nextjs";
import { io, type Socket } from "socket.io-client";
import { API_BASE } from "@/lib/clientApi";

/**
 * One Clerk-authenticated Socket.io connection per mount, used by
 * the analyzer pages to receive per-user cloud events like
 * ``games:changed`` (fired by ``POST /v1/games`` ingest) so the dashboard
 * can refresh its lists in real time instead of waiting for a manual
 * refresh.
 *
 * Server-side details (see ``apps/api/src/socket/auth.js``):
 *
 *   * The handshake passes the Clerk JWT as ``auth.token``; the
 *     middleware verifies it, resolves the internal userId via
 *     ``ensureFromClerk`` (when wired in ``server.js``), and joins
 *     the socket into ``user:<userId>`` automatically.
 *   * ``games:changed`` is fanned out to that room by the games
 *     ingest route, so the listener registered here fires within a
 *     few milliseconds of the agent's POST returning 202.
 *
 * Reconnection policy mirrors the OBS overlay sockets — infinite
 * attempts with a bounded back-off — so a transient network blip
 * doesn't permanently silence the auto-refresh.
 *
 * @param handlers
 *   Map of event-name to handler. Reference doesn't need to be stable
 *   from the caller (the effect captures it in a ref under the hood).
 *   Pass ``null`` to skip wiring (e.g. before sign-in resolves).
 */
export function useUserSocket(
  handlers: Record<string, (payload: unknown) => void> | null,
): void {
  const { getToken, isLoaded, isSignedIn } = useAuth();

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !handlers) return;
    let socket: Socket | null = null;
    let retryTimer: number | null = null;
    let authRetry = 0;
    socket = io(API_BASE, {
      // Socket.io invokes an auth callback for every fresh namespace
      // connection, including transport reconnects. Clerk tokens can expire
      // while a tab is open, so never pin the first token forever.
      auth: async (done) => {
        try {
          const token = await getToken();
          done(token ? { token } : {});
        } catch {
          done({});
        }
      },
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
    });
    for (const [event, fn] of Object.entries(handlers)) {
      socket.on(event, fn);
    }
    const clearRetry = () => {
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      retryTimer = null;
    };
    const retryConnect = () => {
      if (!socket || socket.connected || retryTimer !== null) return;
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(authRetry, 5));
      authRetry += 1;
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        socket?.connect();
      }, delay);
    };
    socket.on("connect", () => {
      authRetry = 0;
      clearRetry();
    });
    // Namespace middleware failures do not enter Socket.io's transport-level
    // reconnect loop. Retry them explicitly with a capped backoff so a brief
    // Clerk/Mongo outage cannot silence realtime updates for the tab lifetime.
    socket.on("connect_error", retryConnect);
    window.addEventListener("online", retryConnect);

    return () => {
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
    // ``handlers`` identity is the caller's responsibility — pass a
    // memoised object if you don't want a reconnect on every render.
  }, [isLoaded, isSignedIn, getToken, handlers]);
}
