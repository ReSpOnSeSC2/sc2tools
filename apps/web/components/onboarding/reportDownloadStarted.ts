"use client";

/**
 * Legacy compatibility for browser bundles deployed before installer links
 * moved to the tracked ``POST /api/download/agent`` form hand-off. New code
 * should submit the resolved artifact there so the redirect and notification
 * share one server-side request lifecycle.
 *
 * Why same-origin: ``navigator.sendBeacon`` with a JSON body is not a
 * CORS-safelisted request, so a cross-origin beacon (web origin -> api
 * subdomain) needs a preflight that sendBeacon can't perform — the
 * browser drops it silently, which is why download counts could read 0.
 * Posting to our own origin avoids CORS entirely; the Next route does
 * the reliable server-to-server forward.
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
  const url = "/api/agent/download-event";
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
