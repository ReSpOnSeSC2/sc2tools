import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import Link from "next/link";
import Image from "next/image";
import { SignedIn, SignedOut, UserButton } from "@clerk/nextjs";
import { CookieBanner } from "@/components/CookieBanner";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
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
        <body>
          <header className="border-b border-border">
            <nav className="mx-auto flex max-w-6xl items-center gap-6 px-5 py-4">
              <Link
                href="/"
                className="flex items-center gap-2 font-semibold text-text"
              >
                <Image
                  src="/logo.png"
                  alt=""
                  width={28}
                  height={28}
                  className="rounded-full shadow-[0_0_10px_var(--halo-cyan)]"
                  priority
                />
                <span>SC2 Tools</span>
              </Link>
              <SignedIn>
                <Link href="/app" className="text-text-muted hover:text-text">
                  Analyzer
                </Link>
                <Link href="/devices" className="text-text-muted hover:text-text">
                  Devices
                </Link>
                <Link href="/streaming" className="text-text-muted hover:text-text">
                  Streaming
                </Link>
                <Link href="/builds" className="text-text-muted hover:text-text">
                  Builds
                </Link>
              </SignedIn>
              <Link href="/community" className="text-text-muted hover:text-text">
                Community
              </Link>
              <Link href="/download" className="text-text-muted hover:text-text">
                Download agent
              </Link>
              <span className="ml-auto" />
              <ThemeToggle />
              <SignedOut>
                <Link href="/sign-in" className="btn btn-secondary">
                  Sign in
                </Link>
              </SignedOut>
              <SignedIn>
                <UserButton afterSignOutUrl="/" />
              </SignedIn>
            </nav>
          </header>
          <main className="mx-auto max-w-6xl px-5 py-8">{children}</main>
          <footer className="mx-auto max-w-6xl space-y-2 px-5 py-10 text-sm text-text-dim">
            <p>
              SC2 Tools is not affiliated with Blizzard Entertainment.
              StarCraft II is a trademark of its respective owners.
            </p>
            <p className="space-x-3">
              <Link href="/legal/privacy" className="underline">
                Privacy
              </Link>
              <Link href="/legal/terms" className="underline">
                Terms
              </Link>
              <a
                href="https://status.sc2tools.app"
                rel="noopener"
                className="underline"
              >
                Status
              </a>
            </p>
          </footer>
          <CookieBanner />
        </body>
      </html>
    </ClerkProvider>
  );
}
