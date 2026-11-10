"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const REVISION_URL = `${(process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8080").replace(/\/$/, "")}/v1/guides/revision`;
const CHECK_INTERVAL_MS = 60_000;
const CHECK_TIMEOUT_MS = 5_000;
const REFRESH_DELAY_MS = 100;
const REFRESH_COOLDOWN_MS = 2_000;

/** Refresh changed guides quietly; hidden/offline pages do no background work. */
export function GuideFreshness({ initialRevision = null }: { initialRevision?: string | null }) {
  const router = useRouter();

  useEffect(() => {
    let revision = initialRevision;
    let active = true;
    let wasHidden = document.visibilityState !== "visible";
    let lastRefreshAt = -Infinity;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let checkTimer: ReturnType<typeof setTimeout> | null = null;
    let inFlight: AbortController | null = null;
    const available = () => active && document.visibilityState === "visible" && navigator.onLine;

    function cancelRefresh() {
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      refreshTimer = null;
    }

    function refreshOnReturn(changed = false) {
      if (!available() || refreshTimer !== null) return;
      const remaining = REFRESH_COOLDOWN_MS - (Date.now() - lastRefreshAt);
      if (!changed && remaining > 0) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        if (!available()) return;
        lastRefreshAt = Date.now();
        router.refresh();
      }, Math.max(REFRESH_DELAY_MS, changed ? remaining : 0));
    }

    function pauseChecks() {
      if (checkTimer !== null) clearTimeout(checkTimer);
      checkTimer = null;
      inFlight?.abort();
    }

    async function checkRevision() {
      if (!available() || inFlight) return;
      const controller = new AbortController();
      inFlight = controller;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const body: unknown = await Promise.race([
          fetch(REVISION_URL, {
            headers: { accept: "application/json" }, credentials: "omit",
            cache: "no-store", signal: controller.signal,
          }).then((response) => response.ok ? response.json() : null),
          new Promise<never>((_resolve, reject) => {
            deadline = setTimeout(() => {
              controller.abort();
              reject(new Error("guide_revision_timeout"));
            }, CHECK_TIMEOUT_MS);
          }),
        ]);
        if (!available() || controller.signal.aborted || !body || typeof body !== "object") return;
        const next = (body as { revision?: unknown }).revision;
        if (typeof next !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(next)) return;
        if (next !== revision) {
          revision = next;
          refreshOnReturn(true);
        }
      } catch {
        // A rolling deploy, offline device or failed check leaves the guide usable.
      } finally {
        if (deadline !== undefined) clearTimeout(deadline);
        inFlight = null;
        if (available()) checkTimer = setTimeout(() => { checkTimer = null; void checkRevision(); }, CHECK_INTERVAL_MS);
      }
    }

    function resumeChecks() {
      if (checkTimer !== null) clearTimeout(checkTimer);
      checkTimer = null;
      void checkRevision();
    }

    function onVisibilityChange() {
      if (document.visibilityState !== "visible") {
        wasHidden = true;
        cancelRefresh();
        pauseChecks();
      } else if (wasHidden) {
        wasHidden = false;
        refreshOnReturn();
        resumeChecks();
      }
    }

    function onPageShow(event: PageTransitionEvent) {
      if (!event.persisted) return;
      if (document.visibilityState === "visible") { refreshOnReturn(); resumeChecks(); }
      else wasHidden = true;
    }

    function onOnline() { refreshOnReturn(); resumeChecks(); }
    function onOffline() { cancelRefresh(); pauseChecks(); }

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    void checkRevision();
    return () => {
      active = false;
      cancelRefresh();
      pauseChecks();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [router, initialRevision]);

  return null;
}
