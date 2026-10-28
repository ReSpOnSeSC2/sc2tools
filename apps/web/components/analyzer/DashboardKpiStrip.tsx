"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { RefreshCw } from "lucide-react";
import { useApi } from "@/lib/clientApi";
import {
  describeActiveFilters,
  filtersToQuery,
  useFilters,
} from "@/lib/filterContext";
import { WinRateLabel } from "@/components/analyzer/WinRateTimeframeMenu";
import { Card, Skeleton } from "@/components/ui/Card";
import { hasQueryData, type QueryLike } from "@/components/ui/QueryState";
import { SkeletonBar } from "@/components/ui/Skeleton";
import { StatCard } from "@/components/ui/Stat";
import { fmtMmr, pct1, wrColor } from "@/lib/format";
import {
  apiToPeriods,
  clientTimezone,
  todayKeyIn,
  type ApiTimeseriesResponse,
  type Period,
} from "@/lib/timeseries";
import {
  DEFAULT_PRESET,
  normalizePresetId,
  resolvePreset,
  shortLabelFor,
  type PresetId,
} from "@/lib/datePresets";

// Keep the live session in its first-render slot while its real request/UI module loads.
const CurrentSessionCard = dynamic(
  () => import("@/components/sessions/CurrentSessionCard").then(module => module.CurrentSessionCard),
  { loading: () => <div data-testid="kpi-today-session" className="col-span-2 min-w-0 lg:col-span-1"><Card><p role="status">Loading session view…</p><Skeleton rows={4} /></Card></div> },
);

const LS_KEY = "analyzer.kpi.winRatePreset";

/** Where the MMR card sends a player with no Pulse ID: the Pulse ID help on Settings → Profile. */
const PULSE_ID_SETTINGS_HREF = "/settings?tab=profile#pulse-id-help";

function readStoredPreset(): PresetId | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    // Legacy ids ("after_5_0_16") move to their replacement.
    return raw ? normalizePresetId(raw) : null;
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
 * Top-of-dashboard KPI strip — current or last live session,
 * customizable Win Rate, Active Streak, MMR, and the game count inside
 * the active global filters.
 *
 * The Win Rate card has a preset picker so the user can ask "what's
 * my win rate this season?" or "in the last 30 days?" without
 * touching the global filter. Sticky per-tab choice via localStorage.
 *
 * Every game-derived card keys its request on `dbRev`, so a finished
 * game (games:changed) refreshes the whole strip, not only Games in
 * range. Each card shows "—" while it loads, and "—" with a
 * "Couldn't load · Retry" hint when its request failed, so a failure
 * never reads as a real 0.
 */
export function DashboardKpiStrip() {
  const { filters, seasons, dbRev } = useFilters();

  // Keep this independent picker aligned with the global default so every
  // first-visit page view starts on the live 12-worker game version.
  const [wrPreset, setWrPreset] = useState<PresetId>(DEFAULT_PRESET);
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
  // filter), but it still honours the global game-kind, game-length and
  // "Hide too-short games" facets. Otherwise the headline cards can
  // re-introduce custom/team games that the rest of the dashboard has
  // removed. The falsy/all cases are dropped by `filtersToQuery`.
  const wrQuery = useMemo(() => {
    // The preset itself is not sent; a patch preset adds its patch_era.
    const params: Record<string, unknown> = { interval: "day", tz, preset: wrPreset };
    if (wrRange.since) params.since = wrRange.since.toISOString();
    if (wrRange.until) params.until = wrRange.until.toISOString();
    if (filters.exclude_too_short) params.exclude_too_short = true;
    params.map_pool = filters.map_pool;
    params.game_size = filters.game_size;
    params.min_minutes = filters.min_minutes;
    params.max_minutes = filters.max_minutes;
    return filtersToQuery(params);
  }, [
    wrPreset,
    wrRange,
    tz,
    filters.exclude_too_short,
    filters.map_pool,
    filters.game_size,
    filters.min_minutes,
    filters.max_minutes,
  ]);

  // Count the exact cohort selected in the global FilterBar. The lifetime
  // synced-replay total already lives in the app header; repeating it here
  // made the largest dashboard number disagree with the date range directly
  // above it. Month buckets keep this count complete and compact even for an
  // all-time window, while every global date / region / mode / length and
  // drill-down constraint is carried through unchanged.
  const selectedRangeQuery = useMemo(
    () => filtersToQuery({ ...filters, interval: "month", tz }),
    [filters, tz],
  );
  const selectedRangeSeries = useApi<ApiTimeseriesResponse>(
    `/v1/timeseries${selectedRangeQuery}#${dbRev}`,
  );
  const selectedRangeTotal = useMemo(
    () =>
      apiToPeriods(selectedRangeSeries.data, tz).reduce(
        (sum, period) => sum + (period.games || 0),
        0,
      ),
    [selectedRangeSeries.data, tz],
  );
  // The card counts every global filter, not only the date range, so say
  // when the matchup, region or a Strategies drill-down narrows it too.
  const otherFilterCount = useMemo(
    () =>
      describeActiveFilters(filters, { seasons }).filter((f) => f.key !== "preset")
        .length,
    [filters, seasons],
  );
  const selectedRangeLabel = `${shortLabelFor(filters.preset || "all", seasons)}${
    otherFilterCount > 0
      ? ` · ${otherFilterCount} more ${otherFilterCount === 1 ? "filter" : "filters"}`
      : ""
  }`;

  // /v1/streak walks games one-by-one to compute the consecutive
  // same-result streak. Pass the global "Hide too-short games"
  // toggle, game-kind scope and game-length bounds so a game the rest
  // of the dashboard has filtered out cannot reset or extend the
  // visible cohort's streak.
  const streakQuery = filtersToQuery({
    exclude_too_short: filters.exclude_too_short,
    map_pool: filters.map_pool,
    game_size: filters.game_size,
    min_minutes: filters.min_minutes,
    max_minutes: filters.max_minutes,
  });
  const streakResp = useApi<StreakResponse>(`/v1/streak${streakQuery}#${dbRev}`);
  const streak = streakResp.data ?? { kind: null, count: 0, lastGameAt: null };

  // Win rate uses its own series scoped by the chosen preset.
  const wrSeries = useApi<ApiTimeseriesResponse>(
    `/v1/timeseries${wrQuery}#${dbRev}`,
  );
  const wrStats = useMemo(
    () => computeWrStats(apiToPeriods(wrSeries.data, tz)),
    [wrSeries.data, tz],
  );

  const wrStatus = kpiStatus(wrSeries);
  const streakStatus = kpiStatus(streakResp);
  const rangeStatus = kpiStatus(selectedRangeSeries);

  // The full-width session must not set the height of both mobile stat rows.
  return (
    <div
      className="grid auto-rows-auto grid-cols-2 gap-3 lg:auto-rows-fr lg:grid-cols-5"
      data-testid="dashboard-kpi-strip"
    >
      <CurrentSessionCard />

      <StatCard
        label={
          <WinRateLabel
            currentPreset={wrPreset}
            onPick={onPickWrPreset}
            seasons={seasons}
          />
        }
        value={
          wrStatus !== "ready" ? (
            "—"
          ) : wrStats.totalGames > 0 ? (
            <span style={{ color: wrColor(wrStats.winRate, wrStats.totalGames) }}>
              {pct1(wrStats.winRate)}
            </span>
          ) : (
            "0"
          )
        }
        hint={
          <>
            {wrStatus !== "ready" ? (
              <KpiPendingHint status={wrStatus} what="your win rate" q={wrSeries} />
            ) : wrStats.totalGames > 0 ? (
              `${wrStats.wins}–${wrStats.losses} over ${wrStats.totalGames} games`
            ) : (
              "No games in this window"
            )}
            {/* This card keeps its own timeframe (the menu by its label),
                so a date range picked in the filter bar leaves it as is. */}
            <span className="mt-0.5 block text-micro text-text-dim">
              Own timeframe · ignores date, matchup, region and Strategies filters
            </span>
          </>
        }
        size="md"
      />

      <StatCard
        label="Active streak"
        value={
          streakStatus !== "ready" ? (
            "—"
          ) : streak.count > 0 && streak.kind ? (
            <span
              className={
                streak.kind === "win" ? "text-success" : "text-danger"
              }
            >
              {streak.kind === "win" ? "W" : "L"}
              <span className="ml-0.5 tabular-nums">{streak.count}</span>
            </span>
          ) : (
            "0"
          )
        }
        hint={
          streakStatus !== "ready" ? (
            <KpiPendingHint status={streakStatus} what="your streak" q={streakResp} />
          ) : streak.count > 0 && streak.kind ? (
            streak.kind === "win" ? (
              "Riding a win streak"
            ) : (
              "Reset, review, re-queue"
            )
          ) : (
            "Tied or no recent games"
          )
        }
        size="md"
      />
      <MmrPerRegionStat />
      <StatCard
        label="Games in range"
        value={
          rangeStatus === "ready" ? (
            <span className="tabular-nums">
              {selectedRangeTotal.toLocaleString()}
            </span>
          ) : (
            "—"
          )
        }
        hint={
          // The label names the filters, not the answer, so it stays up
          // while the count loads.
          rangeStatus === "failed" ? (
            <KpiPendingHint
              status={rangeStatus}
              what="games in range"
              q={selectedRangeSeries}
            />
          ) : (
            <span>Uses filters · {selectedRangeLabel}</span>
          )
        }
        size="md"
      />
    </div>
  );
}

type KpiStatus = "loading" | "failed" | "ready";

/**
 * Which state a card's request is in, in the data-states order: ready
 * while there is an answer to show (hasQueryData — a background
 * refresh that fails keeps it), failed when the request errored with
 * nothing current to show, otherwise loading.
 */
function kpiStatus<T>(q: QueryLike<T>): KpiStatus {
  if (hasQueryData(q)) return "ready";
  return q.error ? "failed" : "loading";
}

/** The hint line of a card that has no answer to show yet. */
function KpiPendingHint({
  status,
  what,
  q,
}: {
  status: Exclude<KpiStatus, "ready">;
  /** What failed to load, for screen readers: "Couldn't load your streak." */
  what: string;
  q: QueryLike<unknown>;
}) {
  if (status === "failed") return <KpiRetry what={what} onRetry={() => q.mutate()} />;
  // A bar shaped like the hint line, not "Loading…" text.
  return (
    <>
      <SkeletonBar className="mt-1 h-3 w-24 max-w-full" />
      <span className="sr-only">Loading</span>
    </>
  );
}

/**
 * A card's failed state: "Couldn't load · Retry" in its hint line.
 * Retry re-runs that card's request. Like RequestError's Retry it stays
 * focusable while the request runs, reports aria-busy and ignores
 * repeat presses. The connection banner covers a dropped connection,
 * so the card itself stays short.
 */
function KpiRetry({ what, onRetry }: { what: string; onRetry: () => unknown }) {
  const [retrying, setRetrying] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function retry() {
    if (retrying) return;
    setRetrying(true);
    try {
      await onRetry();
    } catch {
      // SWR keeps the error on the response, so this hint stays.
    } finally {
      if (mounted.current) setRetrying(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => {
        void retry();
      }}
      aria-busy={retrying || undefined}
      className="-mx-1 inline-flex min-h-8 items-center gap-1.5 rounded px-1 text-left text-caption font-medium text-text-muted hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <RefreshCw
        className={[
          "h-3.5 w-3.5 shrink-0 text-warning",
          retrying ? "motion-safe:animate-spin" : "",
        ].join(" ")}
        aria-hidden
      />
      <span>
        Couldn&apos;t load<span className="sr-only"> {what}.</span>
        <span aria-hidden> ·</span>{" "}
        <span className="font-semibold text-accent">
          {retrying ? "Retrying…" : "Retry"}
        </span>
      </span>
    </button>
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
  // Not keyed on dbRev: each request asks SC2Pulse once per Pulse ID.
  const mmr = useApi<MmrResponse>("/v1/me/mmr");
  const { data } = mmr;
  const entries = data?.entries || [];
  const status = kpiStatus(mmr);

  if (status !== "ready") {
    return (
      <StatCard
        label="MMR"
        value="—"
        hint={<KpiPendingHint status={status} what="your MMR" q={mmr} />}
        size="md"
      />
    );
  }
  if (entries.length === 0) {
    return (
      <StatCard
        label="MMR"
        value="—"
        hint={
          <Link
            href={PULSE_ID_SETTINGS_HREF}
            className="rounded-sm text-accent hover:text-accent-hover hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            Add a Pulse ID in Settings
          </Link>
        }
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
  // The server caps the per-request fan-out, so a profile with more
  // toons than the cap reports ``truncated``. Surface it so the user
  // knows the list isn't their full account set rather than silently
  // dropping the overflow.
  const truncated = data?.truncated ?? false;

  if (entries.length === 1) {
    const e = entries[0];
    return (
      <StatCard
        label="MMR"
        value={<span className="tabular-nums">{fmtMmr(e.mmr)}</span>}
        hint={truncated ? `${e.region || "—"} · +more` : e.region || "—"}
        size="md"
      />
    );
  }
  // Multiple regions: one compact REGION · MMR row each, highest
  // first. The entries are already sorted desc by MMR, so the first
  // entry in each region bucket is that region's best — show it. Every
  // region reads inline (no disclosure popover): a small number next to
  // its region is the at-a-glance view the dashboard wants.
  return (
    <StatCard
      label="MMR"
      value={
        <ul className="flex flex-col gap-0.5 text-base font-semibold leading-tight">
          {groups.map(([region, rows]) => (
            <li
              key={region}
              className="flex items-baseline justify-between gap-2"
            >
              <span className="text-micro uppercase tracking-wider text-text-dim">
                {region}
              </span>
              <span className="tabular-nums">{fmtMmr(rows[0].mmr)}</span>
            </li>
          ))}
        </ul>
      }
      hint={truncated ? "+ more toons not shown" : undefined}
      size="md"
    />
  );
}

interface TodayRecord {
  games: number;
  wins: number;
  losses: number;
}

/**
 * Today's games and W-L from the day-resolution timeseries, found by
 * IANA-tz date key. We don't trust the array tail because clock skew or
 * a hidden preset could hide today; a keyed `find` is more forgiving.
 * No bucket for today means no games yet: a real zero. (Loading and
 * failed requests are told apart by the caller, from the request.)
 *
 * Example:
 *   computeTodayRecord([{ date: todayKey, games: 6, wins: 4, losses: 2, … }], tz);
 *   // -> { games: 6, wins: 4, losses: 2 }
 */
export function computeTodayRecord(
  series: Period[],
  timeZone: string,
  now: Date = new Date(),
): TodayRecord {
  const todayKey = todayKeyIn(timeZone, now);
  const today = series.find((p) => p.date === todayKey);
  return {
    games: today?.games || 0,
    wins: today?.wins || 0,
    losses: today?.losses || 0,
  };
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

