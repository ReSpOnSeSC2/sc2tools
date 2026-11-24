import { RAIL_BOOTSTRAP } from "@/components/chrome/railPreference";
import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { AppShell } from "@/app/AppShell";
import { siteVerification } from "@/lib/siteVerification";
import { SITE_TITLE_TEMPLATE } from "@/lib/siteTitle";
import { NO_FLASH_THEME_SCRIPT, THEME_COLORS } from "@/lib/theme";
import { NO_FLASH_APPEARANCE_SCRIPT } from "@/lib/appearance";
import { ThemeSync } from "@/components/ui/ThemeSync";
import "./globals.css";

/**
 * Command Glass type system: one variable family, Hanken Grotesk
 * (100-900), for body, UI, headings, the wordmark and big numbers
 * (--font-sans; `font-display` is the same family at heavier weights with
 * tighter tracking). It is a committed Latin WOFF2 loaded through
 * next/font/local, so a production build never depends on Google Fonts and
 * every route preloads exactly one font file. Numeric monospace uses the
 * platform mono stack in tailwind.config.ts. See ADR 0099.
 */
const sans = localFont({
  src: "./fonts/hanken-grotesk-latin.woff2",
  display: "swap",
  weight: "100 900",
  style: "normal",
  adjustFontFallback: "Arial",
  variable: "--font-sans",
});

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://sc2tools.com";
const SITE_TITLE = "SC2 Tools — replay analysis, build coaching & Stream Studio";
const SITE_DESCRIPTION =
  "Turn every StarCraft II replay into opponent intel, a 3D match review, build coaching, personal trends, and a complete OBS production suite.";

export const metadata: Metadata = {
  // Resolves relative OG/Twitter image URLs (incl. the per-page ones) to
  // absolute URLs. Without this, social cards point at localhost.
  metadataBase: new URL(SITE_URL),
  // Pages set only their own name; the template adds the brand
  // ("Settings · SC2 Tools"). See lib/siteTitle.ts.
  title: { default: SITE_TITLE, template: SITE_TITLE_TEMPLATE },
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
        alt: "SC2 Tools — StarCraft II replay analysis, coaching, and Stream Studio",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: ["/og.jpg"],
  },
  // Search Console ownership tag, only when NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION is set.
  verification: siteVerification(),
};

export const viewport: Viewport = {
  themeColor: [{ media: "(prefers-color-scheme: light)", color: THEME_COLORS.light }, { media: "(prefers-color-scheme: dark)", color: THEME_COLORS.dark }],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

/**
 * No-flash theme bootstrap. Runs synchronously in <head> before paint
 * so data-theme is set before the first style resolution. Keeping it
 * inline (and minimal) avoids any FOUC even on slow networks.
 */

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      data-theme="dark"
      className={sans.variable}
      suppressHydrationWarning
    >
      <head>
        <script
          // Synchronous theme bootstrap — must run before paint.
          dangerouslySetInnerHTML={{ __html: NO_FLASH_THEME_SCRIPT + NO_FLASH_APPEARANCE_SCRIPT + RAIL_BOOTSTRAP }}
        />
      </head>
      <body className="flex min-h-dvh flex-col overflow-x-clip">
        <ThemeSync />
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
