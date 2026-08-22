"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { DailyPulse } from "@/components/analyzer/DailyPulse";
import { DashboardKpiStrip } from "@/components/analyzer/DashboardKpiStrip";
import { LadderPulse } from "@/components/analyzer/LadderPulse";
import {
  hrefForTab,
  isTabId,
  opponentDossierHref,
} from "@/components/analyzer/tabs";
import { AgentUpgradeNotice } from "@/components/dashboard/AgentUpgradeNotice";
import { LiveGamePanel } from "@/components/dashboard/LiveGamePanel";
import { useDashboardMe } from "@/components/dashboard/AnalyzerFrame";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { useApi } from "@/lib/clientApi";

/**
 * Applied at most once per browser session so the preference lands you
 * on your chosen section, but navigating back to Today afterwards
 * doesn't bounce you away again.
 */
const DEFAULT_TAB_APPLIED_KEY = "sc2tools.defaultTabApplied";

/**
 * TodayView — the /app landing surface. Everything here is the
 * between-games glance: the live game card while the agent reports a
 * running match, the KPI strip, Ladder Pulse, and the Daily Pulse strip
 * whose cards deep-link into the routed sections.
 *
 * Also honours Settings → "Default tab": users who chose a section as
 * their landing spot are redirected there once per session, preserving
 * the old dashboard's behaviour now that sections are real routes.
 */
export function TodayView() {
  const router = useRouter();
  const me = useDashboardMe();

  const { data: misc } = useApi<{ defaultTab?: string }>(
    "/v1/me/preferences/misc",
  );
  const redirected = useRef(false);
  useEffect(() => {
    if (redirected.current) return;
    const pref = misc?.defaultTab;
    if (!isTabId(pref)) return;
    try {
      if (window.sessionStorage.getItem(DEFAULT_TAB_APPLIED_KEY)) return;
      window.sessionStorage.setItem(DEFAULT_TAB_APPLIED_KEY, "1");
    } catch {
      /* storage unavailable — apply once per mount instead */
    }
    redirected.current = true;
    router.replace(hrefForTab(pref));
  }, [misc, router]);

  return (
    <div className="space-y-5">
      <AgentUpgradeNotice
        initialAgent={{
          paired: me.agentPaired,
          version: me.agentVersion,
          lastSeenAt: me.agentLastSeenAt,
        }}
      />

      {/* Live game card. Hidden by default; mounts a per-user SSE
          subscription and renders only while the desktop agent reports
          a non-idle phase. Boundary keeps a malformed live envelope
          from taking Today down. */}
      <ErrorBoundary label="the live game panel">
        <LiveGamePanel />
      </ErrorBoundary>

      <DashboardKpiStrip totalGames={me.games.total} />

      <ErrorBoundary label="Ladder Pulse">
        <LadderPulse />
      </ErrorBoundary>

      <ErrorBoundary label="the Daily Pulse strip">
        <DailyPulse
          onNavigate={(tab) => router.push(hrefForTab(tab))}
          onOpenOpponent={(pulseId) =>
            router.push(opponentDossierHref(pulseId))
          }
        />
      </ErrorBoundary>
    </div>
  );
}
