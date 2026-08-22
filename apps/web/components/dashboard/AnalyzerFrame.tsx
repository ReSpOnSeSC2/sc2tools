"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import { AnalyzerProvider } from "@/components/AnalyzerProvider";
import { DoctorBanner } from "@/components/analyzer/DoctorBanner";
import { NoGamesYet } from "@/components/analyzer/EmptyStates";
import { FilterBar } from "@/components/analyzer/FilterBar";
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
 * AnalyzerFrame — the concerns that belong to /app specifically, as
 * opposed to the chrome that wraps every signed-in surface:
 *
 *   - AnalyzerProvider: shared filter state + the dbRev counter, with
 *     the full replay corpus enabled only while Arcade is open.
 *   - The doctor banner and the global date FilterBar.
 *   - The onboarding gate: the checklist until pairing + first games
 *     complete, then the zero-games empty state, then the section.
 *   - A debounced router.refresh() while those first games land.
 *
 * Settings, the build library, community, meta, agent and admin get
 * the chrome without any of this — a date filter would be meaningless
 * there, and an empty replay library must never block Settings.
 * ------------------------------------------------------------------ */

export type DashboardMe = ChecklistMe & {
  userId: string;
  source: string;
  games: { total: number; latest: string | null };
  agentVersion?: string | null;
  isAdmin?: boolean;
};

const MeContext = createContext<DashboardMe | null>(null);

/** The /v1/me snapshot fetched by the app layout. Analyzer routes only. */
export function useDashboardMe(): DashboardMe {
  const me = useContext(MeContext);
  if (!me) {
    throw new Error("useDashboardMe must be used inside AnalyzerFrame");
  }
  return me;
}

export function AnalyzerFrame({
  me,
  children,
}: {
  me: DashboardMe;
  children: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname() ?? "/app";
  const isGameRoute =
    pathname === "/app/game" || pathname.startsWith("/app/game/");
  const isArcade = pathname === "/app/arcade";

  const noGames = me.games.total === 0;
  const showChecklist = checklistVisible(me);

  // The layout handed us a server snapshot of /v1/me; the onboarding
  // funnel changes it (pairing completes, first imported games land).
  // Re-run the server fetch when games:changed arrives during that
  // window, debounced so a 25-games-per-batch backfill doesn't refresh
  // two hundred times.
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
    <MeContext.Provider value={me}>
      <AnalyzerProvider analysisGamesEnabled={isArcade}>
        {isGameRoute ? (
          children
        ) : (
          <div className="space-y-5">
            <DoctorBanner />

            <div className="rounded-xl border-2 border-line bg-bg-surface px-3 py-3 shadow-hard sm:py-2">
              <FilterBar />
            </div>

            {showChecklist ? (
              <OnboardingChecklist me={me} onRefresh={() => router.refresh()} />
            ) : (
              <ActiveImportCard />
            )}

            {noGames ? showChecklist ? null : <NoGamesYet /> : children}
          </div>
        )}
      </AnalyzerProvider>
    </MeContext.Provider>
  );
}

/**
 * Import progress for users past onboarding — a full re-import kicked
 * from Settings, or an agent auto-backfill after a long offline
 * stretch. Renders nothing when no job is active.
 */
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
