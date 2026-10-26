"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { AuthContextLink } from "@/components/auth/AuthContextLink";
import { createPortal } from "react-dom";
import { SignedIn, SignedOut } from "@clerk/nextjs";
import { X } from "lucide-react";
import { lockBodyScroll } from "@/lib/bodyScrollLock";
import { ThemeChoice } from "@/components/ui/ThemeChoice";
import { LogoMark } from "./LogoMark";
import { NavAuthGate } from "./NavAuthGate";

/**
 * MobileNav — slide-in right-side drawer for the <lg viewport.
 *
 * Behaviors:
 *   - Esc closes
 *   - Scrim click closes
 *   - Focus trap inside the drawer; focus returns to the trigger on close
 *   - Body scroll locked while open
 *   - Animates in via CSS keyframes; respects prefers-reduced-motion
 *   - ThemeToggle in the footer keeps parity with desktop chrome
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

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function isActive(href: string, pathname: string): boolean {
  if (href === pathname) return true;
  return pathname.startsWith(href + "/");
}

export function MobileNav({ open, onClose, pathname, links }: MobileNavProps) {
  const drawerRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<Element | null>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current = document.activeElement;

    const unlock = lockBodyScroll();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current();
      } else if (e.key === "Tab") {
        trapTab(e, drawerRef.current);
      }
    };
    document.addEventListener("keydown", onKey);

    const initFocus = window.setTimeout(() => {
      const focusables = focusableInside(drawerRef.current);
      (focusables[0] ?? drawerRef.current)?.focus();
    }, 0);

    return () => {
      document.removeEventListener("keydown", onKey);
      unlock();
      window.clearTimeout(initFocus);
      const prev = previouslyFocusedRef.current as HTMLElement | null;
      if (prev && typeof prev.focus === "function") {
        prev.focus();
      }
    };
  }, [open]);

  if (!open) return null;
  if (typeof window === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 lg:hidden"
      role="presentation"
    >
      <button
        type="button"
        aria-label="Close menu"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm motion-safe:animate-[fadeIn_140ms_ease-out]"
      />
      <div
        ref={drawerRef}
        id="mobile-nav-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Site navigation"
        tabIndex={-1}
        className={[
          "absolute inset-y-0 right-0 flex w-[88vw] max-w-sm flex-col",
          "bg-bg-surface text-text border-l-2 border-line shadow-2xl",
          "pt-[env(safe-area-inset-top,0px)] pb-[env(safe-area-inset-bottom,0px)]",
          "motion-safe:animate-[slideInRight_180ms_ease-out]",
          "focus:outline-none",
        ].join(" ")}
      >
        <header className="flex items-center justify-between gap-3 border-b-2 border-line px-4 py-3">
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
          <button
            type="button"
            aria-label="Close menu"
            onClick={onClose}
            className="hard-press -mr-1 inline-flex h-11 w-11 items-center justify-center rounded-full border-2 border-line bg-bg-surface text-text hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </header>
        <nav
          className="flex-1 overflow-y-auto px-3 py-4"
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
        <footer className="border-t-2 border-line px-4 py-3">
          <ThemeChoice />
        </footer>
      </div>
    </div>,
    document.body,
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

/* ============================================================
 * Focus-trap helpers — local copy of the Modal trap so the chrome
 * package doesn't reach into the design-system internals.
 * ============================================================ */

function focusableInside(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(el => {
    if (el.tabIndex < 0 || el.matches(":disabled") || el.closest("[hidden],[inert],[aria-hidden='true']")) return false;
    for (let node: HTMLElement | null = el; node && node !== root.parentElement; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return true;
  });
}

function trapTab(e: KeyboardEvent, root: HTMLElement | null): void {
  if (!root) return;
  const els = focusableInside(root);
  if (els.length === 0) {
    e.preventDefault();
    root.focus();
    return;
  }
  const first = els[0];
  const last = els[els.length - 1];
  const active = document.activeElement;
  if (e.shiftKey) {
    if (active === first || !root.contains(active)) {
      e.preventDefault();
      last.focus();
    }
  } else {
    if (active === last || !root.contains(active)) {
      e.preventDefault();
      first.focus();
    }
  }
}
