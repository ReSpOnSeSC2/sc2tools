"use client";

import dynamic from "next/dynamic";
import { DailyPulse } from "@/components/analyzer/DailyPulse";
import { DashboardKpiStrip } from "@/components/analyzer/DashboardKpiStrip";
import { LadderPulseFrame } from "@/components/analyzer/LadderPulseFrame";
import { dailyPulseHref } from "@/lib/dailyPulseNavigation";
import { useFilters } from "@/lib/filterContext";
import { viewFiltersQuery } from "@/lib/analyzerViews";
import { AgentUpgradeNotice } from "@/components/dashboard/AgentUpgradeNotice";
import { LiveScoutingBrief } from "@/components/scouting/LiveScoutingBrief";
import { onboardingView, useDashboardMe } from "@/components/dashboard/AnalyzerFrame";
import { SectionBoundary } from "@/components/ui/SectionBoundary";
import { useInstantImport } from "@/lib/instant/useInstantImport";

const LadderPulse = dynamic(
  () => import("@/components/analyzer/LadderPulse").then((module) => module.LadderPulse),
  { loading: () => <LadderPulseFrame pending /> },
);
const LevelUpChecklist = dynamic(() => import("@/components/onboarding/LevelUpChecklist").then(module => module.LevelUpChecklist));

/**
 * TodayView — the /app landing surface. Everything here is the
 * between-games glance: the live game card while the agent reports a
 * running match, the KPI strip, Daily Pulse, and Ladder Pulse
 * whose cards deep-link into the routed sections.
 *
 * Settings → "Default tab" is applied by the /app page on the server
 * (app/app/page.tsx), before this renders, and only for the first /app
 * page of a browser session. Today itself never redirects, so clicking
 * Today always shows Today.
 */
export function TodayView() {
  const { filters } = useFilters();
  const me = useDashboardMe();
  const { enabled: browserImportEnabled } = useInstantImport();

  return (
    <div className="space-y-5">
      {me.games.total > 0 && !onboardingView(me, browserImportEnabled).checklist ? <SectionBoundary label="your suggested next steps"><LevelUpChecklist /></SectionBoundary> : null}
      <AgentUpgradeNotice
        initialAgent={{
          paired: me.agentPaired,
          version: me.agentVersion,
          lastSeenAt: me.agentLastSeenAt,
        }}
        browserImportEnabled={browserImportEnabled}
      />

      {/* Live game card. Hidden by default; mounts a per-user SSE
          subscription and renders only while the desktop agent reports
          a non-idle phase. Boundary keeps a malformed live envelope
          from taking Today down. */}
      <SectionBoundary label="the live game panel">
        <LiveScoutingBrief />
      </SectionBoundary>

      <DashboardKpiStrip />

      <SectionBoundary label="the Daily Pulse strip">
        <DailyPulse
          hrefForCard={(card) => dailyPulseHref(card, viewFiltersQuery(filters).toString())}
        />
      </SectionBoundary>

      <SectionBoundary label="Ladder Pulse">
        <LadderPulse />
      </SectionBoundary>
    </div>
  );
}
