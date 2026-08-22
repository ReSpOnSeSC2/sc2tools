"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { SignedIn, SignedOut, UserButton } from "@clerk/nextjs";
import { ChevronLeft, MoreHorizontal, X } from "lucide-react";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { SyncStatus } from "@/components/SyncStatus";
import { useApi } from "@/lib/clientApi";
import {
  MOBILE_TAB_KEYS,
  NAV_ENTRIES,
  isAnalyzerPath,
  matchSurface,
  surfaceTitle,
  type NavEntry,
  type NavIcon,
} from "./appNav";

/* ------------------------------------------------------------------
 * AppChrome — the shell every signed-in surface renders inside:
 * Today and the analyzer sections, the custom-build library, meta,
 * community, agent, settings and admin.
 *
 *   - Desktop (md+): a 64px icon rail that expands to a labelled
 *     overlay on hover / keyboard focus. One navigation system for the
 *     whole product — the marketing header's links live here now.
 *   - Mobile: a bottom tab bar with the four highest-traffic
 *     destinations and a More sheet for the rest. No hamburger.
 *   - Both: a slim sticky context bar carrying the section name, a
 *     back control on detail pages, live sync state, theme and account.
 *
 * /meta and /community are reachable signed-out (shared links), so the
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

export function AppChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/app";
  const match = matchSurface(pathname);
  const activeKey = match?.entry.key ?? null;
  const title = surfaceTitle(pathname);
  const showBack = Boolean(match?.isDetail);
  // Analyzer sections have no page-level title of their own, so the
  // context bar is their <h1>. Settings, the build library, community,
  // meta and admin all render their own heading below, so there the bar
  // is a breadcrumb label and must not compete for the h1.
  const ownsHeading = match?.entry.group !== "utility";
  const backHref = match?.backHref ?? "/app";
  const [sheetOpen, setSheetOpen] = useState(false);

  // useApi gates on isSignedIn internally and SWR dedupes it against the
  // rest of the app, so this costs nothing extra and is a no-op for
  // signed-out visitors on /meta and /community.
  const { data: me } = useApi<MeProbe>("/v1/me");

  const entries = NAV_ENTRIES.filter(
    (e) => !e.adminOnly || me?.isAdmin === true,
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

            {isAnalyzerPath(pathname) && me?.userId && me.games ? (
              <div className="hidden min-w-0 lg:block">
                <SyncStatus
                  total={me.games.total}
                  latest={me.games.latest}
                  userId={me.userId}
                />
              </div>
            ) : null}

            <div className="ml-auto flex shrink-0 items-center gap-2">
              <ThemeToggle />
              <SignedIn>
                <UserButton
                  afterSignOutUrl="/"
                  appearance={{ elements: { avatarBox: "h-8 w-8" } }}
                />
              </SignedIn>
              <SignedOut>
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
        </header>

        <main
          id="main-content"
          tabIndex={-1}
          className="mx-auto w-full max-w-[1680px] flex-1 px-4 pb-24 pt-5 sm:px-6 md:pb-10 lg:px-8"
          data-testid="app-chrome-main"
        >
          {children}
        </main>
      </div>

      {/* Mobile: tab bar + More sheet. Signed-out visitors on /meta and
          /community get the same bar with just the public destinations. */}
      <nav
        aria-label="Quick sections"
        className="fixed inset-x-0 bottom-0 z-40 border-t-2 border-border bg-bg/95 pb-[env(safe-area-inset-bottom,0px)] supports-[backdrop-filter]:backdrop-blur-md md:hidden"
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
              className="flex flex-1 flex-col items-center gap-0.5 rounded-lg px-1 py-1.5 text-micro font-bold text-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
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
        />
      ) : null}
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
        active ? "bg-accent-cyan/10 text-accent" : "text-text-muted",
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
}: {
  entries: readonly NavEntry[];
  activeKey: string | null;
  onClose: () => void;
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
      className="fixed inset-0 z-50 md:hidden"
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
      </div>
    </div>
  );
}

function SheetLink({ entry, active }: { entry: NavEntry; active: boolean }) {
  const Icon: NavIcon = entry.icon;
  return (
    <Link
      href={entry.href}
      aria-current={active ? "page" : undefined}
      className={[
        "flex min-h-[44px] items-center gap-3 rounded-xl px-2.5 py-2 text-body font-semibold",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        active ? "bg-accent-cyan/10 text-accent" : "text-text hover:bg-bg-elevated",
      ].join(" ")}
    >
      <Icon className="h-5 w-5 shrink-0 text-text-muted" aria-hidden />
      {entry.label}
    </Link>
  );
}
