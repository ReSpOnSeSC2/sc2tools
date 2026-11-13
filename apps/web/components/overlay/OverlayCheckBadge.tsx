"use client";

import { useEffect, useState } from "react";
import type { OverlayConnectionStatus } from "./overlayResilience";

export function OverlayCheckBadge({ status, live = false }: { status: OverlayConnectionStatus; live?: boolean }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("check") !== "1") return;
    setVisible(true);
    const timer = setTimeout(() => setVisible(false), 10_000);
    return () => clearTimeout(timer);
  }, []);
  if (!visible) return null;
  const label = status === "replaced" ? "URL replaced — update OBS" : status === "invalid" ? "Link invalid" : status === "connected" ? `Connected · ${live ? "live game" : "waiting for a game"}` : "Reconnecting…";
  return <div role="status" className="fixed left-3 top-3 z-50 rounded bg-slate-950/95 px-3 py-2 font-sans text-sm text-white">{label}</div>;
}
