"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { RefreshCw } from "lucide-react";

const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Registers /sw.js and surfaces an "Update available" prompt when a
 * new build's worker is parked in the `waiting` state (sw.js no longer
 * skipWaiting()s on its own — see the comment there). Accepting posts
 * SKIP_WAITING to the waiting worker and reloads on controllerchange,
 * so a long-lived dashboard tab stops running week-old JavaScript
 * after deploys.
 *
 * The prompt NEVER renders on /overlay routes — those are OBS Browser
 * Sources composited onto a live stream; updates there apply silently
 * on the next scene load instead.
 */
export function ServiceWorkerRegister() {
  const pathname = usePathname();
  const isOverlay = pathname?.startsWith("/overlay") ?? false;
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [applying, setApplying] = useState(false);
  // Set when the user clicks Reload; controllerchange events we didn't
  // initiate (e.g. very first install) must not reload under the user.
  const applyRequested = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    if (window.location.protocol !== "https:" && window.location.hostname !== "localhost") {
      return;
    }

    let disposed = false;
    let interval: number | undefined;
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void navigator.serviceWorker.getRegistration().then((r) => r?.update());
      }
    };
    const onControllerChange = () => {
      if (applyRequested.current) window.location.reload();
    };

    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then((reg) => {
        if (disposed) return;
        // A worker may already be parked from a previous visit.
        if (reg.waiting && navigator.serviceWorker.controller) {
          setWaiting(reg.waiting);
        }
        reg.addEventListener("updatefound", () => {
          const installing = reg.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            // `installed` + an existing controller = an UPDATE (first
            // installs have no controller and need no prompt).
            if (
              installing.state === "installed" &&
              navigator.serviceWorker.controller
            ) {
              setWaiting(reg.waiting ?? installing);
            }
          });
        });
        // Long-lived tabs never re-register, so poke the update check
        // hourly and whenever the tab regains focus.
        interval = window.setInterval(
          () => void reg.update(),
          UPDATE_CHECK_INTERVAL_MS,
        );
        document.addEventListener("visibilitychange", onVisible);
      })
      .catch(() => {
        // Registration failures are non-fatal — the site still works,
        // it just won't be installable on this device.
      });

    navigator.serviceWorker.addEventListener(
      "controllerchange",
      onControllerChange,
    );

    return () => {
      disposed = true;
      if (interval) window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      navigator.serviceWorker.removeEventListener(
        "controllerchange",
        onControllerChange,
      );
    };
  }, []);

  if (isOverlay || !waiting) return null;

  return (
    <div
      role="status"
      className="fixed bottom-4 left-1/2 z-50 flex w-[calc(100%-2rem)] max-w-md -translate-x-1/2 items-center justify-between gap-3 rounded-xl border-2 border-line bg-bg-surface px-4 py-3 shadow-hard"
    >
      <p className="text-caption text-text">
        <span className="font-semibold">Update available.</span>{" "}
        <span className="text-text-muted">
          Reload to get the latest version.
        </span>
      </p>
      <button
        type="button"
        disabled={applying}
        onClick={() => {
          setApplying(true);
          applyRequested.current = true;
          waiting.postMessage({ type: "SKIP_WAITING" });
          // Safety net: if controllerchange never fires (rare), reload
          // anyway after a short grace period.
          window.setTimeout(() => window.location.reload(), 3000);
        }}
        className="inline-flex min-h-[36px] flex-shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 text-caption font-semibold text-white transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:opacity-60"
      >
        <RefreshCw
          className={`h-3.5 w-3.5 ${applying ? "animate-spin" : ""}`}
          aria-hidden
        />
        {applying ? "Updating…" : "Reload"}
      </button>
    </div>
  );
}
