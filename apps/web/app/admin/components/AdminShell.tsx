"use client";
import { useCallback, useEffect, useRef, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Bell, Users, Fingerprint, Tv, ShieldAlert, Globe, TrendingUp, BarChart3, BookOpen, Megaphone, Wrench, Server, type LucideIcon } from "lucide-react";
import { useApi } from "@/lib/clientApi";
import { useReducedMotion } from "@/lib/useChartTheme";
import { useAdminEventsSocket } from "./useAdminEventsSocket";
import type { AdminEventCountsResp, AdminInfrastructureResp } from "./adminTypes";

type NavItem = { href: string; label: string; description: string; icon: LucideIcon };
const item = (href: string, label: string, description: string, icon: LucideIcon): NavItem => ({ href, label, description, icon });
export const NAV_GROUPS = [
  { label: "Overview", items: [item("/admin", "Dashboard", "Storage stats and totals", LayoutDashboard), item("/admin/notifications", "Notifications", "Activity and support inbox", Bell)] },
  { label: "Community", items: [item("/admin/users", "Users", "Accounts and data tools", Users), item("/admin/player-identities", "Player identities", "Review identity submissions", Fingerprint), item("/admin/player-channels", "Player channels", "Shared channel directory", Tv), item("/admin/moderation", "Moderation", "Open community reports", ShieldAlert)] },
  { label: "Insights", items: [item("/admin/global", "Global players", "Platform-wide players", Globe), item("/admin/global-trends", "Global trends", "All-player trends", TrendingUp), item("/admin/analytics", "Web analytics", "Google Analytics traffic", BarChart3)] },
  { label: "Content", items: [item("/admin/guides", "Guides", "Notes, videos and stats runs", BookOpen), item("/admin/announcements", "Announcements", "Time-limited incident notices", Megaphone)] },
  { label: "Operations", items: [item("/admin/tools", "Tools", "Repair account data", Wrench), item("/admin/health", "Infrastructure", "Costs, capacity and health", Server)] },
] as const;
// Future slots: Audit log and Design gallery under Operations; Announcements
// under Content; Classifier under Insights.
const NAV: ReadonlyArray<NavItem> = NAV_GROUPS.flatMap((group) => [...group.items]);

export function AdminShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const active = pickActive(NAV, pathname || "/admin");
  const unread = useUnreadCount();
  const notice = useInfrastructureNotice();
  const reducedMotion = useReducedMotion();
  const mobile = useRef<HTMLElement>(null);
  useEffect(() => {
    const reduce = reducedMotion || Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
    mobile.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView?.({ inline: "center", block: "nearest", behavior: reduce ? "auto" : "smooth" });
  }, [pathname, reducedMotion]);
  const navLink = (entry: NavItem, desktop: boolean) => <AdminNavLink key={entry.href} item={entry} desktop={desktop}
    active={entry.href === active?.href} unread={entry.href === "/admin/notifications" ? unread : 0} notice={entry.href === "/admin/health" ? notice : null} />;
  return <div className="flex flex-col gap-4 md:flex-row md:gap-6">
    <nav ref={mobile} aria-label="Admin sections" className="-mx-4 flex items-center gap-2 overflow-x-auto px-4 pb-1 md:hidden">
      {NAV_GROUPS.map((group, index) => <div key={group.label} className={"flex shrink-0 items-center gap-1.5 " + (index ? "border-l border-border pl-2" : "")}>
        {group.items.map((entry) => navLink(entry, false))}
      </div>)}
    </nav>
    <aside className="hidden w-64 flex-none md:block" aria-label="Admin navigation">
      <nav className="space-y-5">{NAV_GROUPS.map((group) => <div key={group.label}>
        <h2 id={"admin-nav-" + group.label.toLowerCase()} className="mb-1 px-3 text-micro font-semibold uppercase tracking-wider text-text-dim">{group.label}</h2>
        <ul aria-labelledby={"admin-nav-" + group.label.toLowerCase()} className="space-y-1">{group.items.map((entry) => <li key={entry.href}>{navLink(entry, true)}</li>)}</ul>
      </div>)}</nav>
    </aside>
    <div className="min-w-0 flex-1"><div className="space-y-6">{children}</div></div>
  </div>;
}

function AdminNavLink({ item, active, desktop, unread, notice }: { item: NavItem; active: boolean; desktop: boolean; unread: number; notice: "watch" | "upgrade" | null }) {
  const Icon = item.icon;
  return <Link href={item.href} aria-current={active ? "page" : undefined}
    className={[(desktop ? "flex items-start rounded-lg px-3 py-2.5" : "inline-flex min-h-11 flex-none items-center whitespace-nowrap rounded-full border px-3.5"), "gap-2 text-caption transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent", active ? "bg-accent/15 text-text ring-1 ring-inset ring-accent/35" : "border-border text-text-muted hover:bg-bg-elevated"].join(" ")}>
    <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
    <span><span className="font-semibold">{item.label}</span>{desktop && active ? <span className="block text-caption text-text-dim">{item.description}</span> : null}</span>
    {unread > 0 ? <span className="rounded-full bg-accent-cyan px-1.5 text-micro text-white" aria-label={unread + " unread"}>{unread > 99 ? "99+" : unread}</span> : null}
    {notice ? <span className={"h-2.5 w-2.5 rounded-full " + (notice === "upgrade" ? "bg-danger" : "bg-warning")} role="img" aria-label={"Infrastructure status: " + notice} /> : null}
  </Link>;
}

function useUnreadCount(): number {
  const swr = useApi<AdminEventCountsResp>(
    "/v1/admin/events/counts",
    {
      refreshInterval: 60000,
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
    useCallback(() => { void swr.mutate(); }, [swr]),
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
