"use client";

import { useSyncExternalStore } from "react";
import Link from "next/link";
import { Cookie } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import {
  isAnalyticsConfigured,
  readConsent,
  setConsent,
  subscribeConsent,
} from "@/lib/analytics/consent";

/**
 * Cookie / analytics consent banner — GDPR opt-in.
 *
 * Shown until the visitor makes a choice. Strictly-necessary cookies
 * (Clerk session) are always set; the opt-in here governs ONLY Google
 * Analytics, which never loads until "Accept" is clicked (see
 * ``lib/analytics/consent`` and ``<GoogleAnalytics>``).
 *
 * The visible/hidden state is derived from the shared consent store via
 * ``useSyncExternalStore`` so a choice made here (or in another tab)
 * dismisses the banner everywhere and flips GA on/off instantly.
 *
 * When no GA measurement id is configured there's nothing to consent
 * to, so the banner stays hidden entirely.
 *
 * Layout:
 *   - Mobile: full-width sheet pinned to the bottom, inset by
 *     safe-area-inset-bottom so it clears the iOS home indicator.
 *   - ≥sm: floats as a card in the bottom-right corner.
 */
export function CookieBanner() {
  const consent = useSyncExternalStore(
    subscribeConsent,
    readConsent,
    () => "unset" as const,
  );

  // Hidden once a choice is made, and when there's no GA to gate.
  if (!isAnalyticsConfigured() || consent !== "unset") return null;

  return (
    <div
      data-cookie-banner
      role="dialog"
      aria-labelledby="cookie-title"
      aria-describedby="cookie-body"
      className={[
        "fixed inset-x-0 bottom-0 z-50 px-3",
        "pb-[max(env(safe-area-inset-bottom,0px),12px)]",
        "sm:bottom-4 sm:left-auto sm:right-4 sm:inset-x-auto sm:max-w-md sm:px-0 sm:pb-4",
      ].join(" ")}
    >
      <Card variant="elevated" padded={false}>
        <div className="flex items-start gap-3 p-4">
          <span
            aria-hidden
            className="mt-0.5 inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-accent-cyan/10 text-accent-cyan"
          >
            <Cookie className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1 space-y-2">
            <p
              id="cookie-title"
              className="text-caption font-semibold text-text"
            >
              Cookies &amp; analytics
            </p>
            <p id="cookie-body" className="text-caption text-text-muted">
              We use a strictly-necessary session cookie to keep you signed in.
              With your consent we also use Google Analytics to understand how
              SC2 Tools is used — no ads, no data selling. See our{" "}
              <Link
                href="/legal/privacy"
                className="font-medium text-accent hover:text-accent-hover"
              >
                Privacy Policy
              </Link>
              .
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setConsent("denied")}
              >
                Reject
              </Button>
              <Button size="sm" onClick={() => setConsent("granted")}>
                Accept
              </Button>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
