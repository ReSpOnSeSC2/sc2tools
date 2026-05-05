"use client";

import { useMemo } from "react";
import { Gamepad2 } from "lucide-react";
import { useApi } from "@/lib/clientApi";
import { GlowHalo } from "@/components/ui/GlowHalo";
import { StatCard } from "@/components/ui/Stat";
import { pct1, wrColor } from "@/lib/format";
import {
  apiToPeriods,
  type ApiTimeseriesResponse,
  type Period,
} from "@/lib/timeseries";

interface DashboardKpiStripProps {
  totalGames: number;
}

/**
 * Top-of-dashboard KPI strip. Four stats summarising current play:
 * games played today, 7-day win rate, current win/loss streak, and
 * lifetime games on record. The leading stat (Games today) has a cyan
 * brand halo to draw the eye.
 *
 * Data flows: pulls /v1/timeseries?interval=day for the freshest data.
 * The lifetime total comes from the parent page (already fetched by
 * the server component) so we don't pay for a second roundtrip.
 */
export function DashboardKpiStrip({ totalGames }: DashboardKpiStripProps) {
  const { data, isLoading } = useApi<ApiTimeseriesResponse>(
    "/v1/timeseries?interval=day",
  );

  const kpis = useMemo(() => computeKpis(apiToPeriods(data)), [data]);

  const placeholder = isLoading ? "—" : "0";

  return (
    <div
      className="grid grid-cols-2 gap-3 sm:grid-cols-2 lg:grid-cols-4"
      data-testid="dashboard-kpi-strip"
    >
      <LeadStat
        label="Games today"
        value={kpis.gamesToday ?? placeholder}
        icon={<Gamepad2 className="h-4 w-4" aria-hidden />}
        hint={kpis.gamesToday ? "Keep the streak alive" : "No games yet today"}
      />
      <StatCard
        label="Win rate (7d)"
        value={
          kpis.totals7d > 0 ? (
            <span style={{ color: wrColor(kpis.winRate7d, kpis.totals7d) }}>
              {pct1(kpis.winRate7d)}
            </span>
          ) : (
            placeholder
          )
        }
        hint={
          kpis.totals7d > 0
            ? `${kpis.wins7d}–${kpis.losses7d} over ${kpis.totals7d} games`
            : "Need 7 days of data"
        }
        size="md"
      />
      <StatCard
        label="Active streak"
        value={
          kpis.streak.count > 0 ? (
            <span
              className={
                kpis.streak.kind === "win" ? "text-success" : "text-danger"
              }
            >
              {kpis.streak.kind === "win" ? "W" : "L"}
              <span className="ml-0.5 tabular-nums">{kpis.streak.count}</span>
            </span>
          ) : (
            placeholder
          )
        }
        hint={
          kpis.streak.count > 0
            ? kpis.streak.kind === "win"
              ? "Riding a win streak"
              : "Keep at it — turning is part of the game"
            : "Tied or no recent games"
        }
        size="md"
      />
      <StatCard
        label="Total games"
        value={
          <span className="tabular-nums">
            {totalGames.toLocaleString()}
          </span>
        }
        hint="Lifetime synced replays"
        size="md"
      />
    </div>
  );
}

function LeadStat({
  label,
  value,
  hint,
  icon,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <div className="relative isolate overflow-hidden rounded-lg shadow-halo-cyan">
      <GlowHalo color="cyan" position="top-left" size={120} opacity={0.9} />
      <StatCard
        label={
          <span className="inline-flex items-center gap-1.5">
            {icon ? <span className="text-accent-cyan">{icon}</span> : null}
            {label}
          </span>
        }
        value={
          <span className="text-accent-cyan">{value}</span>
        }
        hint={hint}
        size="md"
        className="border-accent-cyan/40 bg-bg-surface"
      />
    </div>
  );
}

interface ComputedKpis {
  gamesToday: number | null;
  wins7d: number;
  losses7d: number;
  totals7d: number;
  winRate7d: number;
  streak: { kind: "win" | "loss" | null; count: number };
}

function computeKpis(series: Period[]): ComputedKpis {
  if (series.length === 0) {
    return {
      gamesToday: null,
      wins7d: 0,
      losses7d: 0,
      totals7d: 0,
      winRate7d: 0,
      streak: { kind: null, count: 0 },
    };
  }
  const todayKey = todayKeyLocal();
  const last = series[series.length - 1];
  const gamesToday = last && last.date === todayKey ? last.games || 0 : 0;
  const last7 = series.slice(-7);
  const wins7d = last7.reduce((acc, p) => acc + (p.wins || 0), 0);
  const losses7d = last7.reduce((acc, p) => acc + (p.losses || 0), 0);
  const totals7d = wins7d + losses7d;
  const winRate7d = totals7d > 0 ? wins7d / totals7d : 0;
  const streak = streakFromSeries(series);
  return { gamesToday, wins7d, losses7d, totals7d, winRate7d, streak };
}

/**
 * Walk the day-bucketed series backwards, treating each day as a
 * batch of W or L outcomes. We only count days that are pure wins or
 * pure losses; mixed days break the streak.
 */
function streakFromSeries(
  series: Period[],
): { kind: "win" | "loss" | null; count: number } {
  let kind: "win" | "loss" | null = null;
  let count = 0;
  for (let i = series.length - 1; i >= 0; i--) {
    const p = series[i];
    const w = p.wins || 0;
    const l = p.losses || 0;
    if (w === 0 && l === 0) continue;
    const dayKind: "win" | "loss" | "mixed" =
      w > 0 && l === 0 ? "win" : l > 0 && w === 0 ? "loss" : "mixed";
    if (dayKind === "mixed") break;
    if (kind === null) kind = dayKind;
    if (kind !== dayKind) break;
    count += dayKind === "win" ? w : l;
  }
  return { kind, count };
}

function todayKeyLocal(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
