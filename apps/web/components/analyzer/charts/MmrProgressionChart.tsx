"use client";

import { useMemo } from "react";
import {
  ResponsiveContainer,
  ComposedChart,
  Area,
  Line,
  Legend,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ReferenceDot,
  ReferenceLine,
} from "recharts";
import { useApi } from "@/lib/clientApi";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";
import { clientTimezone, localDateKey } from "@/lib/timeseries";
import { ChartTooltip } from "./ChartTooltip";

type MmrPoint = {
  bucket: string;
  openMmr: number;
  closeMmr: number;
  minMmr: number;
  maxMmr: number;
  wins: number;
  losses: number;
  total: number;
};

type RegionSeries = {
  region: string;
  points: MmrPoint[];
  peak: { bucket: string; mmr: number } | null;
  trough: { bucket: string; mmr: number } | null;
  latest: { bucket: string; mmr: number } | null;
};

type LadderSeries = {
  seriesKey: string;
  toonHandle: string;
  region: string;
  ladderRace: string;
  label: string;
  points: MmrPoint[];
  peak: { bucket: string; mmr: number } | null;
  trough: { bucket: string; mmr: number } | null;
  latest: { bucket: string; mmr: number } | null;
};

export type MmrCoverage = {
  filteredGames: number;
  numericMmrGames: number;
  verifiedReplayMmrGames: number;
  untrustedNumericMmrGames: number;
  unavailableMmrGames: number;
  missingMmrGames: number;
  excludedNonRanked1v1Games: number;
  missingAccountGames: number;
  missingLadderRaceGames: number;
  eligibleGames: number;
};

type MmrResponse = {
  interval: "day" | "week" | "month";
  points: MmrPoint[];
  regions?: RegionSeries[];
  series?: LadderSeries[];
  /** Deprecated API alias retained while old SWR entries expire. */
  accounts?: Array<Partial<LadderSeries> & Omit<LadderSeries, "seriesKey" | "ladderRace">>;
  coverage?: MmrCoverage;
  mixedSeries?: boolean;
  peak: { bucket: string; mmr: number } | null;
  trough: { bucket: string; mmr: number } | null;
  latest: { bucket: string; mmr: number } | null;
};

const COLOR_ACCENT = "#7c8cff";
const COLOR_SUCCESS = "#3ec07a";
const COLOR_DANGER = "#ff6b6b";
const COLOR_GRID = "#1f2533";
const COLOR_TEXT_DIM = "#6b7280";
const COLOR_BG_SURFACE = "#11141b";

// Per-region base colours. The first account on a region uses the
// base; any additional accounts on the same region cycle through the
// shades below so a NA main + NA smurf still read as "two NA lines"
// while staying visually distinct.
const REGION_COLORS: Record<string, string[]> = {
  NA: ["#7c8cff", "#4f5dcc", "#a8b3ff", "#3b4799"],
  EU: ["#3ec07a", "#1f8a52", "#7be0a8", "#155e3a"],
  KR: ["#ff6b6b", "#c94545", "#ff9e9e", "#902e2e"],
  CN: ["#f5b942", "#c08a1c", "#ffd887", "#8a610f"],
  SEA: ["#b385ff", "#8758d6", "#d4b8ff", "#5d3aa3"],
  U: ["#9aa3b2", "#6b7280", "#c5cdd9", "#4a5260"],
};

const REGION_LABELS: Record<string, string> = {
  NA: "NA",
  EU: "EU",
  KR: "KR",
  CN: "CN",
  SEA: "SEA",
  U: "Unknown",
};

function regionLabel(region: string): string {
  return REGION_LABELS[region] || region;
}

/**
 * Walk the accounts array once and hand each account a colour based
 * on its region + position within that region. Same-region accounts
 * cycle through shades of the base hue so the legend still groups
 * visually by ladder.
 */
function buildSeriesColors(
  series: LadderSeries[],
): Record<string, string> {
  const seen: Record<string, number> = {};
  const out: Record<string, string> = {};
  for (const a of series) {
    const idx = (seen[a.region] = (seen[a.region] || 0));
    seen[a.region] = idx + 1;
    const palette = REGION_COLORS[a.region] || [COLOR_TEXT_DIM];
    out[a.seriesKey] = palette[idx % palette.length];
  }
  return out;
}

export type MmrCoverageNotice = { title: string; sub: string };

/** Explain quarantined legacy values instead of silently drawing them. */
export function mmrCoverageNotice(
  coverage?: Partial<MmrCoverage> | null,
): MmrCoverageNotice | null {
  const count = Number(coverage?.untrustedNumericMmrGames || 0);
  if (!Number.isFinite(count) || count <= 0) return null;
  const noun = count === 1 ? "record was" : "records were";
  return {
    title: "MMR history needs a resync",
    sub: `${count.toLocaleString()} older numeric MMR ${noun} excluded because the replay source cannot be verified. Resync with the latest agent to rebuild this chart from ranked 1v1 replay ratings.`,
  };
}

function emptyMmrCopy(
  coverage?: Partial<MmrCoverage> | null,
): MmrCoverageNotice {
  const resync = mmrCoverageNotice(coverage);
  if (resync) return resync;
  if (Number(coverage?.verifiedReplayMmrGames || 0) > 0) {
    return {
      title: "No verified ranked 1v1 MMR in this view",
      sub: "This chart only includes two-player ladder replays with a verified replay rating and Battle.net account.",
    };
  }
  return {
    title: "No verified MMR data yet",
    sub: "Once the latest agent syncs a ranked 1v1 replay rating, this chart will trace that account and race ladder.",
  };
}

/** Normalize the previous account-only response while cached clients expire. */
function responseSeries(data?: MmrResponse): LadderSeries[] {
  if (!data) return [];
  const raw = Array.isArray(data.series)
    ? data.series
    : Array.isArray(data.accounts)
      ? data.accounts
      : [];
  return raw.map((item) => {
    const ladderRace = item.ladderRace || "U";
    return {
      ...item,
      seriesKey: item.seriesKey || `${item.toonHandle}|${ladderRace}`,
      ladderRace,
    } as LadderSeries;
  });
}

/**
 * MMR progression over time.
 *
 * Renders the closing MMR per bucket as a smooth line. When the
 * streamer has played on more than one Battle.net account (any
 * combination of regions or smurfs), the chart splits into one line
 * per account — labelled "<REGION> <bnid>" so a streamer with a
 * 5,000-MMR NA main and a 3,500-MMR EU smurf, or two NA accounts at
 * different MMR levels, doesn't see the combined line whipsaw
 * whenever they queue on the other ladder. With a single account we
 * keep the original single-line look — accent line + soft min/max
 * band + peak / trough / current markers — so nothing changes for
 * the common case.
 *
 * Accounts data is derived from ``myToonHandle`` (the agent records
 * it on every replay). Older games that pre-date that field collapse
 * into a single "Unknown" series so they still appear.
 *
 * The chart shares the global bucket choice from TrendsTab and
 * reuses every filter (since/until/race/opp_race/map/mmr range).
 */
export function MmrProgressionChart({
  bucket,
}: {
  bucket: "day" | "week" | "month";
}) {
  const { filters, dbRev } = useFilters();
  const tz = useMemo(() => clientTimezone(), []);
  const params = useMemo(
    () => ({ ...filters, interval: bucket, tz }),
    [filters, bucket, tz],
  );
  const { data, isLoading } = useApi<MmrResponse>(
    `/v1/timeseries/mmr${filtersToQuery(params)}#${dbRev}`,
  );

  // Per-account series take priority. Fall back to per-region when
  // an older API response (pre-accounts) is still in the SWR cache.
  // Either way the multi-line view only kicks in when the series
  // count is >= 2 — a single-account / single-region user keeps the
  // original look.
  const series = useMemo<LadderSeries[]>(
    () => responseSeries(data),
    [data],
  );
  const regions = useMemo<RegionSeries[]>(
    () => (Array.isArray(data?.regions) ? data!.regions! : []),
    [data],
  );
  const multiSeries: MultiSeries[] = useMemo(() => {
    if (series.length) {
      const colors = buildSeriesColors(series);
      return series.map((a) => ({
        key: a.seriesKey,
        label: a.label,
        region: a.region,
        color: colors[a.seriesKey] || COLOR_TEXT_DIM,
        points: a.points,
        peak: a.peak,
        trough: a.trough,
        latest: a.latest,
      }));
    }
    if (regions.length) {
      return regions.map((r) => ({
        key: r.region,
        label: regionLabel(r.region),
        region: r.region,
        color: (REGION_COLORS[r.region] || [COLOR_TEXT_DIM])[0],
        points: r.points,
        peak: r.peak,
        trough: r.trough,
        latest: r.latest,
      }));
    }
    return [];
  }, [series, regions]);
  const multi = multiSeries.length > 1;

  const displayData = useMemo<MmrResponse | undefined>(() => {
    if (!data || multiSeries.length !== 1) return data;
    const only = multiSeries[0];
    return {
      ...data,
      points: only.points,
      peak: only.peak,
      trough: only.trough,
      latest: only.latest,
    };
  }, [data, multiSeries]);

  const overallRows = useMemo(() => {
    if (!displayData || !Array.isArray(displayData.points)) return [];
    return displayData.points.map((p) => ({
      date: localDateKey(p.bucket, tz),
      close: p.closeMmr,
      min: p.minMmr,
      max: p.maxMmr,
      band: [p.minMmr, p.maxMmr] as [number, number],
      games: p.total,
      wins: p.wins,
      losses: p.losses,
    }));
  }, [displayData, tz]);

  // Multi-series rows: one row per bucket, one column per series.
  // Missing buckets stay as ``null`` so Recharts skips them rather
  // than drawing a line through zero.
  const multiRows = useMemo(() => {
    if (!multi) return [];
    const byDate = new Map<string, Record<string, number | string | null>>();
    for (const s of multiSeries) {
      for (const p of s.points) {
        const key = localDateKey(p.bucket, tz);
        let row = byDate.get(key);
        if (!row) {
          row = { date: key };
          for (const other of multiSeries) row[other.key] = null;
          byDate.set(key, row);
        }
        row[s.key] = p.closeMmr;
      }
    }
    return Array.from(byDate.values()).sort((a, b) =>
      String(a.date).localeCompare(String(b.date)),
    );
  }, [multiSeries, tz, multi]);

  const yDomain = useMemo(
    () =>
      multi
        ? computeMultiYDomain(multiSeries)
        : computeYDomain(overallRows),
    [multi, multiSeries, overallRows],
  );
  const hasChartRows = multi ? multiRows.length > 0 : overallRows.length > 0;
  const coverageNotice = mmrCoverageNotice(data?.coverage);

  if (isLoading) {
    return (
      <Card title="MMR progression">
        <Skeleton rows={3} />
      </Card>
    );
  }

  if (!hasChartRows) {
    const copy = emptyMmrCopy(data?.coverage);
    return (
      <Card title="MMR progression">
        <EmptyState title={copy.title} sub={copy.sub} />
      </Card>
    );
  }

  // The server may widen the interval (day → week → month) when the
  // matched range would overflow the bucket cap; label whatever it
  // actually used so the copy never lies about the granularity.
  const effectiveBucket = data?.interval ?? bucket;

  return (
    <Card title="MMR progression">
      <p className="-mt-1 mb-3 text-caption text-text-dim">
        Last recorded verified ranked 1v1 MMR per {effectiveBucket} ·{" "}
        {multi
          ? "one line per Battle.net account and selected ladder race; peak / trough / last recorded per series below."
          : "shaded band = min/max recorded within the bucket; markers highlight peak, trough, and last recorded."}
      </p>
      {coverageNotice ? (
        <div
          role="status"
          className="mb-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2"
        >
          <div className="text-xs font-semibold text-warning">
            {coverageNotice.title}
          </div>
          <p className="mt-0.5 text-micro text-text-dim">
            {coverageNotice.sub}
          </p>
        </div>
      ) : null}
      <MmrHeadline data={displayData} multiSeries={multiSeries} multi={multi} />
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          {multi ? (
            <ComposedChart
              data={multiRows}
              margin={{ top: 8, right: 24, bottom: 4, left: 4 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke={COLOR_GRID} />
              <XAxis
                dataKey="date"
                stroke={COLOR_TEXT_DIM}
                fontSize={11}
                minTickGap={28}
                tickMargin={6}
              />
              <YAxis
                stroke={COLOR_TEXT_DIM}
                fontSize={11}
                domain={yDomain}
                width={52}
                tickMargin={4}
                tickFormatter={(v: number) => v.toLocaleString()}
              />
              <Tooltip
                cursor={{ stroke: COLOR_ACCENT, strokeDasharray: "3 3" }}
                content={({ active, payload, label }) => {
                  if (!active || !payload || payload.length === 0) return null;
                  const rows = payload
                    .filter((p) => p.value != null)
                    .map((p) => {
                      const series = multiSeries.find((s) => s.key === p.name);
                      return {
                        key: String(p.name),
                        label: series ? series.label : String(p.name),
                        value: Number(p.value).toLocaleString(),
                        dot: series?.color,
                      };
                    });
                  if (!rows.length) return null;
                  return <ChartTooltip header={String(label)} rows={rows} />;
                }}
              />
              <Legend
                verticalAlign="top"
                align="right"
                iconType="line"
                wrapperStyle={{ fontSize: 11, paddingBottom: 4 }}
                formatter={(value: string) => {
                  const series = multiSeries.find((s) => s.key === value);
                  return series ? series.label : value;
                }}
              />
              {multiSeries.map((s) => (
                <Line
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  name={s.key}
                  stroke={s.color}
                  strokeWidth={2.5}
                  dot={false}
                  connectNulls
                  activeDot={{
                    r: 4,
                    fill: s.color,
                    stroke: COLOR_BG_SURFACE,
                    strokeWidth: 2,
                  }}
                  isAnimationActive={false}
                />
              ))}
            </ComposedChart>
          ) : (
            <SingleSeriesChart
              rows={overallRows}
              yDomain={yDomain}
              data={displayData}
              tz={tz}
            />
          )}
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

/**
 * Unified shape the multi-line chart cares about — whether the
 * underlying series came from the per-account split (one line per
 * toon handle) or the per-region fallback (one line per ladder).
 */
type MultiSeries = {
  key: string;
  label: string;
  region: string;
  color: string;
  points: MmrPoint[];
  peak: { bucket: string; mmr: number } | null;
  trough: { bucket: string; mmr: number } | null;
  latest: { bucket: string; mmr: number } | null;
};

/**
 * Original single-line chart, broken out so the multi-series branch
 * can stay readable without a wall of conditional JSX inside the
 * ResponsiveContainer.
 */
function SingleSeriesChart({
  rows,
  yDomain,
  data,
  tz,
}: {
  rows: Array<{
    date: string;
    close: number;
    band: [number, number];
  }>;
  yDomain: [number, number] | undefined;
  data: MmrResponse | undefined;
  tz: string;
}) {
  const peakKey = data?.peak ? localDateKey(data.peak.bucket, tz) : null;
  const troughKey = data?.trough ? localDateKey(data.trough.bucket, tz) : null;
  const latestKey = data?.latest ? localDateKey(data.latest.bucket, tz) : null;
  return (
    <ComposedChart
      data={rows}
      margin={{ top: 8, right: 24, bottom: 4, left: 4 }}
    >
      <defs>
        <linearGradient id="mmrFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={COLOR_ACCENT} stopOpacity={0.32} />
          <stop offset="100%" stopColor={COLOR_ACCENT} stopOpacity={0} />
        </linearGradient>
      </defs>
      <CartesianGrid strokeDasharray="3 3" stroke={COLOR_GRID} />
      <XAxis
        dataKey="date"
        stroke={COLOR_TEXT_DIM}
        fontSize={11}
        minTickGap={28}
        tickMargin={6}
      />
      <YAxis
        stroke={COLOR_TEXT_DIM}
        fontSize={11}
        domain={yDomain}
        width={52}
        tickMargin={4}
        tickFormatter={(v: number) => v.toLocaleString()}
      />
      {data?.latest ? (
        <ReferenceLine
          y={data.latest.mmr}
          stroke={COLOR_ACCENT}
          strokeOpacity={0.35}
          strokeDasharray="4 4"
        />
      ) : null}
      <Tooltip
        cursor={{ stroke: COLOR_ACCENT, strokeDasharray: "3 3" }}
        content={({ active, payload, label }) => {
          if (!active || !payload || payload.length === 0) return null;
          const row = payload[0].payload as { close: number };
          if (row.close == null) return null;
          return (
            <ChartTooltip
              header={String(label)}
              rows={[
                {
                  key: "close",
                  label: "Last recorded MMR",
                  value: row.close.toLocaleString(),
                },
              ]}
            />
          );
        }}
      />
      <Area
        type="monotone"
        dataKey="band"
        stroke="none"
        fill={COLOR_ACCENT}
        fillOpacity={0.12}
        isAnimationActive={false}
        connectNulls
        activeDot={false}
        legendType="none"
      />
      <Area
        type="monotone"
        dataKey="close"
        stroke="none"
        fill="url(#mmrFill)"
        isAnimationActive={false}
        activeDot={false}
        legendType="none"
      />
      <Line
        type="monotone"
        dataKey="close"
        stroke={COLOR_ACCENT}
        strokeWidth={2.5}
        dot={false}
        activeDot={{ r: 5, fill: COLOR_ACCENT, stroke: COLOR_BG_SURFACE, strokeWidth: 2 }}
        isAnimationActive={false}
      />
      {peakKey && data?.peak ? (
        <ReferenceDot
          x={peakKey}
          y={data.peak.mmr}
          r={5}
          fill={COLOR_SUCCESS}
          stroke={COLOR_BG_SURFACE}
          strokeWidth={2}
          isFront
        />
      ) : null}
      {troughKey && data?.trough ? (
        <ReferenceDot
          x={troughKey}
          y={data.trough.mmr}
          r={5}
          fill={COLOR_DANGER}
          stroke={COLOR_BG_SURFACE}
          strokeWidth={2}
          isFront
        />
      ) : null}
      {latestKey && data?.latest ? (
        <ReferenceDot
          x={latestKey}
          y={data.latest.mmr}
          r={5}
          fill={COLOR_ACCENT}
          stroke={COLOR_BG_SURFACE}
          strokeWidth={2}
          isFront
        />
      ) : null}
    </ComposedChart>
  );
}

function MmrHeadline({
  data,
  multiSeries,
  multi,
}: {
  data: MmrResponse | undefined;
  multiSeries: MultiSeries[];
  multi: boolean;
}) {
  if (!data) return null;
  if (multi) {
    return (
      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:max-w-3xl">
        {multiSeries.map((s) => {
          const sub = s.peak && s.trough
            ? `Peak ${s.peak.mmr.toLocaleString()} · Trough ${s.trough.mmr.toLocaleString()}`
            : undefined;
          return (
            <div
              key={s.key}
              className="rounded-lg border border-border bg-bg-elevated/60 px-3 py-2"
            >
              <div className="flex items-center gap-1.5 text-micro uppercase tracking-wider text-text-dim">
                <span
                  aria-hidden
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ background: s.color }}
                />
                {s.label}
              </div>
              <div
                className="mt-0.5 text-lg font-semibold tabular-nums"
                style={{ color: s.color }}
              >
                {s.latest ? s.latest.mmr.toLocaleString() : "—"}
              </div>
              {sub ? (
                <div className="text-micro tabular-nums text-text-dim">
                  {sub}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    );
  }
  const items: Array<{
    label: string;
    value: string;
    sub?: string;
    color: string;
  }> = [];
  if (data.latest) {
    items.push({
      label: "Last recorded",
      value: data.latest.mmr.toLocaleString(),
      color: COLOR_ACCENT,
    });
  }
  // Deltas describe LAST RECORDED relative to the card's value — a
  // "last −37 vs peak" reads unambiguously; the previous "−37 vs
  // last" under the Peak tile had the direction backwards.
  if (data.peak) {
    const delta = data.latest ? data.latest.mmr - data.peak.mmr : 0;
    items.push({
      label: "Peak",
      value: data.peak.mmr.toLocaleString(),
      sub: data.latest
        ? `last ${delta >= 0 ? "+" : ""}${delta} vs peak`
        : undefined,
      color: COLOR_SUCCESS,
    });
  }
  if (data.trough) {
    const delta = data.latest ? data.latest.mmr - data.trough.mmr : 0;
    items.push({
      label: "Trough",
      value: data.trough.mmr.toLocaleString(),
      sub: data.latest
        ? `last ${delta >= 0 ? "+" : ""}${delta} vs trough`
        : undefined,
      color: COLOR_DANGER,
    });
  }
  return (
    <div className="mb-3 grid grid-cols-3 gap-2 sm:max-w-md">
      {items.map((it) => (
        <div
          key={it.label}
          className="rounded-lg border border-border bg-bg-elevated/60 px-3 py-2"
        >
          <div className="text-micro uppercase tracking-wider text-text-dim">
            {it.label}
          </div>
          <div
            className="mt-0.5 text-lg font-semibold tabular-nums"
            style={{ color: it.color }}
          >
            {it.value}
          </div>
          {it.sub ? (
            <div className="text-micro tabular-nums text-text-dim">{it.sub}</div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/**
 * Tight Y-domain that pads ~5% above/below the extremes so the line
 * doesn't hug the chart edges, but never lets the range collapse so
 * far that a 20-MMR swing looks like a cliff. Falls back to "auto"
 * when the series is empty (the empty-state already short-circuits
 * before we ever reach here, but the guard keeps the type honest).
 */
function computeYDomain(rows: Array<{ min: number; max: number }>): [number, number] | undefined {
  if (!rows.length) return undefined;
  let lo = Infinity;
  let hi = -Infinity;
  for (const r of rows) {
    if (r.min < lo) lo = r.min;
    if (r.max > hi) hi = r.max;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return undefined;
  const range = Math.max(hi - lo, 80);
  const pad = Math.max(20, Math.round(range * 0.08));
  return [Math.max(0, Math.floor((lo - pad) / 10) * 10), Math.ceil((hi + pad) / 10) * 10];
}

/**
 * Domain spanning every series' min/max so the multi-line view
 * doesn't clip the higher-MMR ladders just because the band logic
 * picked tighter bounds for one of them.
 */
function computeMultiYDomain(
  series: MultiSeries[],
): [number, number] | undefined {
  const all: Array<{ min: number; max: number }> = [];
  for (const s of series) {
    for (const p of s.points) {
      all.push({ min: p.minMmr, max: p.maxMmr });
    }
  }
  return computeYDomain(all);
}
