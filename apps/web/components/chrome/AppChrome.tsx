"use client";

import { Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { AuthContextLink } from "@/components/auth/AuthContextLink";
import dynamic from "next/dynamic";
import { backToGameSource, safeGameSource } from "@/lib/gameNavigation";
import { usePathname } from "next/navigation";
import { ClerkLoading, useAuth, SignedIn, SignedOut, UserButton } from "@clerk/nextjs";
import { Bug, ChevronLeft, Cpu, LifeBuoy, LogIn, Monitor, MoreHorizontal, PanelLeftOpen, PanelLeftClose, Settings } from "lucide-react";
import { RailGroup, RailLabel, RailLink } from "./ChromeRail";
import { MoreSheet } from "./MoreSheet";
import { RAIL_KEY, readRailPinned } from "./railPreference";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { ThemeDialog } from "@/components/ui/ThemeChoice";
import { SyncStatus } from "@/components/SyncStatus";
import { LazyReportIssueModal } from "@/components/feedback/LazyReportIssueModal";
import { useApi } from "@/lib/clientApi";
import type { ReportType } from "@/lib/feedback/reportContext";
import {
  MOBILE_TAB_KEYS,
  NAV_ENTRIES,
  isAnalyzerPath,
  matchSurface,
  surfaceTitle,
  type NavEntry,
  type NavIcon,
} from "./appNav";
import { CoachingBookingAlert } from "./CoachingBookingAlert";
import { ConnectionBanner, ConnectionStatusProvider } from "./ConnectionStatus";
import { HelpMenu } from "./HelpMenu";
import { BuildCheckInAlert } from "@/components/build-checkin/BuildCheckInAlert";
import { BuildCheckInProvider } from "@/components/build-checkin/BuildCheckInProvider";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { reviewsVisible } from "@/lib/reviews";
import { guidesEnabled } from "@/lib/guides/flags";
import { SiteStats } from "./SiteStats";
import { useChromeBottomInset } from "./chromeInsets";
import { ChromeProvider, useChromeContext } from "./ChromeContext";
import { NavProgress, startNavProgress } from "./NavProgress";
import { LogoMark } from "./LogoMark";
import { WhatsNewButton } from "@/components/announcements/WhatsNewButton";
import { SiteIncidentBanner } from "@/components/announcements/SiteIncidentBanner";
const PracticeChip = dynamic(() => import("@/components/practice/PracticeChip").then(module => module.PracticeChip), { ssr: false });

/* ------------------------------------------------------------------
 * AppChrome — the shell every signed-in surface renders inside:
 * Today and the analyzer sections, the custom-build library,
 * community, reviews, agent, settings and admin. (The public build
 * guides at /guides are linked from the rail while the guides flag is on,
 * but keep the marketing Header/Footer: they are search landing pages,
 * not an app surface.)
 *
 *   - Desktop (md+): a 64px icon rail that expands to a labelled
 *     overlay on hover / keyboard focus. One navigation system for the
 *     whole product — the marketing header's links live here now.
 *   - Mobile: a bottom tab bar with the four highest-traffic
 *     destinations and a More sheet for the rest. No hamburger.
 *   - Both: a slim sticky context bar carrying the section name, a
 *     back control on detail pages, theme, Help & support and account.
 *     The activity bar immediately below groups live sync state with the
 *     public site counts.
 *   - Help & support: the "?" menu in the context bar (desktop; on
 *     phones the same items sit in the More sheet), plus Help and Report
 *     a problem in the avatar menu. All of them open one report form.
 *   - BuildCheckInProvider wraps the shell so the header's check-in chip
 *     and every page's check-in surfaces share one realtime revision.
 *   - ConnectionStatusProvider wraps everything in the app's SWRConfig;
 *     its banner sits at the foot of the sticky bar, so "Reconnecting
 *     to SC2 Tools…" stays in view while the API wakes up.
 *   - Safe areas: the context bar pads below the notch / status bar
 *     (installed iOS app), and the tab bar's measured height is published
 *     as --chrome-bottom so floating bottom surfaces (Save bar, toasts,
 *     the update prompt, the cookie banner) sit above it, never under it.
 *
 * /community is reachable signed-out (shared links), so the
 * shell's structure is identical either way and only its contents swap:
 * signed-out visitors get the public destinations plus the sign-in
 * CTAs instead of the section rail and account button. Structure stays
 * put; placeholders reserve navigation space while Clerk resolves.
 * ------------------------------------------------------------------ */

type MeProbe = {
  userId?: string;
  isAdmin?: boolean;
  games?: { total: number; latest: string | null };
};

type CoachingMeProbe = {
  role: "admin" | "coach" | "student" | "none";
};

export function AppChrome({ children }: { children: ReactNode }) {
  return (
    <ConnectionStatusProvider>
      <BuildCheckInProvider>
        <ChromeProvider><AppChromeShell>{children}</AppChromeShell></ChromeProvider>
      </BuildCheckInProvider>
    </ConnectionStatusProvider>
  );
}

function AppChromeShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/app";
  const match = matchSurface(pathname);
  const activeKey = match?.entry.key ?? null;
  const title = surfaceTitle(pathname);
  const showBack = Boolean(match?.isDetail);
  // Analyzer sections have no page-level title of their own, so the
  // context bar is their <h1>. Settings, the build library, community
  // and admin all render their own heading below, so there the bar
  // is a breadcrumb label and must not compete for the h1.
  const ownsHeading = !match?.isDetail && match?.entry.group !== "utility";
  const breadcrumb = useChromeContext()?.breadcrumb;
  const [navPending, setNavPending] = useState(false);
  const backHref = breadcrumb?.backHref ?? match?.backHref ?? "/app";
  const backLabel = breadcrumb?.backLabel ?? `Back to ${match?.backEntry.label ?? "Today"}`;
  const [sheetOpen, setSheetOpen] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const accountRef = useRef<HTMLSpanElement>(null);
  const [pinned, setPinned] = useState(false);
  const { isSignedIn } = useAuth();
  useEffect(() => {
    const initial = readRailPinned(); setPinned(initial);
    document.documentElement.setAttribute("data-rail", initial ? "pinned" : "collapsed");
  }, []);
  const togglePinned = () => {
    const next = !pinned; setPinned(next);
    document.documentElement.setAttribute("data-rail", next ? "pinned" : "collapsed");
    try { localStorage.setItem(RAIL_KEY, next ? "pinned" : "collapsed"); } catch { /* Keep the current view. */ }
  };
  const [report, setReport] = useState<{ open: boolean; type: ReportType }>({
    open: false,
    type: "problem",
  });
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const openReport = useCallback((type: ReportType) => {
    setReport({ open: true, type });
  }, []);
  const closeReport = useCallback(() => {
    setReport((current) => ({ ...current, open: false }));
  }, []);
  // From the More sheet: the sheet closes first, so park focus on its
  // More button for the form to hand back when it closes.
  const reportFromSheet = useCallback((type: ReportType) => {
    setSheetOpen(false);
    moreButtonRef.current?.focus();
    setReport({ open: true, type });
  }, []);
  const tabBarRef = useRef<HTMLElement>(null);
  useChromeBottomInset(tabBarRef);

  // useApi gates on isSignedIn internally and SWR dedupes it against the
  // rest of the app, so this costs nothing extra and is a no-op for
  // signed-out visitors on /community.
  const { data: me } = useApi<MeProbe>("/v1/me");
  // This is the same authoritative role probe used by the Coaching page.
  // It resolves persisted account links, fails closed for non-members, and
  // SWR dedupes it when the user opens /coaching itself.
  const { data: coachingMe } = useApi<CoachingMeProbe>("/v1/coaching/me");
  const hasCoachingAccess =
    me?.isAdmin === true ||
    coachingMe?.role === "admin" ||
    coachingMe?.role === "coach" ||
    coachingMe?.role === "student";

  const entries = NAV_ENTRIES.filter(
    (e) =>
      (!e.adminOnly || me?.isAdmin === true) &&
      (!e.coachingOnly || hasCoachingAccess) &&
      (!e.reviewsRollout || reviewsVisible(me?.isAdmin)) &&
      (!e.guidesFlag || guidesEnabled()),
  );
  const sections = entries.filter((e) => e.group === "section");
  const utilities = entries.filter((e) => e.group === "utility");
  const publicEntries = entries.filter((e) => e.publicRoute);
  const mobileTabs = sections.filter((e) => MOBILE_TAB_KEYS.includes(e.key));
  const sheetEntries = entries.filter((e) => !MOBILE_TAB_KEYS.includes(e.key));
  const inTabBar = activeKey != null && MOBILE_TAB_KEYS.includes(activeKey);

  // Close the More sheet on navigation.
  useEffect(() => {
    setSheetOpen(false);
  }, [pathname]);
  useEffect(() => {
    const media = window.matchMedia?.("(min-width:768px)");
    const close = () => { if (media?.matches) setSheetOpen(false); };
    close(); media?.addEventListener("change", close);
    return () => media?.removeEventListener("change", close);
  }, []);

  return (
    <div className="flex min-h-dvh">
      <aside className="app-rail-placeholder relative hidden w-16 shrink-0 md:block">
        {/* The expanded rail overlays content rather than pushing it, so
            hovering never reflows a table mid-read. */}
        <nav
          aria-label="App navigation"
          className={[
            "app-rail group/rail fixed inset-y-0 left-0 z-nav flex w-16 flex-col gap-1 overflow-y-auto overflow-x-hidden",
            "border-r-2 border-border bg-bg-surface px-2 pb-3 pt-[calc(env(safe-area-inset-top,0px)+0.75rem)]",
            "motion-safe:transition-[width] motion-safe:duration-150",
            "hover:w-56 focus-within:w-56 hover:shadow-hard",
          ].join(" ")}
        >
          <Link
            href="/"
            aria-label="SC2 Tools — home"
            className="mb-1 flex h-11 items-center gap-3 rounded-lg px-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <LogoMark size={30} className="shrink-0" priority />
            <RailLabel>SC2&nbsp;Tools</RailLabel>
          </Link>

          <ClerkLoading><div aria-hidden className="space-y-1">{Array.from({ length: 8 }, (_, index) => <div key={index} className="flex h-10 items-center px-2.5"><span className="h-[18px] w-[18px] rounded bg-bg-elevated motion-safe:animate-pulse" /></div>)}</div></ClerkLoading>
          <SignedIn>
            <RailGroup label="Analysis">{sections.map((entry) => (
              <RailLink
                key={entry.key}
                entry={entry}
                active={activeKey === entry.key}
                pinned={pinned}
                onNavigate={() => beginNavigation(entry.href)}
              />
            ))}</RailGroup>
            <span className="min-h-3 flex-1" />
            <span aria-hidden className="mx-1.5 border-t-2 border-border" />
            <RailGroup label="Your setup">{utilities.map((entry) => (
              <RailLink
                key={entry.key}
                entry={entry}
                active={activeKey === entry.key}
                pinned={pinned}
                onNavigate={() => beginNavigation(entry.href)}
              />
            ))}</RailGroup>
          </SignedIn>

          <SignedOut>
            {publicEntries.map((entry) => (
              <RailLink
                key={entry.key}
                entry={entry}
                active={activeKey === entry.key}
                pinned={pinned}
                onNavigate={() => beginNavigation(entry.href)}
              />
            ))}
            <span className="min-h-3 flex-1" />
          </SignedOut>
          <button type="button" aria-pressed={pinned} aria-label={pinned ? "Unpin sidebar" : "Pin sidebar"} onClick={togglePinned} className="mt-auto flex min-h-11 items-center gap-3 rounded-lg px-2.5 text-text-muted hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
            {pinned ? <PanelLeftClose className="h-5 w-5 shrink-0" aria-hidden /> : <PanelLeftOpen className="h-5 w-5 shrink-0" aria-hidden />}<RailLabel>{pinned ? "Unpin sidebar" : "Pin sidebar"}</RailLabel>
          </button>
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* pt: in the installed iOS app the status bar overlays the page
            (black-translucent), so the bar starts below the notch. */}
        <header className="sticky top-0 z-30 border-b-2 border-border bg-bg/90 pt-[env(safe-area-inset-top)] supports-[backdrop-filter]:backdrop-blur-md">
          <div className="mx-auto flex h-12 w-full max-w-[1680px] items-center gap-3 px-4 sm:px-6 lg:px-8">
            <Link
              href="/"
              aria-label="SC2 Tools — home"
              className="shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent md:hidden"
            >
              <LogoMark size={24} />
            </Link>

            {showBack ? (
              <Link
                href={backHref}
                onClick={(event) => backToGameSource(event, safeGameSource(backHref))}
                onNavigate={() => beginNavigation(backHref)}
                aria-label={backLabel}
                className="grid h-11 w-11 shrink-0 place-items-center md:h-8 md:w-8 rounded-full border-2 border-border text-text-muted hover:bg-bg-elevated hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <ChevronLeft className="h-4 w-4" aria-hidden />
              </Link>
            ) : null}

            {breadcrumb?.trail.length ? <nav aria-label="Breadcrumb" className="min-w-0 flex-1"><ol className="flex min-w-0 items-center gap-2">{breadcrumb.trail.map((crumb, index) => <li key={index} className={`${index < breadcrumb.trail.length - 1 ? "hidden sm:flex" : "flex"} min-w-0 items-center gap-2`}>{index ? <span aria-hidden>›</span> : null}{index === breadcrumb.trail.length - 1 ? <span aria-current="page" title={crumb.label} className="truncate font-semibold">{crumb.label}</span> : <Link href={crumb.href || "#"} title={crumb.label} className="truncate text-caption text-text-muted hover:text-text">{crumb.label}</Link>}</li>)}</ol></nav> : <TitleTag
              as={ownsHeading ? "h1" : "p"}
              icon={showBack ? undefined : match?.entry.icon}
              title={title}
            />}

            <div className="ml-auto flex shrink-0 items-center gap-2">
              <SignedIn>
                <BuildCheckInAlert compact />
                <CoachingBookingAlert compact />
                <NotificationBell compact />
                <WhatsNewButton />
              </SignedIn>
              <ThemeToggle size="sm" />
              <ClerkLoading><span aria-hidden className="h-8 w-8 rounded-full bg-bg-elevated motion-safe:animate-pulse" /></ClerkLoading>
              <SignedIn>
                {/* Phones reach the same items from the More sheet. */}
                <HelpMenu signedIn onReport={openReport} className="hidden md:block" />
                <span ref={accountRef} className="inline-flex"><UserButton
                  afterSignOutUrl="/"
                  appearance={{ elements: { avatarBox: "h-8 w-8" } }}
                >
                  {/* Ours first; listing Clerk's two defaults after keeps them below. */}
                  <UserButton.MenuItems>
                    <UserButton.Link label="Settings" labelIcon={<Settings className="h-4 w-4" aria-hidden />} href="/settings" />
                    <UserButton.Link label="Devices" labelIcon={<Cpu className="h-4 w-4" aria-hidden />} href="/devices" />
                    <UserButton.Link
                      label="Help"
                      labelIcon={<LifeBuoy className="h-4 w-4" aria-hidden />}
                      href="/help"
                    />
                    <UserButton.Action
                      label="Report a problem"
                      labelIcon={<Bug className="h-4 w-4" aria-hidden />}
                      onClick={() => openReport("problem")}
                    />
                    <UserButton.Action label="Appearance" labelIcon={<Monitor className="h-4 w-4" aria-hidden />} onClick={() => setAppearanceOpen(true)} />
                    <UserButton.Action label="manageAccount" />
                    <UserButton.Action label="signOut" />
                  </UserButton.MenuItems>
                </UserButton></span>
              </SignedIn>
              <SignedOut>
                <HelpMenu signedIn={false} />
                <AuthContextLink
                  kind="sign-in"
                  className="hard-press hidden h-8 items-center rounded-full border-2 border-line bg-bg-surface px-3.5 font-display text-caption font-bold text-text hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:inline-flex"
                >
                  Sign in
                </AuthContextLink>
                <AuthContextLink
                  kind="sign-up"
                  className="hard-press inline-flex h-8 items-center rounded-full border-2 border-line bg-accent px-3.5 font-display text-caption font-bold text-white hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  Get started
                </AuthContextLink>
              </SignedOut>
            </div>
          </div>
          <ConnectionBanner />
          <Suspense fallback={null}><SiteIncidentBanner /></Suspense>
          <Suspense fallback={null}><NavProgress onPendingChange={setNavPending} /></Suspense>
        </header>

        <SiteStats variant="app" wide analyzer={isAnalyzerPath(pathname)} signedIn={isSignedIn === true} syncStatus={<SignedIn><SyncStatus compact /></SignedIn>} />
        <SignedIn><PracticeChip /></SignedIn>

        <main
          id="main-content"
          aria-busy={navPending || undefined}
          tabIndex={-1}
          className="mx-auto w-full max-w-[1680px] flex-1 px-4 pb-24 pt-5 sm:px-6 md:pb-10 lg:px-8"
          data-testid="app-chrome-main"
        >
          {children}
        </main>
      </div>

      {/* Mobile: tab bar + More sheet. Signed-out visitors on /community
          get the same bar with just the public destinations. */}
      <nav
        ref={tabBarRef}
        aria-label="Quick sections"
        className="fixed inset-x-0 bottom-0 z-nav border-t-2 border-border bg-bg/95 pb-[env(safe-area-inset-bottom,0px)] supports-[backdrop-filter]:backdrop-blur-md md:hidden"
      >
        <div className="mx-auto flex max-w-md items-stretch px-2 py-1.5">
          <ClerkLoading>{Array.from({ length: 5 }, (_, index) => <div key={index} aria-hidden className="flex flex-1 flex-col items-center gap-1 py-1.5"><span className="h-5 w-5 rounded bg-bg-elevated motion-safe:animate-pulse" /><span className="h-2 w-7 rounded bg-bg-elevated" /></div>)}</ClerkLoading>
          <SignedIn>
            {mobileTabs.map((entry) => (
              <TabBarLink
                key={entry.key}
                entry={entry}
                active={activeKey === entry.key}
              />
            ))}
            <button
              ref={moreButtonRef}
              type="button"
              onClick={() => setSheetOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={sheetOpen}
              className={[
                "flex flex-1 flex-col items-center gap-0.5 rounded-lg px-1 py-1.5 text-micro font-bold",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                !inTabBar ? "bg-accent-cyan/10 text-accent-cyan" : "text-text-muted",
              ].join(" ")}
            >
              <MoreHorizontal className="h-5 w-5" aria-hidden />
              More
            </button>
          </SignedIn>
          <SignedOut>
            {publicEntries.map((entry) => (
              <TabBarLink
                key={entry.key}
                entry={entry}
                active={activeKey === entry.key}
              />
            ))}
            <AuthContextLink
              kind="sign-in"
              className="flex flex-1 flex-col items-center gap-0.5 rounded-lg px-1 py-1.5 text-micro font-bold text-text-muted hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <LogIn className="h-5 w-5" aria-hidden />
              Sign in
            </AuthContextLink>
          </SignedOut>
        </div>
      </nav>

      <ThemeDialog open={appearanceOpen} onClose={() => { setAppearanceOpen(false); queueMicrotask(() => accountRef.current?.querySelector<HTMLButtonElement>("button")?.focus()); }} />
      {sheetOpen ? (
        <MoreSheet
          entries={sheetEntries}
          activeKey={activeKey}
          onClose={() => setSheetOpen(false)}
          onReport={reportFromSheet}
        />
      ) : null}

      <SignedIn>
        <LazyReportIssueModal
          open={report.open}
          prefill={{ type: report.type }}
          onClose={closeReport}
        />
      </SignedIn>
    </div>
  );
}

/* ------------------------------------------------------------------
 * Pieces
 * ------------------------------------------------------------------ */

function beginNavigation(href: string) {
  const target = new URL(href, window.location.href);
  if (target.pathname + target.search !== window.location.pathname + window.location.search) startNavProgress();
}

function TitleTag({
  as: Tag,
  icon: Icon,
  title,
}: {
  as: "h1" | "p";
  icon?: NavIcon;
  title: string;
}) {
  return (
    <Tag className="flex min-w-0 items-center gap-2 font-display text-body-lg font-extrabold tracking-tight text-text">
      {Icon ? (
        <Icon className="h-[18px] w-[18px] shrink-0 text-accent-cyan" aria-hidden />
      ) : null}
      <span className="truncate">{title}</span>
    </Tag>
  );
}

function TabBarLink({ entry, active }: { entry: NavEntry; active: boolean }) {
  const Icon: NavIcon = entry.icon;
  return (
    <Link
      href={entry.href}
      onNavigate={() => beginNavigation(entry.href)}
      aria-current={active ? "page" : undefined}
      className={[
        "flex flex-1 flex-col items-center gap-0.5 rounded-lg px-1 py-1.5 text-micro font-bold",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        active ? "bg-accent-cyan/10 text-accent-cyan" : "text-text-muted hover:text-text",
      ].join(" ")}
    >
      <Icon className="h-5 w-5" aria-hidden />
      {entry.shortLabel ?? entry.label}
    </Link>
  );
}
