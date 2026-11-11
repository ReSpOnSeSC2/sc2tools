"use client";

import { useEffect, type ReactNode } from "react";
import { ClerkProvider, SignedIn } from "@clerk/nextjs";
import { usePathname } from "next/navigation";
import { CookieBanner } from "@/components/CookieBanner";
import { GoogleAnalytics } from "@/components/analytics/GoogleAnalytics";
import { Header } from "@/components/chrome/Header";
import { Footer } from "@/components/chrome/Footer";
import { ServiceWorkerRegister } from "@/components/pwa/ServiceWorkerRegister";
import { ToastProvider } from "@/components/ui/Toast";
import { clerkAppearanceBase } from "@/lib/clerk-appearance";
import { isTokenAuthRoute } from "@/lib/tokenAuthRoutes";
import { isPublicStatusRoute } from "@/lib/publicStatusRoute";
import { isReportCardPath } from "@/lib/instant/reportCardRoute";
import { isUntrackedPath } from "@/lib/analytics/pageLocation";
import { syncAnalyticsPage } from "@/lib/analytics/gtag";
import { AppChrome } from "@/components/chrome/AppChrome";
import { isAppSurfacePath } from "@/components/chrome/appNav";
import { SiteStats } from "@/components/chrome/SiteStats";
import { SitePresence } from "@/components/chrome/SitePresence";
import { DeviceHistoryGuard } from "@/components/chrome/DeviceHistoryGuard";
import { RealtimeProvider } from "@/components/realtime/RealtimeProvider";
import { CommandSearchProvider } from "@/components/chrome/CommandSearchProvider";
import { AppearanceAccountSync } from "@/components/chrome/AppearanceAccountSync";
import { applyAppearanceAttributes, readStoredAppearance } from "@/lib/appearance";

const MAIN_CLASS =
  "mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6 lg:px-8";

/**
 * Chooses the browser surface before mounting Clerk or normal site chrome.
 *
 * `/overlay/*` and `/dock/*` use the token in the URL as their credential.
 * Keeping their branch outside ClerkProvider means ClerkJS is never loaded for
 * an OBS source and a missing/blocked Clerk script cannot blank the broadcast.
 * The toast context remains available because dock controls use the same app
 * primitives as the signed-in site.
 * The local year recap and report card viewer share the bare shell so replay data stays on the device.
 *
 * Every signed-in surface — /app, /builds, /community, /devices,
 * /settings, /admin — renders inside AppChrome instead: one rail, one context
 * bar, and a mobile tab bar in place of the marketing hamburger. The chrome
 * supplies its own <main>, so the Header/Footer pair and the constrained
 * wrapper are omitted there; site-wide concerns (cookies, analytics, service
 * worker) still apply.
 *
 * `/status` is standalone too: its public checks and links must remain usable
 * without authentication, app requests or background analytics.
 *
 * All other routes retain the existing Clerk + site-shell composition. A null
 * pathname is treated conservatively as a normal route so authentication is
 * never skipped while the router is becoming ready.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const isTokenSurface = isTokenAuthRoute(pathname);
  // Local replay demos keep browser traffic on the website until Save.
  // Be conservative while the router has not supplied a pathname yet.
  const sameOriginStats = pathname === null || pathname === "/" || pathname === "/try" || pathname.startsWith("/try/");
  // Google Analytics never loads on untracked surfaces: shared replay
  // archives (a player's archive activity is not disclosed to the analytics
  // provider; the /p form remains during the legacy-link redirect window)
  // and the operator-only /admin screens. See lib/analytics/pageLocation.
  const analyticsAllowed = !isUntrackedPath(pathname);
  // gtag.js outlives the page that loaded it. After a client-side move it
  // must report the new page in its normalized form, and go silent on an
  // untracked surface, where <GoogleAnalytics> is no longer mounted to say
  // so. A no-op until analytics is running (lib/analytics/gtag).
  useEffect(() => {
    if (pathname) syncAnalyticsPage(pathname, window.location.search);
  }, [pathname]);
  // Text size and density never apply to OBS sources, even after a
  // client-side move onto one (the head script covers the first load).
  useEffect(() => {
    if (pathname) applyAppearanceAttributes(readStoredAppearance(), pathname);
  }, [pathname]);

  // Reachability checks must work even when authentication or app APIs fail.
  if (isPublicStatusRoute(pathname)) return <>{children}</>;

  if (isTokenSurface || pathname === "/wrapped" || isReportCardPath(pathname)) {
    return (
      <ToastProvider>
        <main id="main-content" className={MAIN_CLASS}>
          {children}
        </main>
      </ToastProvider>
    );
  }

  if (isAppSurfacePath(pathname)) {
    return (
      <ClerkProvider appearance={clerkAppearanceBase}>
        <RealtimeProvider>
        <ToastProvider>
        <CommandSearchProvider>
          <a
            href="#main-content"
            className="sr-only z-[100] rounded-md bg-bg-surface px-4 py-3 font-semibold text-text shadow-hard focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:outline-none focus:ring-2 focus:ring-accent"
          >
            Skip to content
          </a>
          <SitePresence />
          <AppearanceAccountSync />
          <DeviceHistoryGuard />
          <AppChrome>{children}</AppChrome>
          <CookieBanner />
          {analyticsAllowed ? <GoogleAnalytics /> : null}
          <ServiceWorkerRegister />
        </CommandSearchProvider>
        </ToastProvider>
        </RealtimeProvider>
      </ClerkProvider>
    );
  }

  return (
    <ClerkProvider appearance={clerkAppearanceBase}>
      <RealtimeProvider>
      <ToastProvider>
      <CommandSearchProvider>
        <a
          href="#main-content"
          className="sr-only z-[100] rounded-md bg-bg-surface px-4 py-3 font-semibold text-text shadow-hard focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:outline-none focus:ring-2 focus:ring-accent"
        >
          Skip to content
        </a>
        <Header />
        <SignedIn>
          <SitePresence />
          <SiteStats sameOrigin={sameOriginStats} />
        </SignedIn>
        <AppearanceAccountSync />
        <DeviceHistoryGuard />
        <main id="main-content" tabIndex={-1} className={MAIN_CLASS}>
          {children}
        </main>
        <Footer />
        <CookieBanner />
        {analyticsAllowed ? <GoogleAnalytics /> : null}
        <ServiceWorkerRegister />
      </CommandSearchProvider>
      </ToastProvider>
      </RealtimeProvider>
    </ClerkProvider>
  );
}
