"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { SignedIn, SignedOut, UserButton } from "@clerk/nextjs";
import { Menu } from "lucide-react";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { MobileNav, type MobileNavLink } from "./MobileNav";

/**
 * Header — sticky site chrome shared by every authed and public page.
 *
 *   - 56px tall on mobile, 64px on ≥sm.
 *   - data-scrolled toggles a denser background + blur once the user
 *     has moved past the very top of the page (purely cosmetic; the
 *     header is sticky regardless).
 *   - The hamburger opens MobileNav (also includes a ThemeToggle so
 *     touch users keep parity with desktop).
 */

const NAV_LINKS: readonly MobileNavLink[] = [
  { href: "/app", label: "Dashboard", auth: "in" },
  { href: "/builds", label: "Builds", auth: "in" },
  { href: "/community", label: "Community", auth: "any" },
  { href: "/streaming", label: "Streaming", auth: "in" },
  { href: "/settings", label: "Settings", auth: "in" },
];

function isActiveLink(href: string, pathname: string): boolean {
  if (href === pathname) return true;
  return pathname.startsWith(href + "/");
}

export function Header() {
  const pathname = usePathname() ?? "/";
  const [scrolled, setScrolled] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 4);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Close the drawer whenever the route changes — without this a tap
  // on a nav link leaves the overlay stuck open during the transition.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  return (
    <>
      <header
        data-scrolled={scrolled || undefined}
        className={[
          "sticky top-0 z-40 w-full border-b border-border bg-bg/80",
          "motion-safe:transition-[background-color,backdrop-filter] motion-safe:duration-150",
          "data-[scrolled]:bg-bg/90 data-[scrolled]:supports-[backdrop-filter]:backdrop-blur-md",
          "pt-[env(safe-area-inset-top,0px)]",
        ].join(" ")}
      >
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4 sm:h-16 sm:gap-4 sm:px-6 lg:px-8">
          <Brand />
          <nav
            className="hidden items-center gap-0.5 lg:flex"
            aria-label="Primary"
          >
            {NAV_LINKS.map((link) => {
              const active = isActiveLink(link.href, pathname);
              const node = (
                <NavLink
                  key={link.href}
                  href={link.href}
                  label={link.label}
                  active={active}
                />
              );
              if (link.auth === "in") {
                return <SignedIn key={link.href}>{node}</SignedIn>;
              }
              return node;
            })}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <div className="hidden lg:block">
              <ThemeToggle />
            </div>
            <SignedOut>
              <div className="hidden items-center gap-2 lg:flex">
                <Link href="/sign-in" className={SECONDARY_LINK_CLS}>
                  Sign in
                </Link>
                <Link href="/sign-up" className={PRIMARY_LINK_CLS}>
                  Get started
                </Link>
              </div>
            </SignedOut>
            <SignedIn>
              <UserButton
                afterSignOutUrl="/"
                appearance={{
                  elements: {
                    avatarBox: "h-9 w-9",
                  },
                }}
              />
            </SignedIn>
            <button
              type="button"
              aria-label="Open menu"
              aria-expanded={drawerOpen}
              aria-controls="mobile-nav-drawer"
              onClick={() => setDrawerOpen(true)}
              className={[
                "inline-flex h-11 w-11 items-center justify-center rounded-lg",
                "border border-border bg-bg-elevated text-text-muted",
                "hover:bg-bg-subtle hover:text-text",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
                "lg:hidden",
              ].join(" ")}
            >
              <Menu className="h-5 w-5" aria-hidden />
            </button>
          </div>
        </div>
      </header>
      <MobileNav
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        pathname={pathname}
        links={NAV_LINKS}
      />
    </>
  );
}

const SECONDARY_LINK_CLS = [
  "inline-flex h-9 items-center rounded-lg border border-border bg-bg-elevated px-3",
  "text-caption font-medium text-text",
  "hover:bg-bg-subtle hover:border-border-strong",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
].join(" ");

const PRIMARY_LINK_CLS = [
  "inline-flex h-9 items-center rounded-lg bg-accent px-3",
  "text-caption font-semibold text-white",
  "hover:bg-accent-hover",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
].join(" ");

function Brand() {
  return (
    <Link
      href="/"
      aria-label="SC2 Tools — home"
      className="group flex items-center gap-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
    >
      <Image
        src="/logo.png"
        alt=""
        width={28}
        height={28}
        className="rounded-full motion-safe:transition-shadow motion-safe:duration-150 group-hover:shadow-[0_0_18px_var(--halo-cyan)] group-focus-visible:shadow-[0_0_18px_var(--halo-cyan)]"
        priority
      />
      <span className="text-body font-semibold tracking-tight text-text motion-safe:transition-colors motion-safe:duration-150 group-hover:text-accent-cyan group-focus-visible:text-accent-cyan">
        SC2 Tools
      </span>
    </Link>
  );
}

interface NavLinkProps {
  href: string;
  label: string;
  active: boolean;
}

function NavLink({ href, label, active }: NavLinkProps) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={[
        "relative inline-flex h-9 items-center rounded-md px-3 text-caption font-medium",
        "motion-safe:transition-colors motion-safe:duration-150",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
        active
          ? "text-accent"
          : "text-text-muted hover:bg-bg-elevated hover:text-text",
      ].join(" ")}
    >
      {label}
      {active ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-3 -bottom-[1px] h-[2px] rounded-full bg-accent"
        />
      ) : null}
    </Link>
  );
}
