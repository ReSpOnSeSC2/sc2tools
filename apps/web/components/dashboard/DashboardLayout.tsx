"use client";

import { useState } from "react";
import Link from "next/link";
import { Download } from "lucide-react";
import { AnalyzerShell } from "@/components/analyzer/AnalyzerShell";
import { NoGamesYet } from "@/components/analyzer/EmptyStates";
import { MobileSectionPicker } from "@/components/analyzer/MobileSectionPicker";
import { TABS, type TabId } from "@/components/analyzer/tabs";
import { SyncStatus } from "@/components/SyncStatus";
import { LiveGamePanel } from "@/components/dashboard/LiveGamePanel";

type Me = {
  userId: string;
  source: string;
  games: { total: number; latest: string | null };
};

export function DashboardLayout({ me }: { me: Me }) {
  const [tab, setTab] = useState<TabId>("opponents");

  const onTabChange = (next: string) => {
    setTab(next as TabId);
  };

  const noGames = me.games.total === 0;
  const activeTab = TABS.find((t) => t.id === tab) ?? TABS[0];

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-h1 font-semibold">Dashboard</h1>
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
          className="inline-flex min-h-[44px] items-center gap-2 self-start rounded-lg border border-border bg-bg-elevated px-4 py-2 text-body font-semibold text-text transition-colors hover:bg-bg-subtle hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg sm:self-auto"
        >
          <Download className="h-4 w-4" aria-hidden />
          Get the agent
        </Link>
      </header>

      {/* Live game card. Hidden by default; mounts a per-user SSE
          subscription and renders only while the desktop agent is
          actively reporting a non-idle phase. Drops out automatically
          ~30s after the last envelope so a stopped agent doesn't
          leave a stale card pinned to the dashboard. */}
      <LiveGamePanel />

      {noGames ? (
        <NoGamesYet />
      ) : (
        <AnalyzerShell
          totalGames={me.games.total}
          tab={tab}
          onTabChange={onTabChange}
        />
      )}
    </div>
  );
}
