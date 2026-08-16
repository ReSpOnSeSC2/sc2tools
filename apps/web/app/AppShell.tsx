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

/**
 * Chooses the browser surface before mounting Clerk or normal site chrome.
 *
 * `/overlay/*` and `/dock/*` use the token in the URL as their credential.
 * Keeping their branch outside ClerkProvider means ClerkJS is never loaded for
 * an OBS source and a missing/blocked Clerk script cannot blank the broadcast.
 * The toast context remains available because dock controls use the same app
 * primitives as the signed-in site.
 *
 * All other routes retain the existing Clerk + site-shell composition. A null
 * pathname is treated conservatively as a normal route so authentication is
 * never skipped while the router is becoming ready.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const isTokenSurface = isTokenAuthRoute(usePathname());

  if (isTokenSurface) {
    return (
      <ToastProvider>
        <main className={MAIN_CLASS}>{children}</main>
      </ToastProvider>
    );
  }

  return (
    <ClerkProvider appearance={clerkAppearanceBase}>
      <ToastProvider>
        <Header />
        <main className={MAIN_CLASS}>{children}</main>
        <Footer />
        <CookieBanner />
        <GoogleAnalytics />
        <ServiceWorkerRegister />
      </ToastProvider>
    </ClerkProvider>
  );
}
