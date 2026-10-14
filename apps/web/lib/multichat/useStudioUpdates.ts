"use client";

import { useEffect, useRef } from "react";
import { io } from "socket.io-client";
import { API_BASE } from "@/lib/clientApi";
import { clientTimezone } from "@/lib/timeseries";
import { sanitizeStudioState, type StudioState } from "./useStudioState";

/** Timestamp ordering shared by the two manual control surfaces. */
export function newestStudioSnapshot(current: StudioState | null, next: StudioState): StudioState {
  if (!current) return next;
  const currentAt = current.updatedAt ? Date.parse(current.updatedAt) : NaN;
  const nextAt = next.updatedAt ? Date.parse(next.updatedAt) : NaN;
  return Number.isFinite(currentAt) && (!Number.isFinite(nextAt) || nextAt < currentAt)
    ? current
    : next;
}

/**
 * Lightweight token-authenticated studio subscription. Control surfaces keep
 * their existing GET fallback; this connection supplies immediate saved-state
 * updates without reconnecting when drafts or callback identities change.
 */
export function useStudioUpdates(token: string, onUpdate: (state: StudioState) => void): void {
  const callbackRef = useRef({ token, onUpdate });
  callbackRef.current = { token, onUpdate };
  useEffect(() => {
    let cancelled = false;
    const socket = io(API_BASE, {
      auth: { overlayToken: token, timezone: clientTimezone() },
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
    });
    const receive = (raw: unknown) => {
      // A late callback from the previous token can occur before effect
      // cleanup. Never forward it into the new token's latest callback.
      if (cancelled || callbackRef.current.token !== token || !raw || typeof raw !== "object" || Array.isArray(raw)) return;
      callbackRef.current.onUpdate(sanitizeStudioState(raw));
    };
    socket.on("overlay:multichat", receive);
    return () => {
      cancelled = true;
      socket.off("overlay:multichat", receive);
      socket.disconnect();
    };
  }, [token]);
}
