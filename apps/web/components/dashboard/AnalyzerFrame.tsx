"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import dynamic from "next/dynamic";
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
import { useInstantImport } from "@/lib/instant/useInstantImport";
import { useUserSocket } from "@/lib/useUserSocket";

// Loaded only when browser import is enabled, so the flag-off /app bundle
// does not carry the Folder Sync runner and the engine client.
const FolderSyncAutoRunner = dynamic(
  () => import("@/components/instant/FolderSyncAutoRunner").then((mod) => mod.FolderSyncAutoRunner),
  { ssr: false },
);

/* ------------------------------------------------------------------
 * AnalyzerFrame — the concerns that belong to /app specifically, as
 * opposed to the chrome that wraps every signed-in surface:
 *
 *   - AnalyzerProvider: shared filter state + the dbRev counter, with
 *     the full replay corpus enabled only while Arcade is open.
 *   - The doctor banner and the global date FilterBar.
 *   - The onboarding gate: the checklist until pairing + first games
 *     complete, then the zero-games empty state, then the section.
 *     With browser import enabled (Instant Analysis flag) games alone
 *     complete it, and a new account that has not started the agent
 *     path (no download, no pairing) sees the two options side by side
 *     (NoGamesYet: desktop agent | import in the browser) instead of the
 *     agent checklist.
 *   - A debounced router.refresh() while those first games land.
 *   - Background Folder Sync (browser import) while /app is open.
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

/** Which onboarding surface /app shows. */
export interface OnboardingView {
  /** The agent checklist (download → pair → first games). */
  checklist: boolean;
  /** The zero-games empty state (both import options when browser import is on). */
  noGamesYet: boolean;
}

/**
 * Decide between the checklist and the zero-games choice. With browser
 * import on, an account with no games that has neither paired an agent
 * nor started its download has not picked a path yet, so it gets both
 * options side by side; the checklist stays for the agent path.
 *
 * Example:
 *   onboardingView({ games: { total: 0 }, agentPaired: false }, true); // -> { checklist: false, noGamesYet: true }
 */
export function onboardingView(me: ChecklistMe, browserImportEnabled: boolean): OnboardingView {
  const noGames = me.games.total === 0;
  const undecided = browserImportEnabled && noGames && !me.agentPaired && !me.onboarding?.downloadStartedAt;
  const checklist = !undecided && checklistVisible(me, { browserImportEnabled });
  return { checklist, noGamesYet: noGames && !checklist };
}

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

  const { enabled: browserImportEnabled } = useInstantImport();
  const noGames = me.games.total === 0;
  const view = onboardingView(me, browserImportEnabled);
  useRefreshWhileOnboarding(noGames || view.checklist);

  return (
    <MeContext.Provider value={me}>
      <AnalyzerProvider analysisGamesEnabled={isArcade}>
        {isGameRoute ? (
          <>
            {browserImportEnabled ? <FolderSyncAutoRunner className="mb-4" /> : null}
            {children}
          </>
        ) : (
          <div className="space-y-5">
            <DoctorBanner />

            {browserImportEnabled ? <FolderSyncAutoRunner /> : null}

            <div className="rounded-xl border-2 border-line bg-bg-surface px-3 py-3 shadow-hard sm:py-2">
              <FilterBar />
            </div>

            {view.checklist ? (
              <OnboardingChecklist
                me={me}
                onRefresh={() => router.refresh()}
                browserImportEnabled={browserImportEnabled}
              />
            ) : (
              <ActiveImportCard />
            )}

            {view.noGamesYet ? (
              <NoGamesYet browserImportEnabled={browserImportEnabled} />
            ) : null}
            {noGames ? null : children}
          </div>
        )}
      </AnalyzerProvider>
    </MeContext.Provider>
  );
}

/**
 * The layout handed us a server snapshot of /v1/me; the onboarding
 * funnel changes it (pairing completes, first imported games land —
 * from the agent or a browser import). Re-run the server fetch when
 * games:changed arrives during that window, debounced so a
 * 25-games-per-batch backfill doesn't refresh two hundred times.
 */
function useRefreshWhileOnboarding(needsRefreshOnGames: boolean): void {
  const router = useRouter();
  const refreshTimer = useRef<number | null>(null);
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
