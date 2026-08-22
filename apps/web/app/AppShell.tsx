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

const MAIN_CLASS =
  "mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6 lg:px-8";

/** /app and everything under it renders inside its own chrome (AppChrome). */
function isAppChromeRoute(pathname: string | null): boolean {
  if (!pathname) return false;
  return pathname === "/app" || pathname.startsWith("/app/");
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
 * `/app/*` routes own their chrome: the app layout mounts the rail, context
 * bar and mobile tab bar, so the marketing Header/Footer and the constrained
 * <main> wrapper are omitted for them — only the providers and site-wide
 * concerns (cookies, analytics, service worker) remain.
 *
 * All other routes retain the existing Clerk + site-shell composition. A null
 * pathname is treated conservatively as a normal route so authentication is
 * never skipped while the router is becoming ready.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const isTokenSurface = isTokenAuthRoute(pathname);

  if (isTokenSurface) {
    return (
      <ToastProvider>
        <main id="main-content" className={MAIN_CLASS}>
          {children}
        </main>
      </ToastProvider>
    );
  }

  if (isAppChromeRoute(pathname)) {
    return (
      <ClerkProvider appearance={clerkAppearanceBase}>
        <ToastProvider>
          {children}
          <CookieBanner />
          <GoogleAnalytics />
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
        <GoogleAnalytics />
        <ServiceWorkerRegister />
      </ToastProvider>
    </ClerkProvider>
  );
}
