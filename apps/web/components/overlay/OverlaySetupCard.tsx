"use client";

import { useEffect, useState } from "react";
import type { OverlayConnectionStatus } from "./overlayResilience";

export function OverlaySetupCard({ reason, name, suggestion }: {
  reason: "invalid-token" | "unknown-widget" | "unknown-scene" | (string & {});
  name?: string;
  suggestion?: string | null;
}) {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => { setCollapsed(false); const timer = setTimeout(() => setCollapsed(true), 60_000); return () => clearTimeout(timer); }, [reason, name]);
  return <div role="status" className="fixed bottom-4 left-4 z-50 max-w-[360px] rounded-lg border border-amber-400/50 bg-slate-950/95 p-3 font-sans text-sm text-white">
    {collapsed ? "Overlay link invalid" : <><p className="font-semibold">This overlay link no longer works</p>
      {reason.startsWith("unknown-") && suggestion ? <p className="mt-1">There&apos;s no {reason === "unknown-widget" ? "widget" : "scene"} called &quot;{name}&quot;. Did you mean &quot;{suggestion}&quot;?</p> : null}
      <p className="mt-1">{reason === "invalid-token" ? "It was revoked or mistyped. " : ""}Copy a fresh URL from sc2tools.com → Settings → Overlay.</p></>}
  </div>;
}

export function OverlayCheckBadge({ status, live = false }: { status: OverlayConnectionStatus; live?: boolean }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("check") !== "1") return;
    setVisible(true); const timer = setTimeout(() => setVisible(false), 10_000); return () => clearTimeout(timer);
  }, []);
  if (!visible) return null;
  const label = status === "invalid" ? "Link invalid" : status === "connected" ? `Connected · ${live ? "live game" : "waiting for a game"}` : "Reconnecting…";
  return <div role="status" className="fixed left-3 top-3 z-50 rounded bg-slate-950/95 px-3 py-2 font-sans text-sm text-white">{label}</div>;
}
