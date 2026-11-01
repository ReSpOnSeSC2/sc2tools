"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AuthContextLink } from "@/components/auth/AuthContextLink";
import { usePathname } from "next/navigation";
import { SignedIn, SignedOut, UserButton } from "@clerk/nextjs";
import { Menu, Monitor } from "lucide-react";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { LinkButton, buttonClasses } from "@/components/ui/Button";
import { ThemeDialog } from "@/components/ui/ThemeChoice";
import { useApi } from "@/lib/clientApi";
import { MobileNav } from "./MobileNav";
import { NavAuthGate } from "./NavAuthGate";
import { CoachingBookingAlert } from "./CoachingBookingAlert";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { reviewsVisible } from "@/lib/reviews";
import { guidesEnabled } from "@/lib/guides/flags";
import { getInstantImportMode } from "@/lib/instant/flag";
import { headerLinkCommands, headerNavLinks } from "./headerNav";
import { signedInCommandNavigation } from "./headerCommandNavigation";
import { LogoMark } from "./LogoMark";
import { useCommandChrome, useCommandSearch } from "./CommandSearchContext";
import { CommandSearchButton } from "./CommandSearchButton";

/**
 * Header — sticky site chrome shared by every authed and public page.
 *
 *   - 56px tall on mobile, 64px on ≥sm.
 *   - data-scrolled toggles a denser background + blur once the user
 *     has moved past the very top of the page (purely cosmetic; the
 *     header is sticky regardless).
 *   - The hamburger opens MobileNav (also includes a ThemeToggle so
 *     touch users keep parity with desktop).
 *   - The "Admin" link is appended only when /v1/me reports the
 *     signed-in user is on SC2TOOLS_ADMIN_USER_IDS. SWR dedupes the
 *     /me call against the rest of the SPA so this costs nothing.
 *   - Signed-out visitors get the public pages plus Sign in / Get
 *     started; signed-in players get their own links plus an
 *     "Open app" pill to /app.
 */

type MeAdminProbe = { isAdmin?: boolean };

function isActiveLink(href: string, pathname: string): boolean {
  if (href === pathname) return true;
  return pathname.startsWith(href + "/");
}

export function Header() {
  const pathname = usePathname() ?? "/";
  const [scrolled, setScrolled] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const accountRef = useRef<HTMLSpanElement>(null);
  // useApi gates on isSignedIn internally, so this fetch is a no-op
  // for signed-out visitors — they never see the Admin link anyway.
  const { data: me } = useApi<MeAdminProbe>("/v1/me");
  const isAdmin = me?.isAdmin;
  const navLinks = useMemo(() => headerNavLinks({
    guides: guidesEnabled(),
    reviews: reviewsVisible(isAdmin),
    isAdmin: isAdmin === true,
    tryPage: getInstantImportMode() === "all",
  }), [isAdmin]);
  const commandSearch = useCommandSearch(), commandOwner = commandSearch?.ownerKey ?? null, signedIn = Boolean(commandOwner);
  // Signed in, the app's own sections (Today, Opponents, ...); for visitors,
  // the header's public links. Registered once per change, not per render:
  // each registration records Recent.
  const commandChrome = useMemo(() => ({ ownerKey: commandOwner, defaultSettingsAvailable: signedIn,
    navigation: commandOwner
      ? signedInCommandNavigation({ isAdmin: isAdmin === true, reviews: reviewsVisible(isAdmin), guides: guidesEnabled() })
      : headerLinkCommands(navLinks, { signedIn: false, isAdmin: false }) }),
  [commandOwner, signedIn, isAdmin, navLinks]);
  useCommandChrome(commandChrome);

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
          "sticky top-0 z-40 w-full border-b-2 border-line bg-bg/85",
          "relative",
          "motion-safe:transition-[background-color,backdrop-filter] motion-safe:duration-150",
          "data-[scrolled]:bg-bg/95 data-[scrolled]:supports-[backdrop-filter]:backdrop-blur-md",
          "pt-[env(safe-area-inset-top,0px)]",
        ].join(" ")}
      >
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4 sm:h-16 sm:gap-4 sm:px-6 lg:px-8">
          <Brand />
          <nav
            className="hidden items-center gap-0.5 lg:flex"
            aria-label="Primary"
          >
            {navLinks.map((link) => (
              <NavAuthGate key={`${link.auth}:${link.href}`} auth={link.auth}>
                <NavLink
                  href={link.href}
                  label={link.label}
                  active={isActiveLink(link.href, pathname)}
                  wideOnly={link.wideOnly}
                />
              </NavAuthGate>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <CommandSearchButton iconOnly className="inline-flex" />
            <SignedIn>
              <CoachingBookingAlert />
              <NotificationBell />
            </SignedIn>
            <div className="hidden lg:block">
              <ThemeToggle />
            </div>
            <SignedOut>
              <div className="hidden items-center gap-2 lg:flex">
                <AuthContextLink kind="sign-in" className={buttonClasses({ variant: "secondary", size: "sm" })}>
                  Sign in
                </AuthContextLink>
                <AuthContextLink kind="sign-up" className={buttonClasses({ variant: "primary", size: "sm" })}>
                  Get started
                </AuthContextLink>
              </div>
            </SignedOut>
            <SignedIn>
              <div className="hidden lg:block">
                <LinkButton href="/app" variant="primary" size="sm">
                  Open app
                </LinkButton>
              </div>
              <span ref={accountRef} className="inline-flex"><UserButton
                afterSignOutUrl="/"
                appearance={{
                  elements: {
                    avatarBox: "h-9 w-9",
                  },
                }}
              ><UserButton.MenuItems>
                <UserButton.Action label="Appearance" labelIcon={<Monitor className="h-4 w-4" aria-hidden />} onClick={() => setAppearanceOpen(true)} />
                <UserButton.Action label="manageAccount" />
                <UserButton.Action label="signOut" />
              </UserButton.MenuItems></UserButton></span>
            </SignedIn>
            <button
              type="button"
              aria-label="Open menu"
              aria-expanded={drawerOpen}
              aria-controls="mobile-nav-drawer"
              onClick={() => setDrawerOpen(true)}
              className={[
                "hard-press inline-flex h-11 w-11 items-center justify-center rounded-full",
                "border-2 border-line bg-bg-surface text-text",
                "hover:bg-bg-elevated",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
                "lg:hidden",
              ].join(" ")}
            >
              <Menu className="h-5 w-5" aria-hidden />
            </button>
          </div>
        </div>
      </header>
      <ThemeDialog open={appearanceOpen} onClose={() => { setAppearanceOpen(false); queueMicrotask(() => accountRef.current?.querySelector<HTMLButtonElement>("button")?.focus()); }} />
      <MobileNav
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        pathname={pathname}
        links={navLinks}
      />
    </>
  );
}

function Brand() {
  return (
    <Link
      href="/"
      aria-label="SC2 Tools — home"
      className="group flex items-center gap-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
    >
      <LogoMark
        size={28}
        className="motion-safe:transition-shadow motion-safe:duration-150 group-hover:shadow-[0_0_18px_var(--halo-cyan)] group-focus-visible:shadow-[0_0_18px_var(--halo-cyan)]"
        priority
      />
      {/* Display-face wordmark + a brand accent tick. */}
      <span className="flex items-center gap-1.5 font-display text-h4 font-extrabold tracking-tight text-text motion-safe:transition-colors motion-safe:duration-150 group-hover:text-accent group-focus-visible:text-accent">
        SC2&nbsp;Tools
        <span
          aria-hidden
          className="h-1.5 w-1.5 rounded-full bg-accent"
        />
      </span>
    </Link>
  );
}

interface NavLinkProps {
  href: string;
  label: string;
  active: boolean;
  /** Hidden below xl, where the row has no room for it. */
  wideOnly?: boolean;
}

function NavLink({ href, label, active, wideOnly = false }: NavLinkProps) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={[
        "relative h-9 items-center whitespace-nowrap rounded-full px-2.5 font-display text-caption font-bold xl:px-3.5",
        wideOnly ? "hidden xl:inline-flex" : "inline-flex",
        "motion-safe:transition-colors motion-safe:duration-150",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
        active
          ? "bg-accent/10 text-accent-cyan"
          : "text-text-muted hover:bg-bg-elevated hover:text-text",
      ].join(" ")}
    >
      {label}
    </Link>
  );
}
