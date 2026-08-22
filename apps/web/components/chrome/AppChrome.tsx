"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { UserButton } from "@clerk/nextjs";
import {
  ChevronLeft,
  Cpu,
  Globe2,
  Library,
  MoreHorizontal,
  ShieldCheck,
  SlidersHorizontal,
  Users2,
  X,
  Zap,
} from "lucide-react";
import { AnalyzerProvider } from "@/components/AnalyzerProvider";
import { DoctorBanner } from "@/components/analyzer/DoctorBanner";
import { NoGamesYet } from "@/components/analyzer/EmptyStates";
import { FilterBar } from "@/components/analyzer/FilterBar";
import {
  TABS,
  hrefForTab,
  type NavIconComponent,
  type TabDef,
  type TabId,
} from "@/components/analyzer/tabs";
import { SyncStatus } from "@/components/SyncStatus";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { Card } from "@/components/ui/Card";
import {
  OnboardingChecklist,
  checklistVisible,
  type ChecklistMe,
} from "@/components/onboarding/OnboardingChecklist";
import { ImportProgressCard } from "@/components/imports/ImportProgressCard";
import { useImportStatus } from "@/components/imports/useImportStatus";
import { useUserSocket } from "@/lib/useUserSocket";

/* ------------------------------------------------------------------
 * AppChrome — the signed-in application shell.
 *
 * Every /app route renders inside this chrome:
 *
 *   - Desktop (md+): a 64px icon rail on the left that expands to a
 *     labelled 224px overlay on hover / keyboard focus. One navigation
 *     system for all sections plus the account-level destinations
 *     (custom-build library, agent, settings, meta, community, admin).
 *   - Mobile: a bottom tab bar with the four highest-traffic sections
 *     and a "More" sheet for the rest.
 *   - Both: a slim sticky context bar (section identity, live sync
 *     status, theme, account) that replaces the old stacked H1 +
 *     description + KPI header block, and the global FilterBar row
 *     directly under it.
 *
 * The chrome also owns the cross-section concerns the old
 * DashboardLayout carried: the onboarding checklist / import-progress
 * gate, the empty state for zero games, and the socket-driven refresh
 * that re-runs the server layout while the first games land.
 * ------------------------------------------------------------------ */

export type DashboardMe = ChecklistMe & {
  userId: string;
  source: string;
  games: { total: number; latest: string | null };
  agentVersion?: string | null;
  isAdmin?: boolean;
};

const MeContext = createContext<DashboardMe | null>(null);

/** Live /v1/me snapshot fetched by the app layout; usable from any /app page. */
export function useDashboardMe(): DashboardMe {
  const me = useContext(MeContext);
  if (!me) {
    throw new Error("useDashboardMe must be used inside AppChrome");
  }
  return me;
}

type SectionKey = "today" | TabId | "game";

function sectionFromPathname(pathname: string): SectionKey {
  if (pathname === "/app" || pathname === "/app/") return "today";
  if (pathname.startsWith("/app/game/") || pathname === "/app/game") {
    return "game";
  }
  const slug = pathname.split("/")[2] ?? "";
  if (slug === "opponents") return "opponents";
  const tab = TABS.find((t) => hrefForTab(t.id) === `/app/${slug}`);
  return tab ? tab.id : "today";
}

const SECTION_TITLES: Record<SectionKey, string> = {
  today: "Today",
  game: "Replay",
  ...Object.fromEntries(TABS.map((t) => [t.id, t.label])),
} as Record<SectionKey, string>;

/** Bottom tab bar carries the four highest-traffic destinations. */
const MOBILE_TABS: readonly TabId[] = ["opponents", "builds", "battlefield"];

type UtilityLink = {
  href: string;
  label: string;
  icon: NavIconComponent | typeof Cpu;
  adminOnly?: boolean;
};

const UTILITY_LINKS: readonly UtilityLink[] = [
  { href: "/builds", label: "Custom builds", icon: Library },
  { href: "/devices", label: "Agent", icon: Cpu },
  { href: "/settings", label: "Settings", icon: SlidersHorizontal },
  { href: "/meta", label: "Meta", icon: Globe2 },
  { href: "/community", label: "Community", icon: Users2 },
  { href: "/admin", label: "Admin", icon: ShieldCheck, adminOnly: true },
];

export function AppChrome({
  me,
  children,
}: {
  me: DashboardMe;
  children: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname() ?? "/app";
  const section = sectionFromPathname(pathname);
  const isGameRoute = section === "game";
  const isDossierRoute =
    section === "opponents" && pathname.split("/").length > 3;
  const [sheetOpen, setSheetOpen] = useState(false);

  // Close the More sheet whenever navigation happens.
  useEffect(() => {
    setSheetOpen(false);
  }, [pathname]);

  const noGames = me.games.total === 0;
  const showChecklist = checklistVisible(me);

  // The layout handed us a server snapshot of /v1/me; the onboarding
  // funnel changes it (pairing completes, first imported games land).
  // Re-run the server fetch when games:changed arrives while we're in
  // that window, debounced so a 25-games-per-batch backfill doesn't
  // refresh 200 times.
  const refreshTimer = useRef<number | null>(null);
  const needsRefreshOnGames = noGames || showChecklist;
  const socketHandlers = useMemo(
    () =>
      needsRefreshOnGames
        ? {
            "games:changed": () => {
              if (refreshTimer.current != null) return;
              refreshTimer.current = window.setTimeout(() => {
                refreshTimer.current = null;
                router.refresh();
              }, 1500);
            },
          }
        : null,
    [needsRefreshOnGames, router],
  );
  useUserSocket(socketHandlers);
  useEffect(
    () => () => {
      if (refreshTimer.current != null) {
        window.clearTimeout(refreshTimer.current);
      }
    },
    [],
  );

  const utilityLinks = UTILITY_LINKS.filter(
    (l) => !l.adminOnly || me.isAdmin === true,
  );

  return (
    <MeContext.Provider value={me}>
      <AnalyzerProvider analysisGamesEnabled={section === "arcade"}>
        <div className="flex min-h-dvh">
          <DesktopRail section={section} utilityLinks={utilityLinks} />

          <div className="flex min-w-0 flex-1 flex-col">
            <ContextBar
              section={section}
              isDossierRoute={isDossierRoute}
              me={me}
            />

            <main
              className="mx-auto w-full max-w-[1680px] flex-1 px-4 pb-24 pt-5 sm:px-6 md:pb-10 lg:px-8"
              data-testid="app-chrome-main"
            >
              {isGameRoute ? (
                children
              ) : (
                <div className="space-y-5">
                  <DoctorBanner />

                  <div className="rounded-xl border-2 border-line bg-bg-surface px-3 py-3 shadow-hard sm:py-2">
                    <FilterBar />
                  </div>

                  {/* Onboarding checklist until the funnel completes
                      (paired + first games). Once dismissed/complete, a
                      running import still gets its own card. */}
                  {showChecklist ? (
                    <OnboardingChecklist
                      me={me}
                      onRefresh={() => router.refresh()}
                    />
                  ) : (
                    <ActiveImportCard />
                  )}

                  {noGames ? (
                    showChecklist ? null : (
                      <NoGamesYet />
                    )
                  ) : (
                    children
                  )}
                </div>
              )}
            </main>
          </div>
        </div>

        <MobileTabBar
          section={section}
          onMore={() => setSheetOpen(true)}
          moreOpen={sheetOpen}
        />
        <MoreSheet
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          section={section}
          utilityLinks={utilityLinks}
        />
      </AnalyzerProvider>
    </MeContext.Provider>
  );
}

/* ------------------------------------------------------------------
 * Desktop rail
 * ------------------------------------------------------------------ */

function DesktopRail({
  section,
  utilityLinks,
}: {
  section: SectionKey;
  utilityLinks: readonly UtilityLink[];
}) {
  return (
    <aside className="relative hidden w-16 shrink-0 md:block">
      {/* The expanding surface overlays content instead of pushing it,
          so hover never reflows a data table mid-read. */}
      <nav
        aria-label="App navigation"
        className={[
          "group/rail fixed inset-y-0 left-0 z-40 flex w-16 flex-col gap-1 overflow-y-auto overflow-x-hidden",
          "border-r-2 border-border bg-bg-surface px-2 py-3",
          "motion-safe:transition-[width] motion-safe:duration-150",
          "hover:w-56 focus-within:w-56 hover:shadow-hard",
        ].join(" ")}
      >
        <Link
          href="/"
          aria-label="SC2 Tools — home"
          className="mb-1 flex h-11 items-center gap-3 rounded-lg px-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <Image
            src="/logo.png"
            alt=""
            width={30}
            height={30}
            className="shrink-0 rounded-full"
            priority
          />
          <span className="whitespace-nowrap font-display text-body font-extrabold tracking-tight text-text opacity-0 transition-opacity group-hover/rail:opacity-100 group-focus-within/rail:opacity-100">
            SC2&nbsp;Tools
          </span>
        </Link>

        <RailLink
          href="/app"
          label="Today"
          icon={Zap}
          active={section === "today"}
        />
        {TABS.map((tab) => (
          <RailLink
            key={tab.id}
            href={hrefForTab(tab.id)}
            label={tab.label}
            icon={tab.icon}
            active={section === tab.id}
          />
        ))}

        <span className="min-h-3 flex-1" />
        <span
          aria-hidden
          className="mx-1.5 border-t-2 border-border"
        />

        {utilityLinks.map((l) => (
          <RailLink
            key={l.href}
            href={l.href}
            label={l.label}
            icon={l.icon}
            active={false}
          />
        ))}
      </nav>
    </aside>
  );
}

function RailLink({
  href,
  label,
  icon: Icon,
  active,
}: {
  href: string;
  label: string;
  icon: NavIconComponent | typeof Cpu;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      title={label}
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
      <span className="whitespace-nowrap font-display text-caption font-bold opacity-0 transition-opacity group-hover/rail:opacity-100 group-focus-within/rail:opacity-100">
        {label}
      </span>
    </Link>
  );
}

/* ------------------------------------------------------------------
 * Context bar
 * ------------------------------------------------------------------ */

function ContextBar({
  section,
  isDossierRoute,
  me,
}: {
  section: SectionKey;
  isDossierRoute: boolean;
  me: DashboardMe;
}) {
  const title = SECTION_TITLES[section] ?? "Dashboard";
  const showBack = section === "game" || isDossierRoute;
  const backHref = isDossierRoute ? "/app/opponents" : "/app";
  const activeTab: TabDef | undefined = TABS.find((t) => t.id === section);
  const SectionIcon = section === "today" ? Zap : activeTab?.icon;

  return (
    <header className="sticky top-0 z-30 border-b-2 border-border bg-bg/90 supports-[backdrop-filter]:backdrop-blur-md">
      <div className="mx-auto flex h-12 w-full max-w-[1680px] items-center gap-3 px-4 sm:px-6 lg:px-8">
        <Link
          href="/"
          aria-label="SC2 Tools — home"
          className="shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent md:hidden"
        >
          <Image
            src="/logo.png"
            alt=""
            width={24}
            height={24}
            className="rounded-full"
          />
        </Link>

        {showBack ? (
          <Link
            href={backHref}
            aria-label={isDossierRoute ? "All opponents" : "Back to Today"}
            className="hidden h-8 w-8 shrink-0 place-items-center rounded-full border-2 border-border text-text-muted hover:bg-bg-elevated hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent md:grid"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden />
          </Link>
        ) : null}

        <h1 className="flex min-w-0 items-center gap-2 font-display text-body-lg font-extrabold tracking-tight text-text">
          {SectionIcon ? (
            <SectionIcon
              className="h-[18px] w-[18px] shrink-0 text-accent-cyan"
              aria-hidden
            />
          ) : null}
          <span className="truncate">{title}</span>
        </h1>

        <div className="hidden min-w-0 lg:block">
          <SyncStatus
            total={me.games.total}
            latest={me.games.latest}
            userId={me.userId}
          />
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <ThemeToggle />
          <UserButton
            afterSignOutUrl="/"
            appearance={{ elements: { avatarBox: "h-8 w-8" } }}
          />
        </div>
      </div>
    </header>
  );
}

/* ------------------------------------------------------------------
 * Mobile: bottom tab bar + More sheet
 * ------------------------------------------------------------------ */

function MobileTabBar({
  section,
  onMore,
  moreOpen,
}: {
  section: SectionKey;
  onMore: () => void;
  moreOpen: boolean;
}) {
  const inBar =
    section === "today" || MOBILE_TABS.includes(section as TabId);

  return (
    <nav
      aria-label="Quick sections"
      className="fixed inset-x-0 bottom-0 z-40 border-t-2 border-border bg-bg/95 pb-[env(safe-area-inset-bottom,0px)] supports-[backdrop-filter]:backdrop-blur-md md:hidden"
    >
      <div className="mx-auto flex max-w-md items-stretch px-2 py-1.5">
        <TabBarLink
          href="/app"
          label="Today"
          icon={Zap}
          active={section === "today"}
        />
        {MOBILE_TABS.map((id) => {
          const tab = TABS.find((t) => t.id === id)!;
          return (
            <TabBarLink
              key={id}
              href={hrefForTab(id)}
              label={tab.label}
              icon={tab.icon}
              active={section === id}
            />
          );
        })}
        <button
          type="button"
          onClick={onMore}
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          className={[
            "flex flex-1 flex-col items-center gap-0.5 rounded-lg px-1 py-1.5",
            "text-micro font-bold",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
            !inBar && section !== "game"
              ? "text-accent"
              : "text-text-muted",
          ].join(" ")}
        >
          <MoreHorizontal className="h-5 w-5" aria-hidden />
          More
        </button>
      </div>
    </nav>
  );
}

function TabBarLink({
  href,
  label,
  icon: Icon,
  active,
}: {
  href: string;
  label: string;
  icon: NavIconComponent | typeof Zap;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={[
        "flex flex-1 flex-col items-center gap-0.5 rounded-lg px-1 py-1.5 text-micro font-bold",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        active ? "bg-accent-cyan/10 text-accent" : "text-text-muted",
      ].join(" ")}
    >
      <Icon className="h-5 w-5" aria-hidden />
      {label}
    </Link>
  );
}

function MoreSheet({
  open,
  onClose,
  section,
  utilityLinks,
}: {
  open: boolean;
  onClose: () => void;
  section: SectionKey;
  utilityLinks: readonly UtilityLink[];
}) {
  // Esc closes; body scroll locks while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  const sheetSections = TABS.filter((t) => !MOBILE_TABS.includes(t.id));

  return (
    <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label="More sections">
      <button
        type="button"
        aria-label="Close menu"
        onClick={onClose}
        className="absolute inset-0 bg-black/50"
      />
      <div className="absolute inset-x-0 bottom-0 max-h-[80dvh] overflow-y-auto rounded-t-2xl border-t-2 border-border-strong bg-bg-surface px-3 pb-[max(env(safe-area-inset-bottom,0px),12px)] pt-2">
        <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-border-strong" aria-hidden />
        <div className="flex items-center justify-between px-2 py-1">
          <span className="overline text-micro font-bold uppercase tracking-[0.14em] text-text-dim">
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
        {sheetSections.map((tab) => (
          <SheetLink
            key={tab.id}
            href={hrefForTab(tab.id)}
            label={tab.label}
            icon={tab.icon}
            active={section === tab.id}
          />
        ))}
        <div className="px-2 pb-1 pt-3">
          <span className="text-micro font-bold uppercase tracking-[0.14em] text-text-dim">
            Your setup
          </span>
        </div>
        {utilityLinks.map((l) => (
          <SheetLink
            key={l.href}
            href={l.href}
            label={l.label}
            icon={l.icon}
            active={false}
          />
        ))}
        <div className="mt-2 flex items-center justify-between border-t-2 border-border px-2 pt-3">
          <span className="text-caption font-semibold text-text-muted">
            Theme
          </span>
          <ThemeToggle />
        </div>
      </div>
    </div>
  );
}

function SheetLink({
  href,
  label,
  icon: Icon,
  active,
}: {
  href: string;
  label: string;
  icon: NavIconComponent | typeof Cpu;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={[
        "flex min-h-[44px] items-center gap-3 rounded-xl px-2.5 py-2 text-body font-semibold",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        active
          ? "bg-accent-cyan/10 text-accent"
          : "text-text hover:bg-bg-elevated",
      ].join(" ")}
    >
      <Icon className="h-5 w-5 shrink-0 text-text-muted" aria-hidden />
      {label}
    </Link>
  );
}

/* ------------------------------------------------------------------
 * Import progress (users past onboarding — e.g. a full re-import from
 * Settings, or an agent auto-backfill). Renders nothing when idle.
 * ------------------------------------------------------------------ */

function ActiveImportCard() {
  const importStatus = useImportStatus();
  if (
    !importStatus.job ||
    (!importStatus.active && importStatus.job.status !== "stalled")
  ) {
    return null;
  }
  return (
    <Card>
      <ImportProgressCard
        job={importStatus.job}
        active={importStatus.active}
        pct={importStatus.pct}
        etaSeconds={importStatus.etaSeconds}
        onCancelled={importStatus.refresh}
      />
    </Card>
  );
}
