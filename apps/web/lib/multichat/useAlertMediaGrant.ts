"use client";

// Fetches and refreshes the presigned grant for the admin-gated SC2 3D alert
// media, then publishes it to the module-level store in ./mediaBase so every
// ChatAlertCard on the page resolves against it.
//
// Two callers, two credentials:
//
//   * useOverlayAlertMediaGrant(token) -- the OBS widget, whose only
//     credential is its URL token. The API resolves that token to its owning
//     user and presigns only when that user holds admin.
//   * the Settings preview, which has a Clerk session -- that surface uses the
//     app's useApi hook (which attaches the Clerk JWT) and publishes the grant
//     with setAlertMediaGrant directly, so no raw fetch is needed here.
//
// A 403 (not an admin) or 503 (R2 not configured) is not an error condition:
// the grant stays empty, every media lookup misses, and the renderer falls
// back to code-native static art. So failures are swallowed deliberately, and
// the hook never retries a 403 -- admin status does not change mid-session.

import { useEffect } from "react";
import { API_BASE } from "../clientApi";
import {
  EMPTY_ALERT_MEDIA_GRANT,
  grantNeedsRefresh,
  getAlertMediaGrant,
  setAlertMediaGrant,
  toAlertMediaGrant,
} from "./mediaBase";


/** Re-check this often; the fetch itself is skipped unless near expiry. */
const POLL_MS = 60_000;

async function fetchGrant(url: string, signal: AbortSignal): Promise<boolean> {
  const res = await fetch(url, { signal, credentials: "omit" });
  if (res.status === 403 || res.status === 503) {
    // Expected for non-admins and unconfigured deployments. Stop asking.
    setAlertMediaGrant(EMPTY_ALERT_MEDIA_GRANT);
    return false;
  }
  if (!res.ok) return true; // transient — leave the grant and retry later
  setAlertMediaGrant(toAlertMediaGrant(await res.json()));
  return true;
}

function useGrantFrom(url: string | null): void {
  useEffect(() => {
    if (!url) return undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();

    const tick = async () => {
      if (stopped) return;
      if (grantNeedsRefresh(getAlertMediaGrant(), Date.now())) {
        try {
          const keepGoing = await fetchGrant(url, controller.signal);
          if (!keepGoing) return; // 403/503 — do not reschedule
        } catch {
          // Network error or abort; fall through and retry on the next tick.
        }
      }
      if (!stopped) timer = setTimeout(tick, POLL_MS);
    };
    void tick();

    return () => {
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [url]);
}

/** Overlay surface: authenticate with the widget's URL token. */
export function useOverlayAlertMediaGrant(token: string | null | undefined): void {
  useGrantFrom(
    token
      ? `${API_BASE}/v1/multichat/${encodeURIComponent(token)}/alert-media`
      : null,
  );
}
