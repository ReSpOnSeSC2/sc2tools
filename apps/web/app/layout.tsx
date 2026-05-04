import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import Link from "next/link";
import { SignedIn, SignedOut, UserButton } from "@clerk/nextjs";
import "./globals.css";

export const metadata: Metadata = {
  title: "SC2 Tools — opponent intel, build orders, live overlay",
  description:
    "Sign in, install the agent, and your StarCraft II opponents tab loads in seconds — across every device.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body>
          <header className="border-b border-border">
            <nav className="mx-auto flex max-w-6xl items-center gap-6 px-5 py-4">
              <Link href="/" className="font-semibold text-text">
                SC2 Tools
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
              <Link href="/download" className="text-text-muted hover:text-text">
                Download agent
              </Link>
              <span className="ml-auto" />
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
          <footer className="mx-auto max-w-6xl px-5 py-10 text-sm text-text-dim">
            <p>
              SC2 Tools is not affiliated with Blizzard Entertainment.
              StarCraft II is a trademark of its respective owners.
            </p>
          </footer>
        </body>
      </html>
    </ClerkProvider>
  );
}
