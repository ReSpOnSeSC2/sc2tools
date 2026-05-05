"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Cookie } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";

const STORAGE_KEY = "sc2tools.cookieConsent.v1";

/**
 * Cookie banner — shown until the visitor acknowledges.
 *
 * We only set strictly-necessary cookies (Clerk session + this consent
 * record), so this banner is informational. The "decline by default"
 * posture is implicit: nothing beyond strictly-necessary is ever set,
 * with or without acknowledgement. The OK action just dismisses the
 * notice.
 *
 * Storage uses localStorage (NOT a cookie) so a still-unconsented
 * first paint doesn't risk a re-flash of the banner itself.
 *
 * Layout:
 *   - Mobile: full-width sheet pinned to the bottom, inset by
 *     safe-area-inset-bottom so it clears the iOS home indicator.
 *   - ≥sm: floats as a card in the bottom-right corner.
 */
export function CookieBanner() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    try {
      const v = window.localStorage.getItem(STORAGE_KEY);
      if (v !== "ack") setShow(true);
    } catch {
      setShow(true);
    }
  }, []);

  if (!show) return null;

  function ack() {
    try {
      window.localStorage.setItem(STORAGE_KEY, "ack");
    } catch {
      // Private browsing / quota — ignore. The banner closes either way.
    }
    setShow(false);
  }

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
              Strictly necessary cookies only
            </p>
            <p id="cookie-body" className="text-caption text-text-muted">
              SC2 Tools uses session cookies to keep you signed in. We don&apos;t
              run ads or third-party trackers. See our{" "}
              <Link
                href="/legal/privacy"
                className="font-medium text-accent hover:text-accent-hover"
              >
                Privacy Policy
              </Link>{" "}
              for details.
            </p>
            <div className="flex justify-end pt-1">
              <Button size="sm" onClick={ack}>
                Got it
              </Button>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
