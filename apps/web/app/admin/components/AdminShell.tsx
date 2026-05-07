"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Responsive shell for the admin section.
 *
 *   - Desktop (≥ ``md``): persistent left sidebar with the section
 *     navigation; content fills the remaining width.
 *   - Mobile (``< md``): a sticky top header with a hamburger that
 *     toggles a slide-in drawer. The drawer auto-closes on
 *     navigation so the user lands on the new tab without an extra
 *     tap.
 *
 * Each tab is a real Next.js route under ``/admin/<slug>`` rather
 * than React-state-driven; that keeps deep links shareable, plays
 * nicely with the browser back button, and lets us colocate the
 * tab's data fetching with its module.
 */

type NavItem = {
  href: string;
  label: string;
  description: string;
  /** SVG path strings, rendered inside a 24×24 viewBox. */
  icon: string;
};

const NAV: ReadonlyArray<NavItem> = [
  {
    href: "/admin",
    label: "Dashboard",
    description: "Storage stats and totals",
    icon: "M3 12l2-2 4 4 8-8 4 4M3 17h18",
  },
  {
    href: "/admin/users",
    label: "Users",
    description: "Per-user activity and tools",
    icon: "M16 11a4 4 0 1 0-8 0 4 4 0 0 0 8 0zM2 21a8 8 0 0 1 16 0",
  },
  {
    href: "/admin/tools",
    label: "Tools",
    description: "Rebuild opponents, wipe games",
    icon: "M14 7l-3 3m3-3l3 3-3-3-7 7v3h3l7-7m-3-3l3-3 3 3-3 3",
  },
  {
    href: "/admin/moderation",
    label: "Moderation",
    description: "Open community reports",
    icon: "M3 7l9-4 9 4-9 4-9-4zm0 6l9 4 9-4M3 17l9 4 9-4",
  },
  {
    href: "/admin/health",
    label: "Health",
    description: "Mongo ping, runtime info",
    icon: "M3 12h4l3-9 4 18 3-9h4",
  },
];

export function AdminShell({ children }: { children: ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const pathname = usePathname();
  const active = pickActive(NAV, pathname || "/admin");

  return (
    <div className="flex min-h-[calc(100dvh-4rem)] flex-col gap-4 md:flex-row md:gap-6">
      {/* Mobile header — sticks to the top of the viewport. */}
      <div className="md:hidden">
        <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-border bg-bg/90 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-bg/70">
          <button
            type="button"
            aria-label="Open admin navigation"
            className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-bg-surface text-text"
            onClick={() => setDrawerOpen(true)}
          >
            <HamburgerIcon />
          </button>
          <div className="flex min-w-0 flex-col">
            <span className="text-caption font-semibold uppercase tracking-wider text-text-dim">
              Admin
            </span>
            <span className="truncate text-body font-semibold">
              {active?.label ?? "Admin"}
            </span>
          </div>
          <span className="w-10" aria-hidden />
        </header>
      </div>

      {/* Mobile drawer overlay. */}
      {drawerOpen ? (
        <div
          className="fixed inset-0 z-40 bg-black/60 md:hidden"
          onClick={() => setDrawerOpen(false)}
          role="presentation"
        />
      ) : null}
      <aside
        className={[
          "fixed inset-y-0 left-0 z-50 w-72 max-w-[85vw] transform border-r border-border bg-bg-surface p-4 transition-transform md:static md:z-auto md:w-64 md:translate-x-0 md:border-r md:bg-transparent md:p-0",
          drawerOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0",
        ].join(" ")}
        aria-label="Admin navigation"
      >
        <div className="mb-3 flex items-center justify-between md:hidden">
          <span className="text-caption font-semibold uppercase tracking-wider text-text-dim">
            Admin
          </span>
          <button
            type="button"
            aria-label="Close admin navigation"
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-bg-surface text-text"
            onClick={() => setDrawerOpen(false)}
          >
            <CloseIcon />
          </button>
        </div>
        <nav className="space-y-1">
          {NAV.map((item) => {
            const isActive = item.href === active?.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setDrawerOpen(false)}
                className={[
                  "flex items-start gap-3 rounded-lg px-3 py-2.5 transition-colors",
                  isActive
                    ? "bg-accent/15 text-text shadow-[inset_0_0_0_1px_rgba(0,150,200,0.35)]"
                    : "text-text-muted hover:bg-bg-elevated/60 hover:text-text",
                ].join(" ")}
                aria-current={isActive ? "page" : undefined}
              >
                <span
                  className={[
                    "mt-0.5 inline-flex h-8 w-8 flex-none items-center justify-center rounded-md border",
                    isActive
                      ? "border-accent/40 bg-accent/10 text-accent"
                      : "border-border bg-bg-surface text-text-dim",
                  ].join(" ")}
                  aria-hidden
                >
                  <NavIcon path={item.icon} />
                </span>
                <span className="flex flex-col gap-0.5">
                  <span className="text-body font-semibold leading-tight">
                    {item.label}
                  </span>
                  <span className="text-caption text-text-dim">
                    {item.description}
                  </span>
                </span>
              </Link>
            );
          })}
        </nav>
      </aside>

      {/* Page content. */}
      <main className="min-w-0 flex-1">
        <div className="space-y-6">{children}</div>
      </main>
    </div>
  );
}

function pickActive(items: ReadonlyArray<NavItem>, pathname: string) {
  // Pick the longest matching prefix so /admin/users/<x> highlights
  // the Users tab, not Dashboard.
  let best: NavItem | undefined;
  for (const item of items) {
    if (pathname === item.href || pathname.startsWith(`${item.href}/`)) {
      if (!best || item.href.length > best.href.length) best = item;
    }
  }
  return best;
}

function HamburgerIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden>
      <path
        d="M4 7h16M4 12h16M4 17h16"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden>
      <path
        d="M6 6l12 12M18 6L6 18"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

function NavIcon({ path }: { path: string }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden>
      <path
        d={path}
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
