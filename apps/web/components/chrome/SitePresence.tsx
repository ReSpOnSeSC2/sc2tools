"use client";

import { useEffect } from "react";
import { useAuth } from "@clerk/nextjs";

const HEARTBEAT_MS = 60_000;
const IDLE_MS = 180_000;
const REQUEST_TIMEOUT_MS = 8_000;

/** Anonymous visitors share an opaque HttpOnly cookie; Clerk users also dedupe by account. */
export function SitePresence() {
  const { isLoaded, isSignedIn, userId, getToken } = useAuth();

  useEffect(() => {
    if (!isLoaded) return;

    let disposed = false;
    let inFlight = false;
    let lastActivity = Date.now();
    let lastAttempt = Number.NEGATIVE_INFINITY;
    const lifecycle = new AbortController();

    const heartbeat = async () => {
      if (
        disposed || inFlight || document.visibilityState !== "visible" ||
        Date.now() - lastActivity >= IDLE_MS ||
        Date.now() - lastAttempt < HEARTBEAT_MS
      ) return;
      inFlight = true;
      lastAttempt = Date.now();
      try {
        const token = isSignedIn ? await getToken() : null;
        if (disposed || (isSignedIn && !token)) return;
        const send = async () => {
          if (disposed || document.visibilityState !== "visible") return;
          const request = new AbortController();
          const abort = () => request.abort();
          lifecycle.signal.addEventListener("abort", abort, { once: true });
          const timeout = window.setTimeout(abort, REQUEST_TIMEOUT_MS);
          try {
            await fetch("/api/site/presence", {
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
          } finally {
            window.clearTimeout(timeout);
            lifecycle.signal.removeEventListener("abort", abort);
          }
        };
        // Serializing across tabs ensures simultaneous first visits reuse the
        // first response's cookie instead of creating a visitor for every tab.
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
