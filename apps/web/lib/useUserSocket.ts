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
    let cancelled = false;
    let socket: Socket | null = null;

    (async () => {
      let token: string | null = null;
      try {
        token = await getToken();
      } catch {
        // Token fetch failed (Clerk session lost) — give up; the
        // hook will retry on the next mount cycle / sign-in.
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
      for (const [event, fn] of Object.entries(handlers)) {
        socket.on(event, fn);
      }
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
    // ``handlers`` identity is the caller's responsibility — pass a
    // memoised object if you don't want a reconnect on every render.
  }, [isLoaded, isSignedIn, getToken, handlers]);
}
