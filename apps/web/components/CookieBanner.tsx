"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

const STORAGE_KEY = "sc2tools.cookieConsent.v1";

/**
 * Minimal first-run cookie banner. We only set strictly-necessary cookies
 * (Clerk session + this consent record), so the banner is informational
 * — there's nothing for the user to opt out of beyond not using the
 * site. Showing the banner is still required by EU/UK rules.
 *
 * Storage: localStorage (NOT a cookie itself), so no first-render flash
 * of the banner before consent is checked.
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
      // Private mode etc — ignore.
    }
    setShow(false);
  }

  return (
    <div
      role="dialog"
      aria-labelledby="cookie-title"
      className="fixed inset-x-0 bottom-0 z-50 border-t border-border bg-bg-surface/95 px-5 py-4 shadow-lg backdrop-blur"
    >
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 text-sm">
        <p id="cookie-title" className="flex-1">
          SC2 Tools uses strictly-necessary cookies to keep you signed in. We
          do not use advertising or tracking cookies. See our{" "}
          <Link href="/legal/privacy" className="underline">
            Privacy Policy
          </Link>{" "}
          for details.
        </p>
        <button type="button" className="btn" onClick={ack}>
          OK, got it
        </button>
      </div>
    </div>
  );
}
