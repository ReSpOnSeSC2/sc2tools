"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Download } from "lucide-react";
import { AnalyzerShell } from "@/components/analyzer/AnalyzerShell";
import { NoGamesYet } from "@/components/analyzer/EmptyStates";
import { MobileSectionPicker } from "@/components/analyzer/MobileSectionPicker";
import { TABS, type TabId } from "@/components/analyzer/tabs";
import { SyncStatus } from "@/components/SyncStatus";
import { LiveGamePanel } from "@/components/dashboard/LiveGamePanel";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { useApi } from "@/lib/clientApi";
import {
  OnboardingChecklist,
  checklistVisible,
  type ChecklistMe,
} from "@/components/onboarding/OnboardingChecklist";
import { ImportProgressCard } from "@/components/imports/ImportProgressCard";
import { Card } from "@/components/ui/Card";
import { useImportStatus } from "@/components/imports/useImportStatus";
import { useUserSocket } from "@/lib/useUserSocket";

type Me = ChecklistMe & {
  userId: string;
  source: string;
  games: { total: number; latest: string | null };
};

export function DashboardLayout({
  me,
  initialOpponentId,
}: {
  me: Me;
  initialOpponentId?: string | null;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<TabId>("opponents");
  // A dossier backlink is explicit navigation and must win over a
  // later-arriving default-tab preference.
  const tabTouched = useRef(!!initialOpponentId);

  // Honour Settings → "Default tab". The preference loads async, so
  // apply it exactly once when it arrives — and never after the user
  // has navigated, so a slow fetch can't yank them off a tab they
  // already opened. Unknown values (e.g. the retired "ml" tab) are
  // ignored.
  const { data: misc } = useApi<{ defaultTab?: string }>(
    "/v1/me/preferences/misc",
  );
  useEffect(() => {
    if (tabTouched.current) return;
    const pref = misc?.defaultTab;
    if (pref && TABS.some((t) => t.id === pref)) {
      setTab(pref as TabId);
    }
  }, [misc]);

  const onTabChange = (next: string) => {
    tabTouched.current = true;
    setTab(next as TabId);
  };

  const noGames = me.games.total === 0;
  const activeTab = TABS.find((t) => t.id === tab) ?? TABS[0];
  const showChecklist = checklistVisible(me);

  // The server component handed us a snapshot of /v1/me; the funnel
  // changes it (pairing completes, the first imported games land).
  // Re-run the server fetch when the first games:changed arrives while
  // we're showing an empty state, debounced so a 25-games-per-batch
  // backfill doesn't refresh 200 times.
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

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h1 className="title-spine text-h1 font-bold">Dashboard</h1>
          <SyncStatus
            total={me.games.total}
            latest={me.games.latest}
            userId={me.userId}
          />
        </div>
        {!noGames ? (
          <MobileSectionPicker
            value={tab}
            onChange={onTabChange}
            active={activeTab}
          />
        ) : null}
        <Link
          href="/download"
          className="hard-press inline-flex min-h-[44px] items-center gap-2 self-start rounded-full border-2 border-line bg-bg-surface px-5 py-2 font-display text-body font-bold text-text hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg sm:self-auto"
        >
          <Download className="h-4 w-4" aria-hidden />
          Get the agent
        </Link>
      </header>

      {/* Live game card. Hidden by default; mounts a per-user SSE
          subscription and renders only while the desktop agent is
          actively reporting a non-idle phase. Drops out automatically
          ~30s after the last envelope so a stopped agent doesn't
          leave a stale card pinned to the dashboard. Boundary keeps a
          malformed live envelope from taking the dashboard down. */}
      <ErrorBoundary label="the live game panel">
        <LiveGamePanel />
      </ErrorBoundary>

      {/* Onboarding checklist until the funnel completes (paired +
          first games). While visible it replaces the NoGamesYet
          dead-end; once dismissed/complete, a running import still
          gets its own card below. */}
      {showChecklist ? (
        <OnboardingChecklist me={me} onRefresh={() => router.refresh()} />
      ) : (
        <ActiveImportCard />
      )}

      {noGames ? (
        showChecklist ? null : (
          <NoGamesYet />
        )
      ) : (
        <AnalyzerShell
          totalGames={me.games.total}
          tab={tab}
          onTabChange={onTabChange}
          initialOpponentId={initialOpponentId}
        />
      )}
    </div>
  );
}

/**
 * Standalone import progress for users past onboarding (e.g. they
 * kicked a full re-import from Settings, or the agent registered an
 * auto-backfill after a long offline stretch). Renders nothing when
 * no job is active.
 */
function ActiveImportCard() {
  const importStatus = useImportStatus();
  if (
    !importStatus.job ||
    (!importStatus.active && importStatus.job.status !== "stalled")
  ) return null;
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
