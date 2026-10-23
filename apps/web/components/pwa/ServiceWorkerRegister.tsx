"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { RefreshCw } from "lucide-react";

const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Set for the rest of the browser-tab session when the player picks
 * "Later" on the update prompt. Session-scoped on purpose: the prompt
 * stays away while they keep working (moving between the app and the
 * public pages remounts this component), and comes back in their next
 * session while the new version is still waiting.
 */
export const UPDATE_LATER_KEY = "sc2tools.pwa.updateLater";

function readUpdateLater(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(UPDATE_LATER_KEY) === "1";
  } catch {
    // Storage blocked (privacy mode, sandboxed frame): just show it.
    return false;
  }
}

function writeUpdateLater(): void {
  try {
    window.sessionStorage.setItem(UPDATE_LATER_KEY, "1");
  } catch {
    // Storage blocked: "Later" still hides it until this page unloads.
  }
}

/**
 * Read `navigator.serviceWorker` without trusting that reading it is
 * safe — because it isn't.
 *
 * In a sandboxed iframe that lacks `allow-same-origin` the document
 * has an opaque origin, and Chrome makes the *property access* throw
 * `SecurityError: ... Service worker is disabled because the context
 * is sandboxed`. The feature check everyone writes, `"serviceWorker"
 * in navigator`, still returns true there — the property exists on
 * Navigator.prototype, it's the getter that throws — so it does not
 * protect the read that follows it.
 *
 * That matters far more than it looks: this component mounts in the
 * ROOT layout, so a throw here escapes past app/error.tsx to
 * global-error.tsx and replaces the entire document with "SC2 Tools
 * hit a critical error". Settings embeds the overlay scene preview in
 * exactly such an iframe, which is how that landed on a real page.
 */
function serviceWorkerContainer(): ServiceWorkerContainer | null {
  if (typeof navigator === "undefined") return null;
  try {
    return navigator.serviceWorker ?? null;
  } catch {
    // Opaque origin, or storage/service workers disabled by policy.
    return null;
  }
}

/**
 * Registers /sw.js and surfaces an "Update available" prompt when a
 * new build's worker is parked in the `waiting` state (sw.js no longer
 * skipWaiting()s on its own — see the comment there). Accepting posts
 * SKIP_WAITING to the waiting worker and reloads on controllerchange,
 * so a long-lived dashboard tab stops running week-old JavaScript
 * after deploys. "Later" hides the prompt for this session and leaves
 * the worker waiting, so nothing reloads mid-task.
 *
 * The prompt floats `bottom-above-chrome`, above the app's mobile tab
 * bar.
 *
 * /overlay routes opt out of the worker entirely — not just the
 * prompt. Those are OBS Browser Sources composited onto a live stream:
 * an app-shell cache buys them nothing, a stale shell is exactly what
 * their `force-dynamic` / `no-store` headers exist to prevent, and an
 * hourly update poll is pure overhead in a source that stays open for
 * a whole broadcast.
 */
export function ServiceWorkerRegister() {
  const pathname = usePathname();
  const isOverlay = pathname?.startsWith("/overlay") ?? false;
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [applying, setApplying] = useState(false);
  const [later, setLater] = useState(readUpdateLater);
  // Set when the user clicks Reload; controllerchange events we didn't
  // initiate (e.g. very first install) must not reload under the user.
  const applyRequested = useRef(false);
  const promptRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!waiting || later || isOverlay) return;
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused !== document.body && !promptRef.current?.contains(focused)) {
      returnFocusRef.current = focused;
    }
  }, [waiting, later, isOverlay]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (isOverlay) return;
    if (window.location.protocol !== "https:" && window.location.hostname !== "localhost") {
      return;
    }
    const swc = serviceWorkerContainer();
    if (!swc) return;

    let disposed = false;
    let interval: number | undefined;
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void swc.getRegistration().then((r) => r?.update());
      }
    };
    const onControllerChange = () => {
      if (applyRequested.current) window.location.reload();
    };

    swc
      .register("/sw.js", { scope: "/" })
      .then((reg) => {
        if (disposed) return;
        // A worker may already be parked from a previous visit.
        if (reg.waiting && swc.controller) {
          setWaiting(reg.waiting);
        }
        reg.addEventListener("updatefound", () => {
          const installing = reg.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            // `installed` + an existing controller = an UPDATE (first
            // installs have no controller and need no prompt).
            if (installing.state === "installed" && swc.controller) {
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

    swc.addEventListener("controllerchange", onControllerChange);

    return () => {
      disposed = true;
      if (interval) window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      swc.removeEventListener("controllerchange", onControllerChange);
    };
  }, [isOverlay]);

  if (isOverlay || !waiting || later) return null;

  return (
    <div
      ref={promptRef}
      role="status"
      aria-label="Update available"
      onFocusCapture={(event) => {
        const previous = event.relatedTarget;
        if (previous instanceof HTMLElement && previous !== document.body && !event.currentTarget.contains(previous)) {
          returnFocusRef.current = previous;
        }
      }}
      className="fixed bottom-above-chrome left-1/2 z-banner flex w-[calc(100%-2rem)] max-w-md -translate-x-1/2 flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-xl border-2 border-line bg-bg-surface px-4 py-3 shadow-hard"
    >
      <p className="min-w-0 flex-1 basis-48 text-caption text-text">
        <span className="font-semibold">Update available.</span>{" "}
        <span className="text-text-muted">
          Reload to get the latest version.
        </span>
      </p>
      <div className="ml-auto flex flex-shrink-0 items-center gap-2">
        <button
          type="button"
          disabled={applying}
          onClick={() => {
            writeUpdateLater();
            const previous = returnFocusRef.current;
            const target = previous?.isConnected ? previous : document.getElementById("main-content");
            target?.focus();
            setLater(true);
          }}
          className="inline-flex min-h-[36px] items-center rounded-lg px-3 text-caption font-semibold text-text-muted transition-colors hover:bg-bg-elevated hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:opacity-60"
        >
          Later
        </button>
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
          className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg bg-accent px-3 text-caption font-semibold text-white transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:opacity-60"
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${applying ? "animate-spin" : ""}`}
            aria-hidden
          />
          {applying ? "Updating…" : "Reload"}
        </button>
      </div>
    </div>
  );
}
