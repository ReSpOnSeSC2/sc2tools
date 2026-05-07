"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Gamepad2 } from "lucide-react";
import { useApi } from "@/lib/clientApi";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { GlowHalo } from "@/components/ui/GlowHalo";
import { StatCard } from "@/components/ui/Stat";
import { pct1, wrColor } from "@/lib/format";
import {
  apiToPeriods,
  type ApiTimeseriesResponse,
  type Period,
} from "@/lib/timeseries";
import {
  PRESETS,
  resolvePreset,
  shortLabelFor,
  type PresetId,
} from "@/lib/datePresets";

interface DashboardKpiStripProps {
  totalGames: number;
}

const LS_KEY = "analyzer.kpi.winRatePreset";

const WIN_RATE_PRESET_OPTIONS: PresetId[] = [
  "current_season",
  "today",
  "last_week",
  "last_7d",
  "this_month",
  "last_30d",
  "last_90d",
  "this_year",
  "last_year",
  "all",
];

function readStoredPreset(): PresetId | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    return raw ? (raw as PresetId) : null;
  } catch {
    return null;
  }
}

function writeStoredPreset(value: PresetId): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LS_KEY, value);
  } catch {
    /* non-fatal */
  }
}

/**
 * Top-of-dashboard KPI strip — Games today, customizable Win Rate,
 * Active Streak, and lifetime Total games.
 *
 * The Win Rate card has a preset picker so the user can ask "what's
 * my win rate this season?" or "in the last 30 days?" without
 * touching the global filter. Sticky per-tab choice via localStorage.
 */
export function DashboardKpiStrip({ totalGames }: DashboardKpiStripProps) {
  const { seasons } = useFilters();

  // The Win Rate card has its own preset, defaulting to "current_season"
  // so it answers "how am I doing right now?" out of the box.
  const [wrPreset, setWrPreset] = useState<PresetId>("current_season");
  useEffect(() => {
    const stored = readStoredPreset();
    if (stored) setWrPreset(stored);
  }, []);
  const onPickWrPreset = (id: PresetId) => {
    setWrPreset(id);
    writeStoredPreset(id);
  };

  const wrRange = useMemo(
    () => resolvePreset(wrPreset, undefined, seasons),
    [wrPreset, seasons],
  );
  const wrQuery = useMemo(() => {
    const params: Record<string, unknown> = { interval: "day" };
    if (wrRange.since) params.since = wrRange.since.toISOString();
    if (wrRange.until) params.until = wrRange.until.toISOString();
    return filtersToQuery(params);
  }, [wrRange]);

  // Global series — used for Games today and Active streak.
  const globalSeries = useApi<ApiTimeseriesResponse>(
    "/v1/timeseries?interval=day",
  );
  const globalKpis = useMemo(
    () => computeKpis(apiToPeriods(globalSeries.data)),
    [globalSeries.data],
  );

  // Win rate uses its own series scoped by the chosen preset.
  const wrSeries = useApi<ApiTimeseriesResponse>(
    `/v1/timeseries${wrQuery}`,
  );
  const wrStats = useMemo(() => computeWrStats(apiToPeriods(wrSeries.data)), [wrSeries.data]);

  const placeholder = globalSeries.isLoading ? "—" : "0";
  const wrPlaceholder = wrSeries.isLoading ? "—" : "0";

  return (
    <div
      className="grid auto-rows-fr grid-cols-2 gap-3 sm:grid-cols-2 lg:grid-cols-4"
      data-testid="dashboard-kpi-strip"
    >
      <LeadStat
        label="Games today"
        value={globalKpis.gamesToday ?? placeholder}
        icon={<Gamepad2 className="h-4 w-4" aria-hidden />}
        hint={
          globalKpis.gamesToday ? "Keep the streak alive" : "No games yet today"
        }
      />

      <StatCard
        label={
          <WinRateLabel
            currentPreset={wrPreset}
            onPick={onPickWrPreset}
            seasons={seasons}
          />
        }
        value={
          wrStats.totalGames > 0 ? (
            <span style={{ color: wrColor(wrStats.winRate, wrStats.totalGames) }}>
              {pct1(wrStats.winRate)}
            </span>
          ) : (
            wrPlaceholder
          )
        }
        hint={
          wrStats.totalGames > 0
            ? `${wrStats.wins}–${wrStats.losses} over ${wrStats.totalGames} games`
            : "No games in this window"
        }
        size="md"
      />

      <StatCard
        label="Active streak"
        value={
          globalKpis.streak.count > 0 ? (
            <span
              className={
                globalKpis.streak.kind === "win"
                  ? "text-success"
                  : "text-danger"
              }
            >
              {globalKpis.streak.kind === "win" ? "W" : "L"}
              <span className="ml-0.5 tabular-nums">
                {globalKpis.streak.count}
              </span>
            </span>
          ) : (
            placeholder
          )
        }
        hint={
          globalKpis.streak.count > 0
            ? globalKpis.streak.kind === "win"
              ? "Riding a win streak"
              : "Keep at it — turning is part of the game"
            : "Tied or no recent games"
        }
        size="md"
      />
      <StatCard
        label="Total games"
        value={
          <span className="tabular-nums">{totalGames.toLocaleString()}</span>
        }
        hint="Lifetime synced replays"
        size="md"
      />
    </div>
  );
}

function WinRateLabel({
  currentPreset,
  onPick,
  seasons,
}: {
  currentPreset: PresetId;
  onPick: (id: PresetId) => void;
  seasons: ReturnType<typeof useFilters>["seasons"];
}) {
  const [open, setOpen] = useState(false);
  const label = `Win rate · ${shortLabelFor(currentPreset, seasons)}`;

  // ESC closes the menu — same UX as the global FilterBar.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <span className="relative inline-flex items-center gap-1">
      <span>{label}</span>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Change Win Rate timeframe"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-7 w-7 items-center justify-center rounded text-text-dim hover:bg-bg-elevated hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <ChevronDown className="h-3.5 w-3.5" aria-hidden />
      </button>

      {open ? (
        <>
          <button
            type="button"
            aria-label="Close timeframe menu"
            className="fixed inset-0 z-30"
            onClick={() => setOpen(false)}
          />
          <div
            role="menu"
            className="absolute right-0 top-full z-40 mt-1 w-56 max-w-[80vw] rounded-lg border border-border bg-bg-surface p-1 text-left shadow-card"
          >
            {WIN_RATE_PRESET_OPTIONS.map((id) => {
              const friendly =
                id === "current_season"
                  ? `Current season${
                      seasons.find((s) => s.isCurrent)
                        ? ` (${seasons.find((s) => s.isCurrent)?.number})`
                        : ""
                    }`
                  : PRESETS.find((p) => p.id === id)?.label || id;
              const selected = currentPreset === id;
              return (
                <button
                  key={id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  onClick={() => {
                    onPick(id);
                    setOpen(false);
                  }}
                  className={[
                    "flex min-h-[40px] w-full items-center rounded px-2 py-1.5 text-left text-sm",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                    selected
                      ? "bg-accent/15 text-accent"
                      : "text-text-muted hover:bg-bg-elevated hover:text-text",
                  ].join(" ")}
                >
                  {friendly}
                </button>
              );
            })}
          </div>
        </>
      ) : null}
    </span>
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
    <div className="relative isolate flex h-full flex-col overflow-hidden rounded-lg shadow-halo-cyan">
      <GlowHalo color="cyan" position="top-left" size={120} opacity={0.9} />
      <StatCard
        label={
          <span className="inline-flex items-center gap-1.5">
            {icon ? <span className="text-accent-cyan">{icon}</span> : null}
            {label}
          </span>
        }
        value={<span className="text-accent-cyan">{value}</span>}
        hint={hint}
        size="md"
        className="h-full flex-1 border-accent-cyan/40 bg-bg-surface"
      />
    </div>
  );
}

interface ComputedKpis {
  gamesToday: number | null;
  streak: { kind: "win" | "loss" | null; count: number };
}

function computeKpis(series: Period[]): ComputedKpis {
  if (series.length === 0) {
    return {
      gamesToday: null,
      streak: { kind: null, count: 0 },
    };
  }
  const todayKey = todayKeyLocal();
  const last = series[series.length - 1];
  const gamesToday = last && last.date === todayKey ? last.games || 0 : 0;
  const streak = streakFromSeries(series);
  return { gamesToday, streak };
}

function computeWrStats(series: Period[]): {
  wins: number;
  losses: number;
  totalGames: number;
  winRate: number;
} {
  const wins = series.reduce((acc, p) => acc + (p.wins || 0), 0);
  const losses = series.reduce((acc, p) => acc + (p.losses || 0), 0);
  const totalGames = wins + losses;
  return {
    wins,
    losses,
    totalGames,
    winRate: totalGames > 0 ? wins / totalGames : 0,
  };
}

/**
 * Walk the day-bucketed series backwards, treating each day as a
 * batch of W or L outcomes. Mixed days break the streak.
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
