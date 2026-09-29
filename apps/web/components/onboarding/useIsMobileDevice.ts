"use client";

import { useEffect, useState } from "react";
import { detectPlatform } from "@/lib/instant/fileIntake";

/**
 * Whether a user agent is a phone or tablet (iPhone, iPad — including
 * iPadOS's desktop-class Safari — or Android), where the Windows agent
 * can't be installed.
 *
 * Example: `isMobilePlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)")` → true.
 */
export function isMobilePlatform(userAgent: string, maxTouchPoints = 0): boolean {
  const platform = detectPlatform(userAgent, maxTouchPoints);
  return platform === "ios" || platform === "android";
}

/**
 * Client-only mobile check. False on the server and the first client
 * paint (no hydration drift), then the real answer after mount.
 */
export function useIsMobileDevice(): boolean {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    if (typeof navigator === "undefined") return;
    setMobile(isMobilePlatform(navigator.userAgent || "", navigator.maxTouchPoints || 0));
  }, []);
  return mobile;
}
