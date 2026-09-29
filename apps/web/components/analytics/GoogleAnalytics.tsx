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
import {
  INTERNAL_TRAFFIC_STORAGE_KEY,
  INTERNAL_TRAFFIC_TYPE,
} from "@/lib/analytics/internalTraffic";
import { InternalTrafficMarker, SignUpTracker } from "./AnalyticsSignals";

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
 *
 * ``InternalTrafficMarker`` runs regardless of consent: it only sets a
 * local flag on admin browsers (no Google request), so the init script
 * can tag that browser's events as internal from the first one.
 */
export function GoogleAnalytics() {
  const consent = useSyncExternalStore(
    subscribeConsent,
    readConsent,
    () => "unset" as const,
  );

  if (!isAnalyticsConfigured()) return null;

  return (
    <>
      <InternalTrafficMarker />
      {consent === "granted" ? <GaScripts /> : null}
    </>
  );
}

/**
 * gtag.js + config, then the trackers. The trackers render after the
 * scripts so their effects run once ``window.gtag`` exists.
 */
function GaScripts() {
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
          // Admin browsers (lib/analytics/internalTraffic) tag every event,
          // GA's automatic ones included, for the Internal Traffic filter.
          var sc2toolsInternal = false;
          try { sc2toolsInternal = localStorage.getItem('${INTERNAL_TRAFFIC_STORAGE_KEY}') === '1'; } catch (e) {}
          if (sc2toolsInternal) gtag('set', { traffic_type: '${INTERNAL_TRAFFIC_TYPE}' });
          // Route changes are tracked manually by <PageViewTracker>, so
          // disable gtag's automatic page_view to avoid double counting.
          gtag('config', '${GA_MEASUREMENT_ID}', Object.assign({
            send_page_view: false,
            anonymize_ip: true
          }, sc2toolsInternal ? { traffic_type: '${INTERNAL_TRAFFIC_TYPE}' } : {}));
        `}
      </Script>
      <Suspense fallback={null}>
        <PageViewTracker />
      </Suspense>
      <SignUpTracker />
    </>
  );
}

/**
 * Fires a ``page_view`` on every App Router navigation. Split out (and
 * Suspense-wrapped) because ``useSearchParams`` opts the subtree into
 * client-side rendering; keeping it isolated avoids forcing the whole
 * layout to do so. ``pageview`` normalizes the location and skips
 * untracked surfaces (lib/analytics/pageLocation).
 */
function PageViewTracker() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (!pathname) return;
    const query = searchParams?.toString();
    pageview(pathname, query ? `?${query}` : "");
  }, [pathname, searchParams]);

  return null;
}
