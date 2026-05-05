"use client";

import Link from "next/link";
import { ChevronLeft, ExternalLink } from "lucide-react";
import { useApi } from "@/lib/clientApi";
import { Card, EmptyState, Skeleton, Stat, WrBar } from "@/components/ui/Card";
import { pct1, wrColor } from "@/lib/format";
import { pickPulseLabel, sc2pulseCharacterUrl } from "@/lib/sc2pulse";
import { AllGamesTable } from "./AllGamesTable";
import { Last5GamesTimeline } from "./Last5GamesTimeline";
import type { ProfileGame } from "./Last5GamesTimeline";
import { MedianTimingsGrid } from "./MedianTimingsGrid";
import type { MatchupTimings, TimingInfo } from "./MedianTimingsGrid";
import { PredictedStrategiesList } from "./PredictedStrategiesList";
import type { Prediction } from "./PredictedStrategiesList";
import { StrategyTendencyChart } from "./StrategyTendencyChart";
import type { StrategyEntry } from "./StrategyTendencyChart";

type OpponentProfileResp = {
  pulseId?: string;
  pulseCharacterId?: string | null;
  toonHandle?: string | null;
  name?: string;
  displayNameSample?: string;
  totals?: { wins: number; losses: number; total: number; winRate: number };
  byMap?: Record<string, { wins: number; losses: number }>;
  byStrategy?: Record<string, { wins: number; losses: number }>;
  topStrategies?: StrategyEntry[];
  predictedStrategies?: Prediction[];
  myRace?: string;
  oppRaceModal?: string;
  matchupLabel?: string;
  matchupCounts?: Record<string, number>;
  matchupTimings?: Record<string, MatchupTimings>;
  matchupTimingsLegacy?: Record<string, MatchupTimings>;
  medianTimings?: Record<string, TimingInfo>;
  medianTimingsLegacy?: Record<string, TimingInfo>;
  medianTimingsOrder?: string[];
  last5Games?: ProfileGame[];
  games?: ProfileGame[];
};

export function ProfileView({
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
        className="inline-flex min-h-[44px] items-center gap-1 rounded-md px-2 py-1 text-caption uppercase tracking-wider text-text-muted hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden />
        Back
      </button>
      <ProfileBody pulseId={pulseId} />
    </div>
  );
}

function ProfileBody({ pulseId }: { pulseId: string }) {
  const { data, isLoading } = useApi<OpponentProfileResp>(
    `/v1/opponents/${encodeURIComponent(pulseId)}`,
  );
  if (isLoading) return <Skeleton rows={6} />;
  if (!data) return <EmptyState title="Opponent not found" sub={pulseId} />;
  const t = data.totals || { wins: 0, losses: 0, total: 0, winRate: 0 };
  const publicHref = `/community/opponents/${encodeURIComponent(pulseId)}`;
  const byMap = Object.entries(data.byMap || {})
    .map(([name, v]) => ({
      name,
      wins: v.wins,
      losses: v.losses,
      total: v.wins + v.losses,
      winRate: v.wins + v.losses ? v.wins / (v.wins + v.losses) : 0,
    }))
    .sort((a, b) => b.total - a.total);
  const byStrategy = Object.entries(data.byStrategy || {})
    .map(([name, v]) => ({
      name,
      wins: v.wins,
      losses: v.losses,
      total: v.wins + v.losses,
      winRate: v.wins + v.losses ? v.wins / (v.wins + v.losses) : 0,
    }))
    .sort((a, b) => b.total - a.total);
  const medianTimings = data.medianTimingsLegacy || {};
  const medianTimingsOrder =
    data.medianTimingsOrder && data.medianTimingsOrder.length
      ? data.medianTimingsOrder
      : Object.keys(medianTimings);
  const matchupTimings = data.matchupTimingsLegacy || {};
  const matchupCounts = data.matchupCounts || {};
  const games = data.games || [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-h2 font-semibold">{data.name || "unnamed"}</h1>
          <ProfilePulseLine
            pulseCharacterId={data.pulseCharacterId}
            toonHandle={data.toonHandle}
            pulseId={data.pulseId || pulseId}
          />
          <Link
            href={publicHref}
            className="text-caption text-accent hover:underline"
          >
            community profile →
          </Link>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Games" value={t.total || 0} />
          <Stat label="W" value={t.wins || 0} color="rgb(var(--success))" />
          <Stat label="L" value={t.losses || 0} color="rgb(var(--danger))" />
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

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card title="Build tendencies (top 5 strategies)">
          <StrategyTendencyChart strategies={data.topStrategies || []} />
        </Card>
        <Card title="Likely strategies next">
          <PredictedStrategiesList
            predictions={data.predictedStrategies || []}
          />
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card
          title={`Median key timings${data.matchupLabel ? ` — ${data.matchupLabel}` : ""}`}
        >
          <MedianTimingsGrid
            timings={medianTimings}
            order={medianTimingsOrder}
            matchupLabel={data.matchupLabel || ""}
            matchupCounts={matchupCounts}
            matchupTimings={matchupTimings}
            opponentName={data.name || data.pulseId || pulseId}
          />
          <p className="mt-2 text-[10px] text-text-dim">
            Opponent-tech cards come from the agent-uploaded opponent build
            log; your-tech cards come from your build log. Click a card with
            samples to see the contributing games. "-" means no samples in
            this matchup.
          </p>
        </Card>
        <Card title="Last 5 games">
          <Last5GamesTimeline games={data.last5Games || []} />
        </Card>
      </div>

      <Card title={`All games (${games.length}) · newest first`}>
        <AllGamesTable games={games} />
      </Card>
    </div>
  );
}

/**
 * Pulse identity line in the profile header. Mirrors the table-cell
 * treatment in OpponentsTab: when we have a real SC2Pulse character
 * id, link out to nephest with the resolved id; otherwise fall back to
 * the toon_handle (the value from the user's replay folder name) and
 * label it accordingly.
 */
function ProfilePulseLine({
  pulseCharacterId,
  toonHandle,
  pulseId,
}: {
  pulseCharacterId?: string | null;
  toonHandle?: string | null;
  pulseId: string;
}) {
  const label = pickPulseLabel({ pulseCharacterId, toonHandle, pulseId });
  if (!label) {
    return (
      <div className="font-mono text-caption text-text-dim">Pulse ID —</div>
    );
  }
  if (label.isPulseCharacterId) {
    return (
      <div className="flex flex-wrap items-center gap-2 font-mono text-caption text-text-dim">
        <span>Pulse ID</span>
        <a
          href={sc2pulseCharacterUrl(label.value)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-accent-cyan hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        >
          {label.value}
          <ExternalLink className="h-3 w-3" aria-hidden />
        </a>
        {toonHandle ? (
          <span className="text-text-dim/70">· toon {toonHandle}</span>
        ) : null}
      </div>
    );
  }
  return (
    <div className="font-mono text-caption text-text-dim">
      Toon {label.value}
      <span className="ml-2 text-[10px] uppercase tracking-wider text-text-dim/70">
        sc2pulse id not resolved yet
      </span>
    </div>
  );
}
