"use client";

import useSWR from "swr";
import type { AgentVersionResp, DetectedOS } from "./types";

/**
 * Fetch the latest stable release. Hits the local Next.js route at
 * `/api/agent/version`, which proxies to the GitHub releases API and
 * returns the same `AgentVersionResp` shape the agent's auto-updater
 * already expects. The route is public — no Clerk JWT, no Mongo —
 * so the download page works for logged-out visitors and for users
 * who haven't paired a device yet.
 *
 * We pin to the stable channel and the user's detected OS so the
 * route can pick the right artifact. Falls back to "windows" while
 * OS detection is pending. The route returns no `artifact` field
 * when there is no installer for the platform yet, which surfaces
 * as `data.artifact === undefined` so the UI can show its graceful
 * "no installer yet" state.
 */
export function useReleaseInfo(os: DetectedOS) {
  const platform = osToPlatformParam(os);
  const path = `/api/agent/version?channel=stable&platform=${platform}&current=0.0.0`;
  return useSWR<AgentVersionResp>(path, async (p) => {
    const res = await fetch(p, { cache: "no-store" });
    if (!res.ok) {
      throw new Error(`release_fetch_failed_${res.status}`);
    }
    return (await res.json()) as AgentVersionResp;
  });
}

function osToPlatformParam(os: DetectedOS): string {
  switch (os) {
    case "macos":
      return "macos";
    case "linux":
      return "linux";
    case "windows":
    case "unknown":
    default:
      return "windows";
  }
}

/**
 * Format `sizeBytes` as a human-friendly KB/MB string. Returns
 * "unknown" if the size is missing or non-numeric.
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return "unknown";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}
