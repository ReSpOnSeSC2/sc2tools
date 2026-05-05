"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import Image from "next/image";
import { createPortal } from "react-dom";
import { SignedIn, SignedOut } from "@clerk/nextjs";
import { X } from "lucide-react";
import { ThemeToggle } from "@/components/ui/ThemeToggle";

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
  /** "in" — only visible when signed in; "any" — visible to everyone. */
  auth: "in" | "any";
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

  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current = document.activeElement;

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
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
      document.body.style.overflow = prevOverflow;
      window.clearTimeout(initFocus);
      const prev = previouslyFocusedRef.current as HTMLElement | null;
      if (prev && typeof prev.focus === "function") {
        prev.focus();
      }
    };
  }, [open, onClose]);

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
          "bg-bg-surface text-text border-l border-border shadow-2xl",
          "pt-[env(safe-area-inset-top,0px)] pb-[env(safe-area-inset-bottom,0px)]",
          "motion-safe:animate-[slideInRight_180ms_ease-out]",
          "focus:outline-none",
        ].join(" ")}
      >
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <Link
            href="/"
            onClick={onClose}
            aria-label="SC2 Tools — home"
            className="flex items-center gap-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface"
          >
            <Image
              src="/logo.png"
              alt=""
              width={28}
              height={28}
              className="rounded-full shadow-[0_0_14px_var(--halo-cyan)]"
            />
            <span className="text-body font-semibold tracking-tight text-text">
              SC2 Tools
            </span>
          </Link>
          <button
            type="button"
            aria-label="Close menu"
            onClick={onClose}
            className="-mr-1 inline-flex h-11 w-11 items-center justify-center rounded-lg text-text-muted hover:bg-bg-elevated hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </header>
        <nav
          className="flex-1 overflow-y-auto px-3 py-4"
          aria-label="Primary"
        >
          <ul className="space-y-1">
            {links.map((link) => {
              if (link.auth === "in") {
                return (
                  <SignedIn key={link.href}>
                    <DrawerLink
                      href={link.href}
                      label={link.label}
                      active={isActive(link.href, pathname)}
                      onSelect={onClose}
                    />
                  </SignedIn>
                );
              }
              return (
                <DrawerLink
                  key={link.href}
                  href={link.href}
                  label={link.label}
                  active={isActive(link.href, pathname)}
                  onSelect={onClose}
                />
              );
            })}
          </ul>
          <SignedOut>
            <div className="mt-4 space-y-2 px-1">
              <Link
                href="/sign-in"
                onClick={onClose}
                className="flex h-12 w-full items-center justify-center rounded-lg border border-border bg-bg-elevated px-3 text-body font-medium text-text hover:bg-bg-subtle hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                Sign in
              </Link>
              <Link
                href="/sign-up"
                onClick={onClose}
                className="flex h-12 w-full items-center justify-center rounded-lg bg-accent px-3 text-body font-semibold text-white hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                Get started
              </Link>
            </div>
          </SignedOut>
        </nav>
        <footer className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
          <span className="text-caption text-text-muted">Theme</span>
          <ThemeToggle />
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
          "flex h-12 items-center rounded-lg px-3 text-body font-medium",
          "motion-safe:transition-colors motion-safe:duration-150",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface",
          active
            ? "bg-accent/10 text-accent"
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
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
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
    if (active === last) {
      e.preventDefault();
      first.focus();
    }
  }
}
