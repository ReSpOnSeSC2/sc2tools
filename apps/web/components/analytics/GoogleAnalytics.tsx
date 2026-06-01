"use client";

import { Suspense, useEffect, useSyncExternalStore } from "react";
import Script from "next/script";
import { usePathname, useSearchParams } from "next/navigation";

import {
  GA_MEASUREMENT_ID,
  isAnalyticsConfigured,
  readConsent,
  subscribeConsent,
} from "@/lib/analytics/consent";
import { pageview } from "@/lib/analytics/gtag";

/**
 * Google Analytics 4 loader — GDPR opt-in.
 *
 * gtag.js is injected ONLY once the visitor has explicitly granted
 * consent (see ``lib/analytics/consent``). Until then this renders
 * nothing, so no Google script, cookie, or network request happens —
 * matching the "strictly necessary by default" promise in the cookie
 * banner and privacy policy.
 *
 * Because consent is a client-only signal we render ``null`` on the
 * server and on the first client paint, then mount the scripts after
 * ``useSyncExternalStore`` reports a granted state. Clicking Accept in
 * the banner flips the store synchronously, so GA loads immediately
 * without a reload.
 */
export function GoogleAnalytics() {
  const consent = useSyncExternalStore(
    subscribeConsent,
    readConsent,
    () => "unset" as const,
  );

  if (!isAnalyticsConfigured() || consent !== "granted") return null;

  return (
    <>
      <Script
        src={`https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`}
        strategy="afterInteractive"
      />
      <Script id="ga4-init" strategy="afterInteractive">
        {`
          window.dataLayer = window.dataLayer || [];
          function gtag(){dataLayer.push(arguments);}
          window.gtag = gtag;
          gtag('js', new Date());
          // Consent Mode v2 — we only reach here after an explicit opt-in,
          // so analytics storage is granted; ad signals stay denied.
          gtag('consent', 'default', {
            ad_storage: 'denied',
            ad_user_data: 'denied',
            ad_personalization: 'denied',
            analytics_storage: 'granted'
          });
          // Route changes are tracked manually by <PageViewTracker>, so
          // disable gtag's automatic page_view to avoid double counting.
          gtag('config', '${GA_MEASUREMENT_ID}', {
            send_page_view: false,
            anonymize_ip: true
          });
        `}
      </Script>
      <Suspense fallback={null}>
        <PageViewTracker />
      </Suspense>
    </>
  );
}

/**
 * Fires a ``page_view`` on every App Router navigation. Split out (and
 * Suspense-wrapped) because ``useSearchParams`` opts the subtree into
 * client-side rendering; keeping it isolated avoids forcing the whole
 * layout to do so.
 */
function PageViewTracker() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (!pathname) return;
    const query = searchParams?.toString();
    pageview(query ? `${pathname}?${query}` : pathname);
  }, [pathname, searchParams]);

  return null;
}
