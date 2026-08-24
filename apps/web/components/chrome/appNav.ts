import type { ComponentType, SVGProps } from "react";
import {
  CalendarClock,
  Cpu,
  Globe2,
  Library,
  ShieldCheck,
  SlidersHorizontal,
  Users2,
  Zap,
} from "lucide-react";
import { TABS, hrefForTab, type TabId } from "@/components/analyzer/tabs";

/* ------------------------------------------------------------------
 * One nav model, shared by the desktop rail, the mobile tab bar and
 * the More sheet, so the three can never drift apart.
 *
 * "Surfaces" are every signed-in destination in the product: the seven
 * analyzer sections plus Today, and the account-level pages that used
 * to hang off the marketing header (custom builds, meta, community,
 * coaching, agent, settings, admin). Role-gated entries remain in this
 * shared model and are filtered before either responsive nav renders.
 * ------------------------------------------------------------------ */

export type NavIcon = ComponentType<SVGProps<SVGSVGElement>>;

export type NavEntry = {
  /** Stable key, also the value ``activeSurface`` compares against. */
  key: string;
  href: string;
  label: string;
  icon: NavIcon;
  /** Analyzer sections sit in the rail's top group. */
  group: "section" | "utility";
  /** Only rendered when /v1/me reports an admin. */
  adminOnly?: boolean;
  /** Only rendered for a real admin, linked coach, or linked student. */
  coachingOnly?: boolean;
  /** Signed-out visitors can reach these (shared community/meta links). */
  publicRoute?: boolean;
};

export const TODAY_ENTRY: NavEntry = {
  key: "today",
  href: "/app",
  label: "Today",
  icon: Zap,
  group: "section",
};

const SECTION_ENTRIES: NavEntry[] = TABS.map((tab) => ({
  key: tab.id,
  href: hrefForTab(tab.id),
  label: tab.label,
  icon: tab.icon,
  group: "section" as const,
}));

const UTILITY_ENTRIES: NavEntry[] = [
  { key: "builds-library", href: "/builds", label: "Custom builds", icon: Library, group: "utility" },
  { key: "meta", href: "/meta", label: "Meta", icon: Globe2, group: "utility", publicRoute: true },
  { key: "community", href: "/community", label: "Community", icon: Users2, group: "utility", publicRoute: true },
  {
    key: "coaching",
    href: "/coaching",
    label: "Coaching",
    icon: CalendarClock,
    group: "utility",
    coachingOnly: true,
  },
  { key: "devices", href: "/devices", label: "Devices", icon: Cpu, group: "utility" },
  { key: "settings", href: "/settings", label: "Settings", icon: SlidersHorizontal, group: "utility" },
  { key: "admin", href: "/admin", label: "Admin", icon: ShieldCheck, group: "utility", adminOnly: true },
];

export const NAV_ENTRIES: readonly NavEntry[] = [
  TODAY_ENTRY,
  ...SECTION_ENTRIES,
  ...UTILITY_ENTRIES,
];

/** The bottom tab bar carries the highest-traffic destinations. */
export const MOBILE_TAB_KEYS: readonly string[] = [
  "today",
  "opponents",
  "builds",
  "battlefield",
];

/**
 * Every path the application chrome owns. Anything else (the landing
 * page, legal, download, the onboarding wizard, public profiles) keeps
 * the marketing header and footer.
 */
export function isAppSurfacePath(pathname: string | null): boolean {
  if (!pathname) return false;
  return NAV_ENTRIES.some(
    (e) => pathname === e.href || pathname.startsWith(`${e.href}/`),
  );
}

/** Routes whose data is per-user and gated by middleware. */
export function isProtectedSurfacePath(pathname: string | null): boolean {
  if (!pathname) return false;
  return NAV_ENTRIES.some(
    (e) =>
      !e.publicRoute &&
      (pathname === e.href || pathname.startsWith(`${e.href}/`)),
  );
}

export type SurfaceMatch = {
  entry: NavEntry;
  /** True on a detail page below the section root (dossier, build, game). */
  isDetail: boolean;
  /** Where the context bar's back control points on a detail page. */
  backHref: string;
};

/**
 * Resolve a pathname to the nav entry that owns it. Longest href wins,
 * so /app/opponents beats /app and /community/builds beats /community.
 */
export function matchSurface(pathname: string | null): SurfaceMatch | null {
  if (!pathname) return null;

  // /app/game/<id> is a leaf of the analyzer, not a destination of its own.
  if (pathname === "/app/game" || pathname.startsWith("/app/game/")) {
    return { entry: TODAY_ENTRY, isDetail: true, backHref: "/app" };
  }

  let best: NavEntry | null = null;
  for (const entry of NAV_ENTRIES) {
    if (pathname === entry.href || pathname.startsWith(`${entry.href}/`)) {
      if (!best || entry.href.length > best.href.length) best = entry;
    }
  }
  if (!best) return null;

  return {
    entry: best,
    isDetail: pathname.length > best.href.length,
    backHref: best.href,
  };
}

/** Section title shown in the context bar. */
export function surfaceTitle(pathname: string | null): string {
  if (pathname === "/app/game" || pathname?.startsWith("/app/game/")) {
    return "Replay";
  }
  return matchSurface(pathname)?.entry.label ?? "SC2 Tools";
}

/** The analyzer owns the filter bar and the onboarding gate; nothing else does. */
export function isAnalyzerPath(pathname: string | null): boolean {
  if (!pathname) return false;
  return pathname === "/app" || pathname.startsWith("/app/");
}

export type { TabId };
