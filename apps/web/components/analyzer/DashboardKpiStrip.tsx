"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Gamepad2 } from "lucide-react";
import { useApi } from "@/lib/clientApi";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { GlowHalo } from "@/components/ui/GlowHalo";
import { StatCard } from "@/components/ui/Stat";
import { fmtMmr, pct1, wrColor } from "@/lib/format";
import {
  apiToPeriods,
  clientTimezone,
  startOfTodayInTz,
  todayKeyIn,
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
  const { filters, seasons } = useFilters();

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

  // The browser's timezone is sticky across the component so bucket
  // keys, today-key derivation, and API requests stay aligned.
  const tz = useMemo(() => clientTimezone(), []);

  const wrRange = useMemo(
    () => resolvePreset(wrPreset, undefined, seasons),
    [wrPreset, seasons],
  );
  // The Win Rate card uses its OWN preset for since/until (so the
  // user can ask "season win rate" without touching the global date
  // filter), but it MUST still honour the global "Hide too-short
  // games" toggle — otherwise a season with a streak of leavers
  // inflates the percentage the moment the user enables filtering
  // everywhere else. We merge `exclude_too_short` from the shared
  // filter context into the params before serialising; the falsy
  // case is dropped by `filtersToQuery` so the URL stays clean.
  const wrQuery = useMemo(() => {
    const params: Record<string, unknown> = { interval: "day", tz };
    if (wrRange.since) params.since = wrRange.since.toISOString();
    if (wrRange.until) params.until = wrRange.until.toISOString();
    if (filters.exclude_too_short) params.exclude_too_short = true;
    return filtersToQuery(params);
  }, [wrRange, tz, filters.exclude_too_short]);

  // Global series — used for Games today. Streak is fetched from a
  // dedicated /v1/streak endpoint that walks games one-by-one (the
  // day-bucketed series can't represent streak correctly because a
  // single mixed day collapses the count to 0).
  //
  // Scope the query to today's local-tz window via `since`. Without it,
  // a user with a multi-year history matches the full lifetime range,
  // which makes the server's `_fitInterval` widen `day` → `week` to
  // stay under the bucket cap. Weekly buckets are keyed by start-of-week
  // and never match `todayKeyIn(tz)`, so "Games today" silently flips
  // to 0 once UTC rolls over even though games exist in the user's
  // local today. Filtering to today keeps the matched span < 24h, which
  // pins the interval at `day` and produces a single bucket that lines
  // up with `todayKeyIn`.
  const globalSeriesQuery = useMemo(() => {
    const since = startOfTodayInTz(tz).toISOString();
    const base = `interval=day&tz=${encodeURIComponent(tz)}&since=${encodeURIComponent(since)}`;
    // Honour the global "Hide too-short games" toggle on the Games
    // today KPI too — a 20-second drop shouldn't show up as "1 game
    // today" once the user has chosen to exclude leavers.
    return filters.exclude_too_short ? `${base}&exclude_too_short=true` : base;
  }, [tz, filters.exclude_too_short]);
  const globalSeries = useApi<ApiTimeseriesResponse>(
    `/v1/timeseries?${globalSeriesQuery}`,
  );
  const gamesToday = useMemo(
    () => computeGamesToday(apiToPeriods(globalSeries.data, tz), tz),
    [globalSeries.data, tz],
  );

  // /v1/streak walks games one-by-one to compute the consecutive
  // same-result streak. Pass the global "Hide too-short games"
  // toggle so a 25-second leaver mid-streak doesn't reset the count.
  const streakQuery = filters.exclude_too_short ? "?exclude_too_short=true" : "";
  const streakResp = useApi<StreakResponse>(`/v1/streak${streakQuery}`);
  const streak = streakResp.data ?? { kind: null, count: 0, lastGameAt: null };

  // Win rate uses its own series scoped by the chosen preset.
  const wrSeries = useApi<ApiTimeseriesResponse>(
    `/v1/timeseries${wrQuery}`,
  );
  const wrStats = useMemo(
    () => computeWrStats(apiToPeriods(wrSeries.data, tz)),
    [wrSeries.data, tz],
  );

  const placeholder = globalSeries.isLoading ? "—" : "0";
  const streakPlaceholder = streakResp.isLoading ? "—" : "0";
  const wrPlaceholder = wrSeries.isLoading ? "—" : "0";

  return (
    <div
      className="grid auto-rows-fr grid-cols-2 gap-3 sm:grid-cols-2 lg:grid-cols-5"
      data-testid="dashboard-kpi-strip"
    >
      <LeadStat
        label="Games today"
        value={gamesToday ?? placeholder}
        icon={<Gamepad2 className="h-4 w-4" aria-hidden />}
        hint={gamesToday ? "Keep the streak alive" : "No games yet today"}
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
          streak.count > 0 && streak.kind ? (
            <span
              className={
                streak.kind === "win" ? "text-success" : "text-danger"
              }
            >
              {streak.kind === "win" ? "W" : "L"}
              <span className="ml-0.5 tabular-nums">{streak.count}</span>
            </span>
          ) : (
            streakPlaceholder
          )
        }
        hint={
          streak.count > 0 && streak.kind
            ? streak.kind === "win"
              ? "Riding a win streak"
              : "Reset, review, re-queue"
            : "Tied or no recent games"
        }
        size="md"
      />
      <MmrPerRegionStat />
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

interface StreakResponse {
  kind: "win" | "loss" | null;
  count: number;
  lastGameAt: string | null;
}

interface MmrEntry {
  pulseId: string;
  region: string | null;
  mmr: number;
}

interface MmrResponse {
  entries: MmrEntry[];
  truncated: boolean;
}

/**
 * Per-toon / per-region MMR card. Sourced from SC2Pulse via
 * ``/v1/me/mmr`` which fans out one fetch per ``pulseIds`` entry on
 * the user's profile, so each Battle.net account contributes its own
 * region + MMR row.
 *
 * Auto-resizing strategy — the strip allots ~120 px of horizontal
 * real estate per card, so we never try to fit every name inline:
 *
 *   * Single toon (most common): headline number with the region as
 *     the hint. Looks identical in weight to the surrounding KPI
 *     cards.
 *   * 2 toons: both stacked as REGION · MMR rows.
 *   * 3+ toons OR multiple toons in the same region: headline shows
 *     the best MMR and a "details" disclosure opens a popover with
 *     the full grouped-by-region list. The popover is scrollable —
 *     any toon count fits without the card itself growing.
 *
 * The card is filter-agnostic: region selection in the global
 * FilterBar does NOT prune entries here. The card answers "what's my
 * ladder rating right now?", a per-user attribute — not a per-game
 * stat.
 */
function MmrPerRegionStat() {
  const { data, isLoading } = useApi<MmrResponse>("/v1/me/mmr");
  const entries = data?.entries || [];

  if (isLoading) {
    return <StatCard label="MMR" value="—" hint="Loading SC2Pulse" size="md" />;
  }
  if (entries.length === 0) {
    return (
      <StatCard
        label="MMR"
        value="—"
        hint="Add a Pulse ID in Settings"
        size="md"
      />
    );
  }

  // Group by region in input order (entries arrive sorted desc by
  // MMR, so the first entry per region is the highest there).
  const byRegion = new Map<string, MmrEntry[]>();
  for (const e of entries) {
    const key = e.region || "—";
    const bucket = byRegion.get(key);
    if (bucket) bucket.push(e);
    else byRegion.set(key, [e]);
  }
  const groups = Array.from(byRegion.entries());

  if (entries.length === 1) {
    const e = entries[0];
    return (
      <StatCard
        label="MMR"
        value={<span className="tabular-nums">{fmtMmr(e.mmr)}</span>}
        hint={e.region || "—"}
        size="md"
      />
    );
  }
  if (entries.length === 2 && groups.length === 2) {
    // Two regions, one toon each — render both inline. No popover
    // needed; the card stays a single visual unit.
    return (
      <StatCard
        label="MMR"
        value={
          <ul className="flex flex-col gap-0.5 text-base font-semibold leading-tight">
            {entries.map((e) => (
              <li
                key={e.pulseId}
                className="flex items-baseline justify-between gap-2"
              >
                <span className="text-[11px] uppercase tracking-wider text-text-dim">
                  {e.region || "—"}
                </span>
                <span className="tabular-nums">{fmtMmr(e.mmr)}</span>
              </li>
            ))}
          </ul>
        }
        size="md"
      />
    );
  }
  // ≥3 entries OR same-region duplicates: fixed-height card with a
  // disclosure popover. The headline is the highest MMR overall;
  // ``details`` opens a grouped list that scrolls past ~8 rows.
  return <MmrCardWithDetails entries={entries} groups={groups} />;
}

/**
 * Compact MMR card with a click-to-expand details popover. Keeps the
 * dashboard strip a fixed visual height regardless of how many toons
 * the user has on a single region — a streamer with 10 NA smurfs sees
 * the same card footprint as one with 1 NA toon.
 */
function MmrCardWithDetails({
  entries,
  groups,
}: {
  entries: MmrEntry[];
  groups: Array<[string, MmrEntry[]]>;
}) {
  const [open, setOpen] = useState(false);
  const best = entries[0];

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const summaryLabel =
    groups.length === 1
      ? `${entries.length} toons · ${groups[0][0]}`
      : `${entries.length} toons · ${groups.length} regions`;

  return (
    <div className="relative">
      <StatCard
        label={
          <span className="inline-flex items-center gap-1">
            <span>MMR</span>
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-haspopup="dialog"
              aria-expanded={open}
              aria-label="Show all toons and regions"
              className="inline-flex h-5 items-center rounded px-1 text-[10px] uppercase tracking-wider text-text-dim hover:bg-bg-elevated hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              details
              <ChevronDown
                className={`ml-0.5 h-3 w-3 transition-transform ${
                  open ? "rotate-180" : ""
                }`}
                aria-hidden
              />
            </button>
          </span>
        }
        value={<span className="tabular-nums">{fmtMmr(best.mmr)}</span>}
        hint={
          <span>
            <span className="uppercase tracking-wider">{best.region || "—"}</span>
            <span className="ml-1 text-text-dim">· {summaryLabel}</span>
          </span>
        }
        size="md"
      />
      {open ? (
        <>
          <button
            type="button"
            aria-label="Close MMR details"
            className="fixed inset-0 z-30"
            onClick={() => setOpen(false)}
          />
          <div
            role="dialog"
            aria-label="MMR by toon and region"
            className="absolute left-0 right-0 top-full z-40 mt-1 max-h-[50vh] overflow-y-auto rounded-lg border border-border bg-bg-surface p-2 shadow-card sm:max-h-72 sm:w-[min(92vw,260px)]"
          >
            <ul className="space-y-2">
              {groups.map(([region, rows]) => (
                <li key={region}>
                  <div className="flex items-baseline justify-between border-b border-border/60 pb-0.5 text-[10px] uppercase tracking-wider text-text-dim">
                    <span>{region}</span>
                    <span>
                      {rows.length} toon{rows.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  <ul className="mt-1 space-y-0.5">
                    {rows.map((r) => (
                      <li
                        key={r.pulseId}
                        className="flex items-center justify-between gap-2 text-xs"
                      >
                        <span className="truncate font-mono text-text-dim">
                          {r.pulseId}
                        </span>
                        <span className="tabular-nums font-semibold">
                          {fmtMmr(r.mmr)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * Find today's bucket in the day-resolution timeseries by IANA-tz date
 * key. We don't trust the array tail because clock skew or a hidden
 * preset could hide today; a keyed `find` is more forgiving.
 *
 * Returns ``null`` when the series is empty so the caller can render a
 * loading placeholder instead of a hard zero.
 */
function computeGamesToday(
  series: Period[],
  timeZone: string,
): number | null {
  if (series.length === 0) return null;
  const todayKey = todayKeyIn(timeZone);
  const todayPeriod = series.find((p) => p.date === todayKey);
  return todayPeriod ? todayPeriod.games || 0 : 0;
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

