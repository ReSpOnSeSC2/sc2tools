import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Fraunces, Hanken_Grotesk } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { clerkAppearanceBase } from "@/lib/clerk-appearance";
import { CookieBanner } from "@/components/CookieBanner";
import { GoogleAnalytics } from "@/components/analytics/GoogleAnalytics";
import { Header } from "@/components/chrome/Header";
import { Footer } from "@/components/chrome/Footer";
import { ServiceWorkerRegister } from "@/components/pwa/ServiceWorkerRegister";
import { ToastProvider } from "@/components/ui/Toast";
import "./globals.css";

/**
 * Inter, self-hosted at build time via next/font (no render-blocking
 * Google Fonts request, no layout shift). Exposed as the `--font-sans`
 * CSS variable that tailwind.config.ts reads for `fontFamily.sans`, so
 * the whole app actually renders in Inter instead of falling back to
 * system-ui. `display: "swap"` keeps text visible during font load.
 */
/**
 * "Courtside" type system (adapted from RallyReady):
 *   - Hanken Grotesk — clean humanist body/UI face (--font-sans)
 *   - Bricolage Grotesque — confident grotesque DISPLAY face for headings,
 *     wordmark, big numbers (--font-display)
 * Both load via next/font (self-hosted at build, no layout shift). Numeric
 * monospace falls back to the system mono stack in tailwind.config.ts.
 */
const sans = Hanken_Grotesk({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
});

const display = Bricolage_Grotesque({
  subsets: ["latin"],
  display: "swap",
  weight: ["600", "700", "800"],
  variable: "--font-display",
});

/**
 * Editorial serif — Fraunces. Deliberately NOT a third grotesque: the
 * landing page pairs ONE sans (Hanken, body/UI) with ONE serif (Fraunces,
 * headlines) instead of the two-sans default that gives AI-built sites
 * their tell. Exposed as `--font-serif` and read by `fontFamily.serif`
 * in tailwind.config.ts; only the marketing landing page opts into it, so
 * the rest of the app keeps the established grotesque display voice.
 */
const serif = Fraunces({
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500", "600", "700"],
  style: ["normal", "italic"],
  variable: "--font-serif",
});

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://sc2tools.com";
const SITE_TITLE = "SC2 Tools — opponent intel, build orders, live overlay";
const SITE_DESCRIPTION =
  "Sign in, install the agent, and your StarCraft II opponents tab loads in seconds — across every device.";

export const metadata: Metadata = {
  // Resolves relative OG/Twitter image URLs (incl. the per-page ones) to
  // absolute URLs. Without this, social cards point at localhost.
  metadataBase: new URL(SITE_URL),
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  applicationName: "SC2 Tools",
  appleWebApp: {
    capable: true,
    title: "SC2 Tools",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: [
      { url: "/icons/pwa/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/pwa/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/pwa/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  openGraph: {
    type: "website",
    siteName: "SC2 Tools",
    url: "/",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: [
      {
        url: "/og.jpg",
        width: 1200,
        height: 630,
        alt: "SC2 Tools — StarCraft II opponent intel and build orders",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: ["/og.jpg"],
  },
};

export const viewport: Viewport = {
  themeColor: "#06090e",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

/**
 * No-flash theme bootstrap. Runs synchronously in <head> before paint
 * so data-theme is set before the first style resolution. Keeping it
 * inline (and minimal) avoids any FOUC even on slow networks.
 */
const NO_FLASH_THEME_SCRIPT = `(function(){try{var s=localStorage.getItem('sc2tools.theme');var m=window.matchMedia('(prefers-color-scheme: light)').matches;var t=s==='light'||s==='dark'?s:(m?'light':'dark');document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ClerkProvider appearance={clerkAppearanceBase}>
      <html
        lang="en"
        data-theme="dark"
        className={`${sans.variable} ${display.variable} ${serif.variable}`}
        suppressHydrationWarning
      >
        <head>
          <script
            // Synchronous theme bootstrap — must run before paint.
            dangerouslySetInnerHTML={{ __html: NO_FLASH_THEME_SCRIPT }}
          />
        </head>
        <body className="flex min-h-dvh flex-col overflow-x-clip">
          {/* Single app-wide toast context — every surface can call
              useToast() without remembering to mount its own provider. */}
          <ToastProvider>
            <Header />
            <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6 lg:px-8">
              {children}
            </main>
            <Footer />
            <CookieBanner />
            <GoogleAnalytics />
            <ServiceWorkerRegister />
          </ToastProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}
