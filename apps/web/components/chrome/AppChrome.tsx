"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SignedIn, SignedOut, UserButton } from "@clerk/nextjs";
import { Bug, ChevronLeft, LifeBuoy, MoreHorizontal, X } from "lucide-react";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
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
import { helpMenuItems, type HelpMenuItem } from "./helpMenu";
import { BuildCheckInAlert } from "@/components/build-checkin/BuildCheckInAlert";
import { BuildCheckInProvider } from "@/components/build-checkin/BuildCheckInProvider";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { reviewsVisible } from "@/lib/reviews";
import { guidesEnabled } from "@/lib/guides/flags";
import { SiteStats } from "./SiteStats";
import { useChromeBottomInset } from "./chromeInsets";
import { LogoMark } from "./LogoMark";

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
 * put, so there is no layout jump while Clerk resolves.
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
        <AppChromeShell>{children}</AppChromeShell>
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
  const ownsHeading = match?.entry.group !== "utility";
  const backHref = match?.backHref ?? "/app";
  const [sheetOpen, setSheetOpen] = useState(false);
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

  return (
    <div className="flex min-h-dvh">
      <aside className="relative hidden w-16 shrink-0 md:block">
        {/* The expanded rail overlays content rather than pushing it, so
            hovering never reflows a table mid-read. */}
        <nav
          aria-label="App navigation"
          className={[
            "group/rail fixed inset-y-0 left-0 z-nav flex w-16 flex-col gap-1 overflow-y-auto overflow-x-hidden",
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

          <SignedIn>
            {sections.map((entry) => (
              <RailLink
                key={entry.key}
                entry={entry}
                active={activeKey === entry.key}
              />
            ))}
            <span className="min-h-3 flex-1" />
            <span aria-hidden className="mx-1.5 border-t-2 border-border" />
            {utilities.map((entry) => (
              <RailLink
                key={entry.key}
                entry={entry}
                active={activeKey === entry.key}
              />
            ))}
          </SignedIn>

          <SignedOut>
            {publicEntries.map((entry) => (
              <RailLink
                key={entry.key}
                entry={entry}
                active={activeKey === entry.key}
              />
            ))}
            <span className="min-h-3 flex-1" />
          </SignedOut>
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
                aria-label={`Back to ${title}`}
                className="grid h-8 w-8 shrink-0 place-items-center rounded-full border-2 border-border text-text-muted hover:bg-bg-elevated hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <ChevronLeft className="h-4 w-4" aria-hidden />
              </Link>
            ) : null}

            <TitleTag
              as={ownsHeading ? "h1" : "p"}
              icon={showBack ? undefined : match?.entry.icon}
              title={title}
            />

            <div className="ml-auto flex shrink-0 items-center gap-2">
              <SignedIn>
                <BuildCheckInAlert compact />
                <CoachingBookingAlert compact />
                <NotificationBell compact />
              </SignedIn>
              <ThemeToggle />
              <SignedIn>
                {/* Phones reach the same items from the More sheet. */}
                <HelpMenu signedIn onReport={openReport} className="hidden md:block" />
                <UserButton
                  afterSignOutUrl="/"
                  appearance={{ elements: { avatarBox: "h-8 w-8" } }}
                >
                  {/* Ours first; listing Clerk's two defaults after keeps them below. */}
                  <UserButton.MenuItems>
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
                    <UserButton.Action label="manageAccount" />
                    <UserButton.Action label="signOut" />
                  </UserButton.MenuItems>
                </UserButton>
              </SignedIn>
              <SignedOut>
                <HelpMenu signedIn={false} />
                <Link
                  href="/sign-in"
                  className="hard-press hidden h-8 items-center rounded-full border-2 border-line bg-bg-surface px-3.5 font-display text-caption font-bold text-text hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:inline-flex"
                >
                  Sign in
                </Link>
                <Link
                  href="/sign-up"
                  className="hard-press inline-flex h-8 items-center rounded-full border-2 border-line bg-accent px-3.5 font-display text-caption font-bold text-white hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  Get started
                </Link>
              </SignedOut>
            </div>
          </div>
          <ConnectionBanner />
        </header>

        <SiteStats
          wide
          syncStatus={isAnalyzerPath(pathname) && me?.userId && me.games ? (
            <SyncStatus
              compact
              total={me.games.total}
              latest={me.games.latest}
              userId={me.userId}
            />
          ) : undefined}
        />

        <main
          id="main-content"
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
                !inTabBar ? "bg-accent-cyan/10 text-accent" : "text-text-muted",
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
            <Link
              href="/sign-in"
              className="flex flex-1 flex-col items-center gap-0.5 rounded-lg px-1 py-1.5 text-micro font-bold text-text-muted hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <MoreHorizontal className="h-5 w-5" aria-hidden />
              Sign in
            </Link>
          </SignedOut>
        </div>
      </nav>

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

function RailLabel({ children }: { children: ReactNode }) {
  return (
    <span className="whitespace-nowrap font-display text-caption font-bold opacity-0 transition-opacity group-hover/rail:opacity-100 group-focus-within/rail:opacity-100">
      {children}
    </span>
  );
}

function RailLink({ entry, active }: { entry: NavEntry; active: boolean }) {
  const Icon: NavIcon = entry.icon;
  return (
    <Link
      href={entry.href}
      aria-current={active ? "page" : undefined}
      title={entry.label}
      className={[
        "flex h-10 items-center gap-3 rounded-lg border-2 px-2.5",
        "motion-safe:transition-colors motion-safe:duration-150",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        active
          ? "border-accent-cyan/40 bg-accent-cyan/10 text-accent"
          : "border-transparent text-text-muted hover:bg-bg-elevated hover:text-text",
      ].join(" ")}
    >
      <Icon className="h-[18px] w-[18px] shrink-0" aria-hidden />
      <RailLabel>{entry.label}</RailLabel>
    </Link>
  );
}

function TabBarLink({ entry, active }: { entry: NavEntry; active: boolean }) {
  const Icon: NavIcon = entry.icon;
  return (
    <Link
      href={entry.href}
      aria-current={active ? "page" : undefined}
      className={[
        "flex flex-1 flex-col items-center gap-0.5 rounded-lg px-1 py-1.5 text-micro font-bold",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        active ? "bg-accent-cyan/10 text-accent" : "text-text-muted hover:text-text",
      ].join(" ")}
    >
      <Icon className="h-5 w-5" aria-hidden />
      {entry.label}
    </Link>
  );
}

function MoreSheet({
  entries,
  activeKey,
  onClose,
  onReport,
}: {
  entries: readonly NavEntry[];
  activeKey: string | null;
  onClose: () => void;
  onReport: (type: ReportType) => void;
}) {
  // Esc closes; body scroll locks while open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  const sections = entries.filter((e) => e.group === "section");
  const utilities = entries.filter((e) => e.group === "utility");

  return (
    <div
      className="fixed inset-0 z-sheet md:hidden"
      role="dialog"
      aria-modal="true"
      aria-label="More sections"
    >
      <button
        type="button"
        aria-label="Close menu"
        onClick={onClose}
        className="absolute inset-0 bg-black/50"
      />
      <div className="absolute inset-x-0 bottom-0 max-h-[80dvh] overflow-y-auto rounded-t-2xl border-t-2 border-border-strong bg-bg-surface px-3 pb-[max(env(safe-area-inset-bottom,0px),12px)] pt-2">
        <div
          className="mx-auto mb-2 h-1 w-10 rounded-full bg-border-strong"
          aria-hidden
        />
        <div className="flex items-center justify-between px-2 py-1">
          <span className="text-micro font-bold uppercase tracking-[0.14em] text-text-dim">
            Analysis
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-9 w-9 place-items-center rounded-full text-text-muted hover:bg-bg-elevated hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        {sections.map((entry) => (
          <SheetLink
            key={entry.key}
            entry={entry}
            active={activeKey === entry.key}
          />
        ))}
        <div className="px-2 pb-1 pt-3">
          <span className="text-micro font-bold uppercase tracking-[0.14em] text-text-dim">
            Your setup
          </span>
        </div>
        {utilities.map((entry) => (
          <SheetLink
            key={entry.key}
            entry={entry}
            active={activeKey === entry.key}
          />
        ))}
        <div className="px-2 pb-1 pt-3">
          <span className="text-micro font-bold uppercase tracking-[0.14em] text-text-dim">
            Help &amp; support
          </span>
        </div>
        {helpMenuItems(true).map((item) => (
          <SheetHelpItem key={item.key} item={item} onReport={onReport} />
        ))}
      </div>
    </div>
  );
}

const SHEET_ROW_CLASS = [
  "flex min-h-[44px] w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left text-body font-semibold",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
].join(" ");

function SheetLink({ entry, active }: { entry: NavEntry; active: boolean }) {
  const Icon: NavIcon = entry.icon;
  return (
    <Link
      href={entry.href}
      aria-current={active ? "page" : undefined}
      className={[
        SHEET_ROW_CLASS,
        active ? "bg-accent-cyan/10 text-accent" : "text-text hover:bg-bg-elevated",
      ].join(" ")}
    >
      <Icon className="h-5 w-5 shrink-0 text-text-muted" aria-hidden />
      {entry.label}
    </Link>
  );
}

function SheetHelpItem({
  item,
  onReport,
}: {
  item: HelpMenuItem;
  onReport: (type: ReportType) => void;
}) {
  const Icon: NavIcon = item.icon;
  const className = `${SHEET_ROW_CLASS} text-text hover:bg-bg-elevated`;
  if (item.report) {
    const type = item.report;
    return (
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={() => onReport(type)}
        className={className}
      >
        <Icon className="h-5 w-5 shrink-0 text-text-muted" aria-hidden />
        {item.label}
      </button>
    );
  }
  return (
    <Link href={item.href} className={className}>
      <Icon className="h-5 w-5 shrink-0 text-text-muted" aria-hidden />
      {item.label}
    </Link>
  );
}
