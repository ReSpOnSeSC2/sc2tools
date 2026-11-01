import type { ComponentType, SVGProps } from "react";
import {
  Bell,
  BookOpen,
  CalendarClock,
  Cpu,
  Library,
  MessageSquareText,
  MonitorPlay,
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
 * to hang off the marketing header (custom builds, community, reviews,
 * coaching, agent, settings, admin), plus a Stream Studio shortcut into
 * Settings → Overlay. Role-gated entries remain in this
 * shared model and are filtered before either responsive nav renders.
 *
 * The public build guides (/guides) are an entry while the guides flag
 * is on, so signed-in players can reach them from the rail, but they are
 * not an app surface: they are search landing pages that keep the
 * marketing Header/Footer. ``ownChrome`` keeps them out of
 * isAppSurfacePath, isProtectedSurfacePath and matchSurface.
 * ------------------------------------------------------------------ */

export type NavIcon = ComponentType<SVGProps<SVGSVGElement>>;

export type NavEntry = {
  /** Stable key, also the value ``activeSurface`` compares against. */
  key: string;
  href: string;
  label: string;
  shortLabel?: string;
  description?: string;
  icon: NavIcon;
  /** Analyzer sections sit in the rail's top group. */
  group: "section" | "utility";
  /** Only rendered when /v1/me reports an admin. */
  adminOnly?: boolean;
  /** Only rendered for a real admin, linked coach, or linked student. */
  coachingOnly?: boolean;
  /** Signed-out visitors can reach these (shared community links). */
  publicRoute?: boolean;
  /** Shown only while the Replay Review Exchange rollout exposes it
   *  to this viewer (NEXT_PUBLIC_REVIEWS_ENABLED). */
  reviewsRollout?: boolean;
  /** Shown only while the public build guides are switched on
   *  (NEXT_PUBLIC_GUIDES_ENABLED). */
  guidesFlag?: boolean;
  /** A link out to a public page that renders its own marketing chrome:
   *  it is in the rail but is never an app surface, a protected route or
   *  the active section. */
  ownChrome?: boolean;
  /** A shortcut into another surface (a Settings tab): in the rail, but
   *  the surface it opens owns the route, the title and the active state. */
  shortcut?: boolean;
};

export const TODAY_ENTRY: NavEntry = {
  key: "today",
  href: "/app",
  label: "Today",
  description: "Your latest games and setup progress",
  icon: Zap,
  group: "section",
};

const SECTION_ENTRIES: NavEntry[] = TABS.map((tab) => ({
  key: tab.id,
  href: hrefForTab(tab.id),
  label: tab.label,
  shortLabel: tab.id === "builds" ? "Builds" : undefined,
  description: tab.description,
  icon: tab.icon,
  group: "section" as const,
}));

const UTILITY_ENTRIES: NavEntry[] = [
  { key: "builds-library", href: "/builds", label: "Build library", description: "Your saved build orders and rules", icon: Library, group: "utility" },
  {
    key: "guides",
    href: "/guides",
    label: "Guides", description: "Build orders and matchup guides",
    icon: BookOpen,
    group: "utility",
    publicRoute: true,
    guidesFlag: true,
    ownChrome: true,
  },
  { key: "community", href: "/community", label: "Community", description: "Builds and scouting shared by players", icon: Users2, group: "utility", publicRoute: true },
  { key: "reviews", href: "/reviews", label: "Reviews", description: "Replay reviews from other players", icon: MessageSquareText, group: "utility", publicRoute: true, reviewsRollout: true },
  {
    key: "coaching",
    href: "/coaching",
    label: "Coaching", description: "Your sessions",
    icon: CalendarClock,
    group: "utility",
    coachingOnly: true,
  },
  // Overlay widgets, chat, the Stream Dock and alerts all live under
  // Settings → Overlay; streamers look for them by this name.
  {
    key: "stream-studio",
    href: "/settings?tab=overlay",
    label: "Stream Studio", description: "Overlay widgets and stream setup",
    icon: MonitorPlay,
    group: "utility",
    shortcut: true,
  },
  { key: "devices", href: "/devices", label: "Devices", description: "Your linked PCs", icon: Cpu, group: "utility" },
  { key: "notifications", href: "/notifications", label: "Notifications", description: "Your activity and report replies", icon: Bell, group: "utility" },
  { key: "settings", href: "/settings", label: "Settings", description: "Profile, imports, overlay and preferences", icon: SlidersHorizontal, group: "utility" },
  { key: "admin", href: "/admin", label: "Admin", description: "Site administration", icon: ShieldCheck, group: "utility", adminOnly: true },
];

export const NAV_ENTRIES: readonly NavEntry[] = [
  TODAY_ENTRY,
  ...SECTION_ENTRIES,
  { key: "sessions", href: "/app/sessions", label: "Sessions", description: "Review complete sessions and recorded ratings", icon: CalendarClock, group: "section" },
  ...UTILITY_ENTRIES,
];

export type NavGates = { isAdmin: boolean; coaching: boolean; reviews: boolean; guides: boolean };

/**
 * The entries this viewer may open, gated the same way wherever they are
 * listed (the app chrome, the marketing header's quick search).
 *
 * Example: `admittedNavEntries({ isAdmin: false, coaching: false, reviews: true, guides: true })`
 * leaves out Coaching and Admin.
 */
export function admittedNavEntries(gates: NavGates): NavEntry[] {
  return NAV_ENTRIES.filter((e) =>
    (!e.adminOnly || gates.isAdmin) && (!e.coachingOnly || gates.coaching)
    && (!e.reviewsRollout || gates.reviews) && (!e.guidesFlag || gates.guides));
}

/**
 * The entries whose pages render inside the app chrome. Shortcuts point
 * into one of these (Stream Studio is /settings), so they never claim a
 * route of their own.
 */
const SURFACE_ENTRIES: readonly NavEntry[] = NAV_ENTRIES.filter((e) => !e.ownChrome && !e.shortcut);

/** The bottom tab bar carries the highest-traffic destinations. */
export const MOBILE_TAB_KEYS: readonly string[] = [
  "today",
  "opponents",
  "trends",
  "builds",
];

/**
 * Every path the application chrome owns. Anything else (the landing
 * page, legal, download, the onboarding wizard, public profiles) keeps
 * the marketing header and footer.
 */
export function isAppSurfacePath(pathname: string | null): boolean {
  if (!pathname) return false;
  return SURFACE_ENTRIES.some(
    (e) => pathname === e.href || pathname.startsWith(`${e.href}/`),
  );
}

/** Routes whose data is per-user and gated by middleware. */
export function isProtectedSurfacePath(pathname: string | null): boolean {
  if (!pathname) return false;
  return SURFACE_ENTRIES.some(
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
  backEntry: NavEntry;
};

/**
 * Resolve a pathname to the nav entry that owns it. Longest href wins,
 * so /app/opponents beats /app and /community/builds beats /community.
 */
export function matchSurface(pathname: string | null): SurfaceMatch | null {
  if (!pathname) return null;

  // /app/game/<id> is a leaf of the analyzer, not a destination of its own.
  if (pathname === "/app/game" || pathname.startsWith("/app/game/")) {
    return { entry: TODAY_ENTRY, isDetail: true, backHref: "/app", backEntry: TODAY_ENTRY };
  }

  let best: NavEntry | null = null;
  for (const entry of SURFACE_ENTRIES) {
    if (pathname === entry.href || pathname.startsWith(`${entry.href}/`)) {
      if (!best || entry.href.length > best.href.length) best = entry;
    }
  }
  if (!best) return null;

  return {
    entry: best,
    isDetail: pathname.length > best.href.length,
    backHref: best.href,
    backEntry: best,
  };
}

/** Section title shown in the context bar. */
export function surfaceTitle(pathname: string | null): string {
  return matchSurface(pathname)?.entry.label ?? "SC2 Tools";
}

/** The analyzer owns the filter bar and the onboarding gate; nothing else does. */
export function isAnalyzerPath(pathname: string | null): boolean {
  if (!pathname) return false;
  return pathname === "/app" || pathname.startsWith("/app/");
}

export type { TabId };
