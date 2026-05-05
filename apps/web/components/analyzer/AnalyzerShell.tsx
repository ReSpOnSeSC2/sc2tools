"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Activity,
  ChevronDown,
  Fingerprint,
  Layers,
  Map as MapIcon,
  MapPin,
  Settings as SettingsIcon,
  Swords,
  TrendingUp,
  Users,
  type LucideIcon,
} from "lucide-react";
import { AnalyzerProvider } from "@/components/AnalyzerProvider";
import { Modal } from "@/components/ui/Modal";
import { Section } from "@/components/ui/Section";
import { Tabs } from "@/components/ui/Tabs";
import { ActivityCharts } from "./charts/ActivityCharts";
import { BattlefieldTab } from "./BattlefieldTab";
import { BuildsTab } from "./BuildsTab";
import { DoctorBanner } from "./DoctorBanner";
import { MapIntelTab } from "./MapIntelTab";
import { OpponentDnaGrid } from "./OpponentDnaGrid";
import { OpponentsTab } from "./OpponentsTab";
import { ProfileView } from "./ProfileView";
import { StrategiesTab } from "./StrategiesTab";
import { TrendsTab } from "./TrendsTab";

type TabId =
  | "opponents"
  | "strategies"
  | "trends"
  | "battlefield"
  | "builds"
  | "dna"
  | "map-intel"
  | "activity";

type TabDef = {
  id: TabId;
  label: string;
  icon: LucideIcon;
  description?: string;
};

const TABS: readonly TabDef[] = [
  { id: "opponents", label: "Opponents", icon: Users, description: "Drill into the players you've faced." },
  { id: "strategies", label: "Strategies", icon: Swords, description: "Build vs strategy and per-strategy results." },
  { id: "trends", label: "Trends", icon: TrendingUp, description: "Win-rate trajectory across periods." },
  { id: "battlefield", label: "Battlefield", icon: MapIcon, description: "Maps and matchup performance." },
  { id: "builds", label: "Builds", icon: Layers, description: "Your builds, performance, and editor." },
  { id: "dna", label: "DNA", icon: Fingerprint, description: "Opponent timing fingerprint grid." },
  { id: "map-intel", label: "Map intel", icon: MapPin, description: "Spatial heatmaps for known maps." },
  { id: "activity", label: "Activity", icon: Activity, description: "Per-game charts of resources, army, chrono." },
] as const;

export function AnalyzerShell() {
  const [tab, setTab] = useState<TabId>("opponents");
  const [profileId, setProfileId] = useState<string | null>(null);

  const onTabChange = (next: string) => {
    setTab(next as TabId);
    setProfileId(null);
  };

  const activeTab = TABS.find((t) => t.id === tab) ?? TABS[0];

  return (
    <AnalyzerProvider>
      <div className="space-y-5">
        <DoctorBanner />

        <div className="space-y-4 lg:grid lg:grid-cols-[220px_1fr] lg:gap-6 lg:space-y-0">
          <MobileDrawerNav value={tab} onChange={onTabChange} active={activeTab} />
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
              actions={
                <Link
                  href="/settings"
                  className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md px-3 py-2 text-caption uppercase tracking-wider text-text-muted hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
                >
                  <SettingsIcon className="h-3.5 w-3.5" aria-hidden />
                  Settings
                </Link>
              }
            >
              <TabPanel
                tab={tab}
                profileId={profileId}
                setProfileId={setProfileId}
              />
            </Section>
          </div>
        </div>
      </div>
    </AnalyzerProvider>
  );
}

function MobileDrawerNav({
  value,
  onChange,
  active,
}: {
  value: TabId;
  onChange: (next: string) => void;
  active: TabDef;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (open) setOpen(false);
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="sm:hidden">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="flex min-h-[44px] w-full items-center justify-between gap-2 rounded-lg border border-border bg-bg-surface px-3 py-2 text-left transition-colors hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
      >
        <span className="inline-flex items-center gap-2 text-body font-medium text-text">
          <active.icon
            className="h-4 w-4 flex-shrink-0 text-accent-cyan"
            aria-hidden
          />
          {active.label}
        </span>
        <ChevronDown
          className="h-4 w-4 flex-shrink-0 text-text-muted"
          aria-hidden
        />
      </button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Analyzer sections"
        description="Pick a section to drill into."
        size="sm"
      >
        <ul className="-mx-2 flex flex-col gap-0.5">
          {TABS.map(({ id, label, icon: Icon, description }) => {
            const selected = id === value;
            return (
              <li key={id}>
                <button
                  type="button"
                  onClick={() => onChange(id)}
                  aria-pressed={selected}
                  className={[
                    "flex min-h-[44px] w-full items-start gap-2 rounded-md px-3 py-2 text-left",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
                    selected
                      ? "bg-accent/15 text-accent"
                      : "text-text-muted hover:bg-bg-elevated hover:text-text",
                  ].join(" ")}
                >
                  <Icon
                    className={[
                      "mt-0.5 h-4 w-4 flex-shrink-0",
                      selected ? "text-accent" : "text-accent-cyan",
                    ].join(" ")}
                    aria-hidden
                  />
                  <span className="flex flex-col gap-0.5">
                    <span className="text-body font-medium">{label}</span>
                    {description ? (
                      <span className="text-caption text-text-dim">
                        {description}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </Modal>
    </div>
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
          ariaLabel="Analyzer sections"
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
        <Tabs.List ariaLabel="Analyzer sections">
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
    case "battlefield":
      return <BattlefieldTab />;
    case "builds":
      return <BuildsTab />;
    case "dna":
      return <OpponentDnaGrid />;
    case "map-intel":
      return <MapIntelTab />;
    case "activity":
      return <ActivityCharts />;
    default: {
      const _exhaustive: never = tab;
      return _exhaustive;
    }
  }
}
