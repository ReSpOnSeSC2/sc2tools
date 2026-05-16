"use client";

import { API_BASE } from "@/lib/clientApi";

/**
 * Fire a one-shot "agent download started" beacon to the public
 * ``POST /v1/agent/download-event`` endpoint. Used by the
 * DownloadCard's onClick so admin counters and the notification
 * feed pick up each click without depending on the GitHub artifact
 * URL being routed through our backend.
 *
 * Uses ``navigator.sendBeacon`` when available — that's the API
 * designed for exit-style analytics and is the only path that
 * reliably survives the browser starting the download navigation
 * a few milliseconds later. Falls back to ``fetch`` with
 * ``keepalive: true`` for older browsers (Safari < 16.4 didn't ship
 * sendBeacon for Blob bodies until recently).
 *
 * Fire-and-forget by design — failures are swallowed. We never
 * surface a download tracker error to the user clicking Download,
 * and the link's default navigation must not be blocked.
 */
export function reportDownloadStarted(payload: {
  platform: "windows" | "macos" | "linux";
  version?: string;
  channel?: string;
}): void {
  if (typeof window === "undefined") return;
  const body = JSON.stringify({
    platform: payload.platform,
    version: payload.version || "",
    channel: payload.channel || "stable",
  });
  const url = `${API_BASE}/v1/agent/download-event`;
  try {
    if (
      typeof navigator !== "undefined" &&
      typeof navigator.sendBeacon === "function"
    ) {
      const blob = new Blob([body], { type: "application/json" });
      const sent = navigator.sendBeacon(url, blob);
      if (sent) return;
    }
  } catch {
    /* fall through to fetch */
  }
  try {
    void fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
      cache: "no-store",
    }).catch(() => {});
  } catch {
    /* never block the click */
  }
}
