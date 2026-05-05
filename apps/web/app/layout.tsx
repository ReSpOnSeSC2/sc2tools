import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { CookieBanner } from "@/components/CookieBanner";
import { Header } from "@/components/chrome/Header";
import { Footer } from "@/components/chrome/Footer";
import "./globals.css";

export const metadata: Metadata = {
  title: "SC2 Tools — opponent intel, build orders, live overlay",
  description:
    "Sign in, install the agent, and your StarCraft II opponents tab loads in seconds — across every device.",
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
    <ClerkProvider>
      <html lang="en" data-theme="dark" suppressHydrationWarning>
        <head>
          <script
            // Synchronous theme bootstrap — must run before paint.
            dangerouslySetInnerHTML={{ __html: NO_FLASH_THEME_SCRIPT }}
          />
        </head>
        <body className="flex min-h-dvh flex-col">
          <Header />
          <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6 lg:px-8">
            {children}
          </main>
          <Footer />
          <CookieBanner />
        </body>
      </html>
    </ClerkProvider>
  );
}
