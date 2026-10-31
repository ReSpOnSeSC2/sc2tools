"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { Socket } from "socket.io-client";

/** One automatic scouting reader across OBS sources and native Companion. */
export function useScoutingVoiceClaim(socketRef: RefObject<Socket | null>) {
  const pending = useRef(new Set<() => void>());
  useEffect(() => {
    const requests = pending.current;
    return () => { for (const cancel of requests) cancel(); };
  }, []);
  return useCallback((gameKey: string): Promise<boolean> => new Promise(resolve => {
    const socket = socketRef.current;
    if (!socket || socket.connected === false || !gameKey.trim()) {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (granted: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      pending.current.delete(cancel);
      resolve(granted);
    };
    const cancel = () => finish(false);
    const timer = window.setTimeout(cancel, 2000);
    pending.current.add(cancel);
    try {
      socket.emit("overlay:claimScoutingVoice", { gameKey }, (reply: { granted?: unknown } | null) => {
        finish(reply?.granted === true);
      });
    } catch {
      finish(false);
    }
  }), [socketRef]);
}
