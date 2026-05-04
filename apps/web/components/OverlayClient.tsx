"use client";

import { useEffect, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { API_BASE } from "@/lib/clientApi";

type LiveGame = {
  myRace?: string;
  oppRace?: string;
  oppName?: string;
  map?: string;
  result?: string;
  oppMmr?: number;
};

/**
 * Public OBS overlay. The token IS the auth — we trade it for a
 * per-overlay socket subscription. No Clerk session here.
 */
export function OverlayClient({ token }: { token: string }) {
  const [live, setLive] = useState<LiveGame | null>(null);

  useEffect(() => {
    const socket: Socket = io(API_BASE, {
      auth: { overlayToken: token },
      transports: ["websocket", "polling"],
    });
    socket.on("overlay:live", (msg: LiveGame) => setLive(msg));
    return () => {
      socket.disconnect();
    };
  }, [token]);

  if (!live) {
    return (
      <div className="flex h-screen items-center justify-center">
        <span className="text-sm text-text-muted">Waiting for next game…</span>
      </div>
    );
  }

  return (
    <div className="flex h-screen items-end justify-center p-12">
      <div className="card max-w-md p-6">
        <h2 className="text-xl font-semibold">{live.oppName || "Opponent"}</h2>
        <p className="text-text-muted">
          {live.oppRace || "?"} on {live.map || "—"}
          {typeof live.oppMmr === "number" ? ` · ${live.oppMmr} MMR` : ""}
        </p>
      </div>
    </div>
  );
}
