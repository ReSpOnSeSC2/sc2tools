import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { AppShell } from "@/app/AppShell";
import "./globals.css";

/**
 * "Courtside" type system (adapted from RallyReady):
 *   - Hanken Grotesk — clean humanist body/UI face (--font-sans)
 *   - Bricolage Grotesque — confident grotesque DISPLAY face for headings,
 *     wordmark, big numbers (--font-display)
 * Both are committed Latin WOFF2 files loaded through next/font/local, so a
 * production build never depends on Google Fonts being reachable. Numeric
 * monospace uses the system mono stack in tailwind.config.ts.
 */
const sans = localFont({
  src: "./fonts/hanken-grotesk-latin.woff2",
  display: "swap",
  weight: "100 900",
  style: "normal",
  adjustFontFallback: "Arial",
  variable: "--font-sans",
});

const display = localFont({
  src: "./fonts/bricolage-grotesque-latin.woff2",
  display: "swap",
  weight: "600 800",
  style: "normal",
  adjustFontFallback: "Arial",
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
const serif = localFont({
  src: [
    {
      path: "./fonts/fraunces-latin-normal.woff2",
      weight: "400 700",
      style: "normal",
    },
    {
      path: "./fonts/fraunces-latin-italic.woff2",
      weight: "400 700",
      style: "italic",
    },
  ],
  display: "swap",
  adjustFontFallback: "Times New Roman",
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
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
