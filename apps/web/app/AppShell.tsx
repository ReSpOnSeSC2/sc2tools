"use client";

import type { ReactNode } from "react";
import { ClerkProvider } from "@clerk/nextjs";
import { usePathname } from "next/navigation";
import { CookieBanner } from "@/components/CookieBanner";
import { GoogleAnalytics } from "@/components/analytics/GoogleAnalytics";
import { Header } from "@/components/chrome/Header";
import { Footer } from "@/components/chrome/Footer";
import { ServiceWorkerRegister } from "@/components/pwa/ServiceWorkerRegister";
import { ToastProvider } from "@/components/ui/Toast";
import { clerkAppearanceBase } from "@/lib/clerk-appearance";
import { isTokenAuthRoute } from "@/lib/tokenAuthRoutes";
import { AppChrome } from "@/components/chrome/AppChrome";
import { isAppSurfacePath } from "@/components/chrome/appNav";

const MAIN_CLASS =
  "mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6 lg:px-8";

/**
 * Public replay URLs contain an opaque capability token. Never mount analytics
 * on those routes so the token (or replay filters in the query string) cannot
 * be disclosed to the analytics provider as page-view metadata.
 */
function isPublicReplayRoute(pathname: string | null): boolean {
  return Boolean(pathname && /^\/p\/[^/]+\/replays(?:\/|$)/.test(pathname));
}

/**
 * Chooses the browser surface before mounting Clerk or normal site chrome.
 *
 * `/overlay/*` and `/dock/*` use the token in the URL as their credential.
 * Keeping their branch outside ClerkProvider means ClerkJS is never loaded for
 * an OBS source and a missing/blocked Clerk script cannot blank the broadcast.
 * The toast context remains available because dock controls use the same app
 * primitives as the signed-in site.
 *
 * Every signed-in surface — /app, /builds, /meta, /community, /devices,
 * /settings, /admin — renders inside AppChrome instead: one rail, one context
 * bar, and a mobile tab bar in place of the marketing hamburger. The chrome
 * supplies its own <main>, so the Header/Footer pair and the constrained
 * wrapper are omitted there; site-wide concerns (cookies, analytics, service
 * worker) still apply.
 *
 * All other routes retain the existing Clerk + site-shell composition. A null
 * pathname is treated conservatively as a normal route so authentication is
 * never skipped while the router is becoming ready.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const isTokenSurface = isTokenAuthRoute(pathname);
  const analyticsAllowed = !isPublicReplayRoute(pathname);

  if (isTokenSurface) {
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
        <ToastProvider>
          <a
            href="#main-content"
            className="sr-only z-[100] rounded-md bg-bg-surface px-4 py-3 font-semibold text-text shadow-hard focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:outline-none focus:ring-2 focus:ring-accent"
          >
            Skip to content
          </a>
          <AppChrome>{children}</AppChrome>
          <CookieBanner />
          {analyticsAllowed ? <GoogleAnalytics /> : null}
          <ServiceWorkerRegister />
        </ToastProvider>
      </ClerkProvider>
    );
  }

  return (
    <ClerkProvider appearance={clerkAppearanceBase}>
      <ToastProvider>
        <a
          href="#main-content"
          className="sr-only z-[100] rounded-md bg-bg-surface px-4 py-3 font-semibold text-text shadow-hard focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:outline-none focus:ring-2 focus:ring-accent"
        >
          Skip to content
        </a>
        <Header />
        <main id="main-content" tabIndex={-1} className={MAIN_CLASS}>
          {children}
        </main>
        <Footer />
        <CookieBanner />
        {analyticsAllowed ? <GoogleAnalytics /> : null}
        <ServiceWorkerRegister />
      </ToastProvider>
    </ClerkProvider>
  );
}
