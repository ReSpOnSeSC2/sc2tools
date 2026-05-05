"use client";

import { useApi } from "@/lib/clientApi";
import type { AgentVersionResp, DetectedOS } from "./types";

/**
 * Fetch the latest stable release from `GET /v1/agent/version`. Sends
 * `current=0.0.0` so the server always returns the latest artifact's
 * metadata (the agent endpoint short-circuits with
 * `update_available:false` when the agent is already up-to-date).
 *
 * We pin to the stable channel and the user's detected OS so the
 * server picks the right artifact. Falls back to "windows" while OS
 * detection is pending — the API returns `null` on missing platform,
 * which surfaces as `data.artifact === undefined` so the UI can show a
 * graceful "no installer yet" state.
 */
export function useReleaseInfo(os: DetectedOS) {
  const platform = osToPlatformParam(os);
  const path = `/v1/agent/version?channel=stable&platform=${platform}&current=0.0.0`;
  return useApi<AgentVersionResp>(path);
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
