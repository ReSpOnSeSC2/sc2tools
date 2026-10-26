"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { AuthContextLink } from "@/components/auth/AuthContextLink";
import { SignedIn, SignedOut } from "@clerk/nextjs";
import { Sheet } from "@/components/ui/Sheet";
import { ThemeChoice } from "@/components/ui/ThemeChoice";
import { LogoMark } from "./LogoMark";
import { NavAuthGate } from "./NavAuthGate";

/**
 * MobileNav — shared right Sheet for the <lg viewport.
 *
 * Behaviors:
 *   - Esc closes
 *   - Scrim click closes
 *   - Focus trap inside the drawer; focus returns to the trigger on close
 *   - Body scroll locked while open
 *   - Closes when the desktop header becomes available
 *   - ThemeChoice in the footer keeps parity with desktop chrome
 */

export type MobileNavLink = {
  href: string;
  label: string;
  /**
   * "in"    — visible when signed in.
   * "out"   — visible only to signed-out visitors.
   * "any"   — visible to everyone.
   * "admin" — visible when signed in AND the caller is on the admin list
   *           (the parent decides this from the /v1/me payload and only
   *           passes admin links through when the user qualifies).
   */
  auth: "in" | "out" | "any" | "admin";
  /** The desktop header shows it from xl up; the drawer always lists it. */
  wideOnly?: boolean;
};

export interface MobileNavProps {
  open: boolean;
  onClose: () => void;
  pathname: string;
  links: readonly MobileNavLink[];
}

function isActive(href: string, pathname: string): boolean {
  if (href === pathname) return true;
  return pathname.startsWith(href + "/");
}

export function MobileNav({ open, onClose, pathname, links }: MobileNavProps) {
  const closeRef = useRef(onClose); closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    // lg is the marketing header's desktop breakpoint. Closing state here
    // releases the shared focus scope/body lock; CSS hiding alone would not.
    const media = window.matchMedia?.("(min-width:1024px)");
    const closeOnDesktop = () => { if (media?.matches) closeRef.current(); };
    closeOnDesktop(); media?.addEventListener("change", closeOnDesktop);
    return () => media?.removeEventListener("change", closeOnDesktop);
  }, [open]);

  return (
    <Sheet open={open} onClose={onClose} side="right" size="sm" title="Site navigation"
      footer={<div className="w-full pb-[env(safe-area-inset-bottom,0px)]"><ThemeChoice /></div>}>
      <div id="mobile-nav-drawer" className="space-y-4">
          <Link
            href="/"
            onClick={onClose}
            aria-label="SC2 Tools — home"
            className="flex items-center gap-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface"
          >
            <LogoMark size={28} />
            <span className="flex items-center gap-1.5 font-display text-h4 font-extrabold tracking-tight text-text">
              SC2&nbsp;Tools
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent" />
            </span>
          </Link>
        <nav
          aria-label="Primary"
        >
          <ul className="space-y-1">
            {links.map((link) => (
              <NavAuthGate key={`${link.auth}:${link.href}`} auth={link.auth}>
                <DrawerLink
                  href={link.href}
                  label={link.label}
                  active={isActive(link.href, pathname)}
                  onSelect={onClose}
                />
              </NavAuthGate>
            ))}
          </ul>
          <SignedIn>
            <div className="mt-4 px-1">
              <Link
                href="/app"
                onClick={onClose}
                className="hard-press flex h-12 w-full items-center justify-center rounded-full border-2 border-line bg-accent px-3 font-display text-body font-bold text-white hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                Open app
              </Link>
            </div>
          </SignedIn>
          <SignedOut>
            <div className="mt-4 space-y-2 px-1">
              <AuthContextLink
                kind="sign-in"
                onClick={onClose}
                className="hard-press flex h-12 w-full items-center justify-center rounded-full border-2 border-line bg-bg-surface px-3 font-display text-body font-bold text-text hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                Sign in
              </AuthContextLink>
              <AuthContextLink
                kind="sign-up"
                onClick={onClose}
                className="hard-press flex h-12 w-full items-center justify-center rounded-full border-2 border-line bg-accent px-3 font-display text-body font-bold text-white hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                Get started
              </AuthContextLink>
            </div>
          </SignedOut>
        </nav>
      </div>
    </Sheet>
  );
}

interface DrawerLinkProps {
  href: string;
  label: string;
  active: boolean;
  onSelect: () => void;
}

function DrawerLink({ href, label, active, onSelect }: DrawerLinkProps) {
  return (
    <li>
      <Link
        href={href}
        aria-current={active ? "page" : undefined}
        onClick={onSelect}
        className={[
          "flex h-12 items-center rounded-full px-4 font-display text-body font-bold",
          "motion-safe:transition-colors motion-safe:duration-150",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface",
          active
            ? "bg-accent/10 text-accent-cyan"
            : "text-text-muted hover:bg-bg-elevated hover:text-text",
        ].join(" ")}
      >
        {label}
      </Link>
    </li>
  );
}
