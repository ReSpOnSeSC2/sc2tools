"use client";

import { useEffect } from "react";
import { useUser } from "@clerk/nextjs";
import { useApi } from "@/lib/clientApi";
import { gaEvent, isGtagReady, tagSessionAsInternal } from "@/lib/analytics/gtag";
import { markInternalBrowser } from "@/lib/analytics/internalTraffic";
import {
  readTrackedSignUp,
  rememberTrackedSignUp,
  shouldTrackSignUp,
  signUpMethod,
} from "@/lib/analytics/signUp";

/**
 * Flags this browser as internal traffic the first time an admin is seen
 * signed in here (see lib/analytics/internalTraffic). Mounted whether or
 * not analytics consent was given, so the flag is already in place when
 * GA loads. `/v1/me` is the same SWR-deduped call the header makes, and
 * useApi skips it entirely for signed-out visitors.
 */
export function InternalTrafficMarker() {
  const { data: me } = useApi<{ isAdmin?: boolean }>("/v1/me");
  const isAdmin = me?.isAdmin === true;
  useEffect(() => {
    if (isAdmin && markInternalBrowser()) tagSessionAsInternal();
  }, [isAdmin]);
  return null;
}

/**
 * Sends GA4's recommended `sign_up` event once for a brand-new account
 * (see lib/analytics/signUp). Rendered only after gtag.js is set up, and
 * only remembers the account once the event could actually be sent.
 */
export function SignUpTracker() {
  const { isLoaded, user } = useUser();
  useEffect(() => {
    if (!isLoaded || !user || !isGtagReady()) return;
    const check = {
      userId: user.id,
      createdAt: user.createdAt,
      now: Date.now(),
      trackedUserId: readTrackedSignUp(),
    };
    if (!shouldTrackSignUp(check)) return;
    gaEvent("sign_up", { method: signUpMethod(user.externalAccounts) });
    rememberTrackedSignUp(user.id);
  }, [isLoaded, user]);
  return null;
}
