"use client";

import { useEffect } from "react";
import { useAuth } from "@clerk/nextjs";

const HEARTBEAT_MS = 60_000;
const IDLE_MS = 180_000;
const REQUEST_TIMEOUT_MS = 8_000;
const LAST_HEARTBEAT_KEY = "sc2tools-site-presence:last-success";

function recentlyCheckedIn(identity: string): boolean {
  try {
    const previous: unknown = JSON.parse(localStorage.getItem(LAST_HEARTBEAT_KEY) || "null");
    if (
      !previous || typeof previous !== "object" ||
      !("identity" in previous) || !("at" in previous) || typeof previous.at !== "number"
    ) return false;
    const age = Date.now() - previous.at;
    return previous.identity === identity && Number.isFinite(age) && age >= 0 && age < HEARTBEAT_MS;
  } catch {
    return false;
  }
}

function rememberCheckIn(identity: string) {
  try {
    // Share only an identity marker and timestamp, never the auth token or cookie.
    localStorage.setItem(LAST_HEARTBEAT_KEY, JSON.stringify({ identity, at: Date.now() }));
  } catch {
    // Storage can be unavailable; presence still works without cross-tab deduping.
  }
}

/** Anonymous visitors share an opaque HttpOnly cookie; Clerk users also dedupe by account. */
export function SitePresence() {
  const { isLoaded, isSignedIn, userId, getToken } = useAuth();

  useEffect(() => {
    if (!isLoaded || (isSignedIn && !userId)) return;
    const identity = isSignedIn ? `user:${userId}` : "anonymous";

    let disposed = false;
    let inFlight = false;
    let lastActivity = Date.now();
    let lastAttempt = Number.NEGATIVE_INFINITY;
    const lifecycle = new AbortController();

    const heartbeat = async () => {
      if (
        disposed || inFlight || navigator.onLine === false || document.visibilityState !== "visible" ||
        Date.now() - lastActivity >= IDLE_MS ||
        Date.now() - lastAttempt < HEARTBEAT_MS
      ) return;
      inFlight = true;
      lastAttempt = Date.now();
      try {
        const token = isSignedIn ? await getToken() : null;
        if (disposed || (isSignedIn && !token)) return;
        const send = async () => {
          if (
            disposed || navigator.onLine === false || document.visibilityState !== "visible" ||
            Date.now() - lastActivity >= IDLE_MS || recentlyCheckedIn(identity)
          ) return;
          const request = new AbortController();
          const abort = () => request.abort();
          lifecycle.signal.addEventListener("abort", abort, { once: true });
          const timeout = window.setTimeout(abort, REQUEST_TIMEOUT_MS);
          try {
            const response = await fetch("/api/site/presence", {
              method: "POST",
              credentials: "same-origin",
              headers: {
                "content-type": "application/json",
                ...(token ? { authorization: `Bearer ${token}` } : {}),
              },
              body: "{}",
              cache: "no-store",
              signal: request.signal,
            });
            if (!disposed && !request.signal.aborted && response.ok) rememberCheckIn(identity);
          } finally {
            window.clearTimeout(timeout);
            lifecycle.signal.removeEventListener("abort", abort);
          }
        };
        // Serialize the shared timestamp check with cookie initialization. One
        // successful heartbeat covers tabs with the same current auth identity.
        if (navigator.locks?.request) {
          await navigator.locks.request("sc2tools-site-presence", { signal: lifecycle.signal }, send);
        } else {
          await send();
        }
      } catch {
        // Presence is best effort; the next visible, active heartbeat retries.
      } finally {
        inFlight = false;
      }
    };

    const activity = () => {
      if (document.visibilityState !== "visible") return;
      lastActivity = Date.now();
      void heartbeat();
    };
    const activityEvents = ["pointerdown", "pointermove", "keydown", "scroll", "touchstart"] as const;
    for (const event of activityEvents) {
      window.addEventListener(event, activity, { passive: true });
    }
    document.addEventListener("visibilitychange", activity);
    window.addEventListener("focus", activity);
    const timer = window.setInterval(() => void heartbeat(), HEARTBEAT_MS);
    void heartbeat();

    return () => {
      disposed = true;
      lifecycle.abort();
      window.clearInterval(timer);
      for (const event of activityEvents) window.removeEventListener(event, activity);
      document.removeEventListener("visibilitychange", activity);
      window.removeEventListener("focus", activity);
    };
  }, [isLoaded, isSignedIn, userId, getToken]);

  return null;
}
