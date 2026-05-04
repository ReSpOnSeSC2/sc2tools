"use client";

import { useState } from "react";
import Link from "next/link";
import { AnalyzerProvider } from "@/components/AnalyzerProvider";
import { OpponentsTab } from "./OpponentsTab";
import { StrategiesTab } from "./StrategiesTab";
import { TrendsTab } from "./TrendsTab";
import { BattlefieldTab } from "./BattlefieldTab";
import { BuildsTab } from "./BuildsTab";
import { MlCoreTab } from "./MlCoreTab";
import { MlPredictTab } from "./MlPredictTab";
import { OpponentDnaGrid } from "./OpponentDnaGrid";
import { MapIntelTab } from "./MapIntelTab";
import { ActivityCharts } from "./charts/ActivityCharts";
import { DoctorBanner } from "./DoctorBanner";

const TABS = [
  { id: "opponents", label: "Opponents" },
  { id: "strategies", label: "Strategies" },
  { id: "trends", label: "Trends" },
  { id: "battlefield", label: "Battlefield" },
  { id: "builds", label: "Builds" },
  { id: "dna", label: "DNA" },
  { id: "map-intel", label: "Map intel" },
  { id: "activity", label: "Activity" },
  { id: "ml-core", label: "ML core" },
  { id: "ml-predict", label: "ML predict" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function AnalyzerShell() {
  const [tab, setTab] = useState<TabId>("opponents");
  const [profileId, setProfileId] = useState<string | null>(null);

  return (
    <AnalyzerProvider>
      <div className="space-y-5">
        <DoctorBanner />

        <nav className="flex flex-wrap items-center gap-1 border-b border-border">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                setTab(t.id);
                setProfileId(null);
              }}
              className={`-mb-px border-b-2 px-3 py-2 text-sm transition ${
                tab === t.id
                  ? "border-accent text-accent"
                  : "border-transparent text-text-muted hover:text-text"
              }`}
            >
              {t.label}
            </button>
          ))}
          <Link
            href="/settings"
            className="ml-auto px-3 py-2 text-xs uppercase tracking-wide text-text-muted hover:text-text"
          >
            Settings →
          </Link>
        </nav>

        <div>
          {tab === "opponents" &&
            (profileId ? (
              <ProfileView pulseId={profileId} onBack={() => setProfileId(null)} />
            ) : (
              <OpponentsTab onOpen={(id) => setProfileId(id)} />
            ))}
          {tab === "strategies" && <StrategiesTab />}
          {tab === "trends" && <TrendsTab />}
          {tab === "battlefield" && <BattlefieldTab />}
          {tab === "builds" && <BuildsTab />}
          {tab === "dna" && <OpponentDnaGrid />}
          {tab === "map-intel" && <MapIntelTab />}
          {tab === "activity" && <ActivityCharts />}
          {tab === "ml-core" && <MlCoreTab />}
          {tab === "ml-predict" && <MlPredictTab />}
        </div>
      </div>
    </AnalyzerProvider>
  );
}

function ProfileView({
  pulseId,
  onBack,
}: {
  pulseId: string;
  onBack: () => void;
}) {
  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={onBack}
        className="text-xs uppercase tracking-wider text-text-muted hover:text-text"
      >
        ← back
      </button>
      <ProfileBody pulseId={pulseId} />
    </div>
  );
}

import { useApi } from "@/lib/clientApi";
import { Card, EmptyState, Skeleton, Stat, WrBar } from "@/components/ui/Card";
import { pct1, wrColor } from "@/lib/format";

function ProfileBody({ pulseId }: { pulseId: string }) {
  const { data, isLoading } = useApi<any>(
    `/v1/opponents/${encodeURIComponent(pulseId)}`,
  );
  if (isLoading) return <Skeleton rows={6} />;
  if (!data) return <EmptyState title="Opponent not found" sub={pulseId} />;
  const t = data.totals || {};
  const publicHref = `/community/opponents/${encodeURIComponent(pulseId)}`;
  const byMap: any[] = Object.entries(data.byMap || {}).map(([k, v]: any) => ({
    name: k,
    ...v,
    total: v.wins + v.losses,
    winRate: v.wins + v.losses ? v.wins / (v.wins + v.losses) : 0,
  }));
  const byStrategy: any[] = Object.entries(data.byStrategy || {}).map(
    ([k, v]: any) => ({
      name: k,
      ...v,
      total: v.wins + v.losses,
      winRate: v.wins + v.losses ? v.wins / (v.wins + v.losses) : 0,
    }),
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">
            {data.name || "unnamed"}
          </h1>
          <div className="font-mono text-xs text-text-dim">
            Pulse ID {data.pulseId || pulseId}
          </div>
          <Link
            href={publicHref}
            className="text-xs text-accent hover:underline"
          >
            community profile →
          </Link>
        </div>
        <div className="grid grid-cols-4 gap-3">
          <Stat label="Games" value={t.total || 0} />
          <Stat label="W" value={t.wins || 0} color="#3ec07a" />
          <Stat label="L" value={t.losses || 0} color="#ff6b6b" />
          <Stat
            label="WR"
            value={pct1(t.winRate)}
            color={wrColor(t.winRate, t.total)}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
        <Card title="By map">
          {byMap.length === 0 ? (
            <EmptyState sub="No maps yet" />
          ) : (
            <ul className="space-y-2 text-sm">
              {byMap.map((m) => (
                <li key={m.name}>
                  <div className="flex justify-between">
                    <span>{m.name}</span>
                    <span
                      className="tabular-nums"
                      style={{ color: wrColor(m.winRate, m.total) }}
                    >
                      {m.wins}-{m.losses} · {pct1(m.winRate)}
                    </span>
                  </div>
                  <WrBar wins={m.wins} losses={m.losses} />
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="By strategy">
          {byStrategy.length === 0 ? (
            <EmptyState sub="No strategies tagged yet" />
          ) : (
            <ul className="space-y-2 text-sm">
              {byStrategy.map((s) => (
                <li key={s.name}>
                  <div className="flex justify-between">
                    <span>{s.name}</span>
                    <span
                      className="tabular-nums"
                      style={{ color: wrColor(s.winRate, s.total) }}
                    >
                      {s.wins}-{s.losses} · {pct1(s.winRate)}
                    </span>
                  </div>
                  <WrBar wins={s.wins} losses={s.losses} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
