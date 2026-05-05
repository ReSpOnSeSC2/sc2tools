"use client";

import { useEffect, useState } from "react";
import type { DetectedOS } from "./types";

/**
 * Detect the visitor's OS from `navigator.userAgentData` (preferred)
 * with `navigator.platform` / userAgent string as fallback. Returns
 * "unknown" until the first client tick to avoid SSR hydration drift.
 */
export function usePlatformDetect(): DetectedOS {
  const [os, setOs] = useState<DetectedOS>("unknown");

  useEffect(() => {
    setOs(detectOs());
  }, []);

  return os;
}

function detectOs(): DetectedOS {
  if (typeof navigator === "undefined") return "unknown";

  type UAData = { platform?: string };
  const uaData = (navigator as unknown as { userAgentData?: UAData })
    .userAgentData;
  const platform =
    (uaData?.platform || "").toLowerCase() ||
    (navigator.platform || "").toLowerCase();
  const ua = (navigator.userAgent || "").toLowerCase();

  if (platform.includes("win") || ua.includes("windows")) return "windows";
  if (platform.includes("mac") || ua.includes("mac os")) return "macos";
  if (platform.includes("linux") || ua.includes("linux")) return "linux";
  return "unknown";
}
