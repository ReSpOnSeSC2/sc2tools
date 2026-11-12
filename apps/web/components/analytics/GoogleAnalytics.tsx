"use client";

import { Suspense, useEffect, useState, useSyncExternalStore } from "react";
import Script from "next/script";
import { usePathname, useSearchParams } from "next/navigation";

import {
  GA_MEASUREMENT_ID,
  isAnalyticsConfigured,
  readConsent,
  subscribeConsent,
} from "@/lib/analytics/consent";
import { analyticsPageState, pageview } from "@/lib/analytics/gtag";
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
 * gtag.js, then the init script and the trackers. The trackers' effects
 * run after the init script's, so ``window.gtag`` exists by then.
 * AppShell does not mount this component on untracked surfaces.
 */
function GaScripts() {
  return (
    <>
      <Script
        src={`https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`}
        strategy="afterInteractive"
      />
      <Suspense fallback={null}>
        <PageViewTracker />
      </Suspense>
      <SignUpTracker />
    </>
  );
}

/**
 * The init script: gtag's queue, the consent defaults, the page, then
 * ``config``.
 *
 * The page (normalized location and referrer, lib/analytics/pageLocation)
 * is stated BEFORE ``config``: gtag.js reads the browser's address the
 * moment it is configured, and an event it raises right then would carry
 * the raw one.
 *
 * The page comes from the router, never from ``window.location``. While
 * a client-side navigation renders, the browser is still on the page
 * being left, and that can be one that must not be reported at all (this
 * component first mounts on the way out of an admin screen or a shared
 * replay archive). next/script runs the script once per page load, so
 * the page stated is the one first rendered.
 *
 * It is written as a JSON literal with ``<`` escaped, so no address can
 * close the script element.
 */
function GaInit({ pathname, search }: { pathname: string; search: string }) {
  const [pageState] = useState(() =>
    JSON.stringify(analyticsPageState(pathname, search)).replace(/</g, "\\u003c"),
  );
  return (
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
          gtag('set', ${pageState});
          // Route changes are tracked manually by <PageViewTracker>, so
          // disable gtag's automatic page_view to avoid double counting.
          gtag('config', '${GA_MEASUREMENT_ID}', Object.assign({
            send_page_view: false,
            anonymize_ip: true
          }, sc2toolsInternal ? { traffic_type: '${INTERNAL_TRAFFIC_TYPE}' } : {}));
      `}
    </Script>
  );
}

/** A query string as ``pageview`` and the init script take it: "?a=b" or "". */
function toSearch(searchParams: { toString(): string } | null): string {
  const query = searchParams?.toString();
  return query ? `?${query}` : "";
}

/**
 * Configures gtag for the page the router is showing (``GaInit``), then
 * fires a ``page_view`` on every App Router navigation. Split out (and
 * Suspense-wrapped) because ``useSearchParams`` opts the subtree into
 * client-side rendering; keeping it isolated avoids forcing the whole
 * layout to do so. ``pageview`` normalizes the location, keeps gtag's
 * page state on it for the automatic events that follow, and skips
 * untracked surfaces (lib/analytics/pageLocation).
 *
 * The init script is a child, so its effect (which defines
 * ``window.gtag``) runs before the first ``pageview`` here.
 */
function PageViewTracker() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (!pathname) return;
    pageview(pathname, toSearch(searchParams));
  }, [pathname, searchParams]);

  return pathname ? <GaInit pathname={pathname} search={toSearch(searchParams)} /> : null;
}
