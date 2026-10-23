"use client";

import { useEffect, useSyncExternalStore } from "react";
export type InstallPlatform = "ios-safari" | "ios-other" | "android" | "desktop-chromium" | "unsupported";
export type InstallOutcome = "accepted" | "dismissed" | "unavailable";
export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(display-mode: standalone)")?.matches === true || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}
export function detectInstallPlatform(): InstallPlatform {
  if (typeof navigator === "undefined") return "unsupported";
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && (navigator.maxTouchPoints > 1 || "ontouchend" in document));
  if (ios) return /Safari/i.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/i.test(ua) ? "ios-safari" : "ios-other";
  if (/Android/i.test(ua)) return "android";
  return /Chrome|Chromium|Edg\//i.test(ua) ? "desktop-chromium" : "unsupported";
}
const INITIAL = { available: false, platform: "unsupported" as InstallPlatform, installed: false };
let state = INITIAL;
let deferred: BeforeInstallPromptEvent | null = null;
let listening = false;
const listeners = new Set<() => void>();
function publish(next: typeof state) {
  if (Object.keys(next).every((key) => next[key as keyof typeof next] === state[key as keyof typeof state])) return;
  state = next; for (const listener of listeners) listener();
}
/** Idempotent page-lifetime capture: the event often precedes a menu mount. */
export function startInstallCapture(): void {
  if (typeof window === "undefined") return;
  if (!listening) {
    listening = true;
    window.addEventListener("beforeinstallprompt", (event) => {
      event.preventDefault(); deferred = event as BeforeInstallPromptEvent;
      publish({ available: true, platform: detectInstallPlatform(), installed: false });
    });
    window.addEventListener("appinstalled", () => {
      deferred = null; publish({ ...state, available: false, installed: true });
    });
  }
  publish({ ...state, platform: detectInstallPlatform(), installed: state.installed || isStandalone() });
}
async function promptInstall(): Promise<InstallOutcome> {
  const event = deferred;
  if (!event || state.installed) return "unavailable";
  // Consume before awaiting: two entry points cannot prompt the same event.
  deferred = null; publish({ ...state, available: false });
  try {
    await event.prompt(); const choice = await event.userChoice;
    if (choice.outcome === "accepted") publish({ ...state, installed: true });
    return choice.outcome;
  } catch { return "unavailable"; }
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useInstallState() {
  useEffect(startInstallCapture, []);
  const snapshot = useSyncExternalStore(subscribe, () => state, () => INITIAL);
  return { ...snapshot, promptInstall };
}
