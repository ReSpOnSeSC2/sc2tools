"use client";

import { useCallback, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import useSWR from "swr";
import { useAuth } from "@clerk/nextjs";

import { apiCall, useApi } from "@/lib/clientApi";
import { useAdminEventsSocket } from "./useAdminEventsSocket";
import type {
  AdminEventCountsResp,
  AdminInfrastructureResp,
} from "./adminTypes";

/**
 * Responsive shell for the admin section.
 *
 *   - Desktop (≥ ``md``): persistent left sidebar with the section
 *     navigation; content fills the remaining width.
 *   - Mobile (``< md``): a horizontal scroll strip above the content,
 *     matching the Settings sub-navigation. The app chrome already
 *     owns the product-level nav (rail on desktop, tab bar plus More
 *     sheet on mobile), so a second hamburger here would be a
 *     competing menu rather than a section switcher.
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
    href: "/admin/notifications",
    label: "Notifications",
    description: "Signups and downloads feed",
    icon: "M15 17h5l-1.4-1.4A2 2 0 0 1 18 14.2V11a6 6 0 1 0-12 0v3.2a2 2 0 0 1-.6 1.4L4 17h5m6 0a3 3 0 1 1-6 0",
  },
  {
    href: "/admin/users",
    label: "Users",
    description: "Per-user activity and tools",
    icon: "M16 11a4 4 0 1 0-8 0 4 4 0 0 0 8 0zM2 21a8 8 0 0 1 16 0",
  },
  {
    href: "/admin/global",
    label: "Global",
    description: "Platform-wide players and trends",
    icon: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 0c2.5 2.5 2.5 15.5 0 18m0-18C9.5 5.5 9.5 18.5 12 21M3.5 9h17M3.5 15h17",
  },
  {
    href: "/admin/player-channels",
    label: "Player channels",
    description: "Shared Twitch and YouTube directory",
    icon: "M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2m3 6a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2",
  },
  {
    href: "/admin/analytics",
    label: "Analytics",
    description: "Google Analytics traffic",
    icon: "M3 3v18h18M7 14l3-4 3 3 4-6",
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
    label: "Infrastructure",
    description: "Costs, capacity, health",
    icon: "M3 12h4l3-9 4 18 3-9h4",
  },
];

export function AdminShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const active = pickActive(NAV, pathname || "/admin");
  const unread = useUnreadCount();
  const infrastructureNotice = useInfrastructureNotice();

  const badgeFor = (href: string) =>
    href === "/admin/notifications" && unread > 0 ? unread : 0;
  const noticeFor = (href: string) =>
    href === "/admin/health" ? infrastructureNotice : null;

  return (
    <div className="flex flex-col gap-4 md:flex-row md:gap-6">
      {/* Mobile — horizontal scroll strip, same shape as Settings. */}
      <nav
        aria-label="Admin sections"
        className="-mx-4 flex items-center gap-1.5 overflow-x-auto px-4 pb-1 md:hidden"
      >
        {NAV.map((item) => {
          const isActive = item.href === active?.href;
          const badge = badgeFor(item.href);
          const capacityStatus = noticeFor(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={isActive ? "page" : undefined}
              className={[
                "inline-flex min-h-[40px] flex-none items-center gap-2 rounded-full border-2 px-3.5",
                "text-caption font-bold whitespace-nowrap transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                isActive
                  ? "border-accent-cyan/40 bg-accent-cyan/10 text-accent"
                  : "border-border text-text-muted hover:bg-bg-elevated hover:text-text",
              ].join(" ")}
            >
              <NavIcon path={item.icon} />
              {item.label}
              {badge > 0 ? (
                <span
                  className="inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-accent-cyan px-1.5 py-0.5 text-micro font-bold leading-none text-white"
                  aria-label={`${badge} unread`}
                >
                  {badge > 99 ? "99+" : badge}
                </span>
              ) : null}
              {capacityStatus ? (
                <span
                  className={`inline-block h-2.5 w-2.5 flex-none rounded-full ${capacityStatus === "upgrade" ? "bg-danger" : "bg-warning"}`}
                  role="img"
                  aria-label={`Infrastructure status: ${capacityStatus}`}
                />
              ) : null}
            </Link>
          );
        })}
      </nav>

      {/* Desktop sidebar. */}
      <aside
        className="hidden w-64 flex-none md:block"
        aria-label="Admin navigation"
      >
        <nav className="space-y-1">
          {NAV.map((item) => {
            const isActive = item.href === active?.href;
            const badge = badgeFor(item.href);
            const capacityStatus = noticeFor(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
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
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex items-center gap-2 text-body font-semibold leading-tight">
                    <span className="truncate">{item.label}</span>
                    {badge > 0 ? (
                      <span
                        className="inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-accent-cyan px-1.5 py-0.5 text-micro font-bold leading-none text-white"
                        aria-label={`${badge} unread`}
                      >
                        {badge > 99 ? "99+" : badge}
                      </span>
                    ) : null}
                    {capacityStatus ? (
                      <span
                        className={`inline-block h-2.5 w-2.5 flex-none rounded-full ${capacityStatus === "upgrade" ? "bg-danger" : "bg-warning"}`}
                        role="img"
                        aria-label={`Infrastructure status: ${capacityStatus}`}
                      />
                    ) : null}
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

      {/* Page content. The app chrome owns <main>, so this is a plain box. */}
      <div className="min-w-0 flex-1">
        <div className="space-y-6">{children}</div>
      </div>
    </div>
  );
}

/**
 * Read the current unread-notification count off
 * ``GET /v1/admin/events/counts`` and keep it live via the same
 * Socket.io ``admin:event`` stream the dashboard subscribes to.
 * Non-admins receive a 403 from the API and the badge stays at 0,
 * which is fine — the admin section already 403s for them at the
 * page level so the nav never renders.
 */
function useUnreadCount(): number {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const swr = useSWR<AdminEventCountsResp>(
    isLoaded && isSignedIn ? "/v1/admin/events/counts" : null,
    async () => apiCall(getToken, "/v1/admin/events/counts"),
    {
      onErrorRetry: (error, _key, _config, revalidate, ctx) => {
        if (error?.status === 403 || error?.status === 401) return;
        if (ctx.retryCount >= 3) return;
        setTimeout(() => revalidate({ retryCount: ctx.retryCount }), 5000);
      },
    },
  );
  useAdminEventsSocket(
    useCallback(() => {
      swr.mutate();
    }, [swr]),
  );
  return swr.data?.unreadCount ?? 0;
}

/**
 * Keep a quiet capacity signal in the persistent admin navigation. SWR shares
 * this request with the Infrastructure page, so opening that tab does not
 * duplicate provider polling.
 */
function useInfrastructureNotice(): "watch" | "upgrade" | null {
  const { data } = useApi<AdminInfrastructureResp>(
    "/v1/admin/infrastructure",
    { refreshInterval: 5 * 60_000 },
  );
  return data?.overallStatus === "watch" || data?.overallStatus === "upgrade"
    ? data.overallStatus
    : null;
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
