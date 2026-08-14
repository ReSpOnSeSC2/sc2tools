"use client";

import { useEffect, useRef, useState } from "react";
import { AnalyzerProvider } from "@/components/AnalyzerProvider";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { Section } from "@/components/ui/Section";
import { Tabs } from "@/components/ui/Tabs";
import { ArcadeTab } from "./ArcadeTab";
import { BattlefieldTab } from "./BattlefieldTab";
import { BuildsTab } from "./BuildsTab";
import { DailyPulse } from "./DailyPulse";
import { DashboardKpiStrip } from "./DashboardKpiStrip";
import { DoctorBanner } from "./DoctorBanner";
import { FilterBar } from "./FilterBar";
import { LadderPulse } from "./LadderPulse";
import { MacroTab } from "./MacroTab";
import { OpponentsTab } from "./OpponentsTab";
import { ProfileView } from "./ProfileView";
import { StrategiesTab } from "./StrategiesTab";
import { TABS, type TabId } from "./tabs";
import { TrendsTab } from "./TrendsTab";

export function AnalyzerShell({
  totalGames,
  tab,
  onTabChange,
  initialOpponentId,
}: {
  totalGames: number;
  tab: TabId;
  onTabChange: (next: string) => void;
  initialOpponentId?: string | null;
}) {
  const [profileId, setProfileId] = useState<string | null>(
    initialOpponentId ?? null,
  );
  // Dossier requested from outside the Opponents tab (e.g. a Daily
  // Pulse nemesis card). The tab-sync effect below would otherwise
  // reset profileId to the URL-provided initialOpponentId the moment
  // the tab switches, so the pending id rides along and wins once.
  const pendingProfileId = useRef<string | null>(null);

  useEffect(() => {
    if (tab === "opponents") {
      setProfileId(pendingProfileId.current ?? initialOpponentId ?? null);
      pendingProfileId.current = null;
    } else {
      pendingProfileId.current = null;
      setProfileId(null);
    }
  }, [tab, initialOpponentId]);

  const openOpponentProfile = (pulseId: string) => {
    if (tab === "opponents") {
      setProfileId(pulseId);
    } else {
      pendingProfileId.current = pulseId;
      onTabChange("opponents");
    }
  };

  const activeTab = TABS.find((t) => t.id === tab) ?? TABS[0];

  return (
    <AnalyzerProvider analysisGamesEnabled={tab === "arcade"}>
      <div className="space-y-5">
        <DoctorBanner />

        <DashboardKpiStrip totalGames={totalGames} />

        <ErrorBoundary label="Ladder Pulse">
          <LadderPulse />
        </ErrorBoundary>

        <ErrorBoundary label="the Daily Pulse strip">
          <DailyPulse
            onNavigate={onTabChange}
            onOpenOpponent={openOpponentProfile}
          />
        </ErrorBoundary>

        <div className="rounded-xl border-2 border-line bg-bg-surface px-3 py-3 shadow-hard sm:py-2">
          <FilterBar />
        </div>

        <div className="space-y-4 lg:grid lg:grid-cols-[220px_1fr] lg:gap-6 lg:space-y-0">
          <TabletScrollNav value={tab} onChange={onTabChange} />
          <DesktopSidebarNav value={tab} onChange={onTabChange} />

          <div className="min-w-0">
            <Section
              title={
                <span className="inline-flex items-center gap-2">
                  <activeTab.icon
                    className="h-5 w-5 text-accent-cyan"
                    aria-hidden
                  />
                  {activeTab.label}
                </span>
              }
              description={activeTab.description}
            >
              <ErrorBoundary label={`the ${activeTab.label} tab`}>
                <TabPanel
                  tab={tab}
                  profileId={profileId}
                  setProfileId={setProfileId}
                />
              </ErrorBoundary>
            </Section>
          </div>
        </div>
      </div>
    </AnalyzerProvider>
  );
}

function TabletScrollNav({
  value,
  onChange,
}: {
  value: TabId;
  onChange: (next: string) => void;
}) {
  return (
    <div className="hidden sm:block lg:hidden">
      <Tabs value={value} onValueChange={onChange} orientation="horizontal">
        <Tabs.List
          ariaLabel="Dashboard sections"
          className="!flex-nowrap"
        >
          {TABS.map(({ id, label, icon: Icon }) => (
            <Tabs.Trigger key={id} value={id} className="!flex-shrink-0">
              <span className="inline-flex items-center gap-1.5">
                <Icon className="h-4 w-4 flex-shrink-0" aria-hidden />
                <span>{label}</span>
              </span>
            </Tabs.Trigger>
          ))}
        </Tabs.List>
      </Tabs>
    </div>
  );
}

function DesktopSidebarNav({
  value,
  onChange,
}: {
  value: TabId;
  onChange: (next: string) => void;
}) {
  return (
    <aside className="hidden lg:block">
      <Tabs
        value={value}
        onValueChange={onChange}
        orientation="vertical"
        className="!block"
      >
        <Tabs.List ariaLabel="Dashboard sections">
          {TABS.map(({ id, label, icon: Icon }) => (
            <Tabs.Trigger key={id} value={id}>
              <span className="flex items-center gap-2">
                <Icon className="h-4 w-4 flex-shrink-0" aria-hidden />
                <span className="truncate">{label}</span>
              </span>
            </Tabs.Trigger>
          ))}
        </Tabs.List>
      </Tabs>
    </aside>
  );
}

function TabPanel({
  tab,
  profileId,
  setProfileId,
}: {
  tab: TabId;
  profileId: string | null;
  setProfileId: (id: string | null) => void;
}) {
  switch (tab) {
    case "opponents":
      return profileId ? (
        <ProfileView pulseId={profileId} onBack={() => setProfileId(null)} />
      ) : (
        <OpponentsTab onOpen={(id) => setProfileId(id)} />
      );
    case "strategies":
      return <StrategiesTab />;
    case "trends":
      return <TrendsTab />;
    case "macro":
      return <MacroTab />;
    case "battlefield":
      return <BattlefieldTab />;
    case "builds":
      return <BuildsTab />;
    case "arcade":
      return <ArcadeTab />;
    default: {
      const _exhaustive: never = tab;
      return _exhaustive;
    }
  }
}
