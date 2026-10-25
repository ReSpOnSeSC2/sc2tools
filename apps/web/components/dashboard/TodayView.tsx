"use client";

import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { DailyPulse } from "@/components/analyzer/DailyPulse";
import { DashboardKpiStrip } from "@/components/analyzer/DashboardKpiStrip";
import { LadderPulseFrame } from "@/components/analyzer/LadderPulseFrame";
import { hrefForTab, opponentDossierHref } from "@/components/analyzer/tabs";
import { AgentUpgradeNotice } from "@/components/dashboard/AgentUpgradeNotice";
import { LiveGamePanel } from "@/components/dashboard/LiveGamePanel";
import { useDashboardMe } from "@/components/dashboard/AnalyzerFrame";
import { SectionBoundary } from "@/components/ui/SectionBoundary";
import { useInstantImport } from "@/lib/instant/useInstantImport";

const LadderPulse = dynamic(
  () => import("@/components/analyzer/LadderPulse").then((module) => module.LadderPulse),
  { loading: () => <LadderPulseFrame pending /> },
);

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
  const router = useRouter();
  const me = useDashboardMe();
  const { enabled: browserImportEnabled } = useInstantImport();

  return (
    <div className="space-y-5">
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
        <LiveGamePanel />
      </SectionBoundary>

      <DashboardKpiStrip />

      <SectionBoundary label="the Daily Pulse strip">
        <DailyPulse
          onNavigate={(tab) => router.push(hrefForTab(tab))}
          onOpenOpponent={(pulseId) =>
            router.push(opponentDossierHref(pulseId))
          }
        />
      </SectionBoundary>

      <SectionBoundary label="Ladder Pulse">
        <LadderPulse />
      </SectionBoundary>
    </div>
  );
}
