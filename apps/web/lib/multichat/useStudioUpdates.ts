"use client";

import { useEffect, useRef, useState } from "react";
import { createOverlaySocket, type OverlayConnectionStatus } from "@/components/overlay/overlayResilience";
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
export function useStudioUpdates(token: string, onUpdate: (state: StudioState) => void, enabled = true, controlOnly = false): { status: OverlayConnectionStatus } {
  const [connection, setConnection] = useState<{ token: string; status: OverlayConnectionStatus }>({ token, status: "connecting" });
  const callbackRef = useRef({ token, onUpdate });
  callbackRef.current = { token, onUpdate };
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const connection = createOverlaySocket(token, { surface: "dock", auth: controlOnly ? { controlOnly: true } : undefined, onStatus: (status) => setConnection({ token, status }) });
    const socket = connection.socket;
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
      connection.dispose();
    };
  }, [token, enabled, controlOnly]);
  return { status: connection.token === token ? connection.status : "connecting" };
}
