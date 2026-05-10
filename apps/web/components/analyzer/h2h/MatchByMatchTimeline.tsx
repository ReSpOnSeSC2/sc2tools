"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type Ref } from "react";
import {
  Area,
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { EmptyState } from "@/components/ui/Card";
import { wrColor } from "@/lib/format";
import {
  bucketByPeriod,
  cumulativeSeries,
  totalsOf,
  type Bucket,
  type CumulativePoint,
  type H2HGame,
  type PeriodPoint,
} from "@/lib/h2hSeries";
import { clientTimezone } from "@/lib/timeseries";
import { raceAccent, normalizeRace } from "./shared/raceAccent";
import { CumulativeTooltip, PeriodTooltip } from "./shared/h2hTooltip";

type Props = {
  chronoGames: H2HGame[];
  oppRace: string | null | undefined;
  bucket: Bucket;
  rollingWindow: number;
  presetLong: string;
  opponentName: string;
  onSelectGame: (gameId: string) => void;
};

const BUCKET_LABEL: Record<Bucket, string> = {
  day: "Daily",
  week: "Weekly",
  month: "Monthly",
};

/**
 * View 1 — Match-by-Match Timeline. Two stacked sub-charts that share
 * an X domain via Recharts `syncId`:
 *
 *   1a. Cumulative + rolling WR sparkline. One dot per decided game,
 *       result-tinted, sized by macro percentile. Click → highlight
 *       the matching row in the AllGamesTable below.
 *   1b. Periodic WR bars. One bar per Day/Week/Month bucket, colored
 *       by `wrColor()` so a 0/3 day reads as deep red and a 5/0 reads
 *       as deep green.
 *
 * Empty state when the window has fewer than 2 decided games — a
 * single dot can't show a trend.
 */
export function MatchByMatchTimeline({
  chronoGames,
  oppRace,
  bucket,
  rollingWindow,
  presetLong,
  opponentName,
  onSelectGame,
}: Props) {
  const tz = useMemo(() => clientTimezone(), []);
  const series = useMemo(
    () => cumulativeSeries(chronoGames, rollingWindow),
    [chronoGames, rollingWindow],
  );
  const totals = useMemo(() => totalsOf(chronoGames), [chronoGames]);
  const periodSeries = useMemo(
    () => bucketByPeriod(chronoGames, bucket, tz),
    [chronoGames, bucket, tz],
  );
  const accent = raceAccent(oppRace);
  const raceLetter = normalizeRace(oppRace);
  const [activeIndex, setActiveIndex] = useState<number>(-1);
  const focusableRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (activeIndex >= series.length) setActiveIndex(series.length - 1);
  }, [activeIndex, series.length]);

  if (series.length < 2) {
    return (
      <EmptyState
        title="Not enough games yet"
        sub={`Need at least 2 games against ${opponentName} in ${presetLong} to chart a trend.`}
      />
    );
  }

  const overallWrPct = Math.round(totals.winRate * 100);
  const lastPoint = series[series.length - 1];
  const rollingLabel = `${rollingWindow}-game rolling`;
  const showYearOnTicks = spansMultipleYears(series);
  const figcaption = buildFigcaption({
    opponent: opponentName,
    presetLong,
    overallWrPct,
    totalGames: totals.total,
    rollingLabel,
    rollingWrPct: lastPoint.rollingWrPct,
  });

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (series.length === 0) return;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(series.length - 1, (i < 0 ? -1 : i) + 1));
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, (i < 0 ? series.length : i) - 1));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActiveIndex(series.length - 1);
    } else if (e.key === "Enter" && activeIndex >= 0) {
      e.preventDefault();
      const id = series[activeIndex]?.game.id;
      if (id) onSelectGame(id);
    }
  };

  const activePoint = activeIndex >= 0 ? series[activeIndex] : null;

  return (
    <figure
      className="m-0 space-y-3"
      ref={focusableRef as Ref<HTMLElement>}
      tabIndex={0}
      aria-label="Match-by-match timeline"
      onKeyDown={onKeyDown}
      style={{ touchAction: "pan-y" }}
    >
      <figcaption className="sr-only">{figcaption}</figcaption>
      <TimelineHeader
        opponent={opponentName}
        presetLong={presetLong}
        overallWrPct={overallWrPct}
        totalGames={totals.total}
        rollingLabel={rollingLabel}
        rollingWrPct={lastPoint.rollingWrPct}
        accent={accent}
        raceLabel={raceLabelFor(raceLetter)}
      />
      <div className="rounded-lg border border-border bg-bg-elevated/40 p-2">
        <div className="h-44 sm:h-48 md:h-56">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={series}
              syncId="h2h-timeline"
              margin={{ top: 6, right: 12, bottom: 0, left: 0 }}
              onClick={(state) => {
                const idx = clickedIndex(state);
                if (idx === null) return;
                setActiveIndex(idx);
                const id = series[idx]?.game.id;
                if (id) onSelectGame(id);
              }}
              onMouseLeave={() => setActiveIndex((i) => (i < 0 ? -1 : i))}
            >
              <defs>
                <linearGradient
                  id={`h2hCumulativeFill-${raceLetter}`}
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop offset="0%" stopColor={accent} stopOpacity={0.32} />
                  <stop offset="100%" stopColor={accent} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2533" />
              <XAxis
                dataKey="index"
                stroke="#6b7280"
                fontSize={10}
                tickFormatter={(v) => `#${v}`}
                minTickGap={28}
                tickMargin={4}
              />
              <YAxis
                stroke="#6b7280"
                fontSize={10}
                domain={[0, 100]}
                ticks={[0, 25, 50, 75, 100]}
                tickFormatter={(v) => `${v}%`}
                width={36}
              />
              <ReferenceLine y={50} stroke="#3a4252" strokeDasharray="2 4" />
              {totals.total > 0 ? (
                <ReferenceLine
                  y={overallWrPct}
                  stroke={accent}
                  strokeOpacity={0.5}
                  strokeDasharray="6 4"
                />
              ) : null}
              <Tooltip
                content={(props) => (
                  <CumulativeTooltip {...props} rollingLabel={rollingLabel} />
                )}
                cursor={{ stroke: accent, strokeWidth: 1, strokeDasharray: "3 3" }}
              />
              <Area
                type="monotone"
                dataKey="cumulativeWrPct"
                stroke="none"
                fill={`url(#h2hCumulativeFill-${raceLetter})`}
                isAnimationActive={false}
                legendType="none"
                tooltipType="none"
              />
              <Line
                type="monotone"
                dataKey="cumulativeWrPct"
                stroke={accent}
                strokeOpacity={0.55}
                strokeWidth={1.5}
                strokeDasharray="4 3"
                dot={renderResultDot(activeIndex)}
                activeDot={false}
                isAnimationActive={false}
                legendType="none"
              />
              <Line
                type="monotone"
                dataKey="rollingWrPct"
                stroke={accent}
                strokeWidth={2.4}
                connectNulls={true}
                dot={false}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      <PeriodicBars
        data={periodSeries}
        bucketLabel={BUCKET_LABEL[bucket]}
        showYear={showYearOnTicks}
        accent={accent}
      />

      {activePoint ? (
        <p className="text-[11px] text-text-dim">
          Selected #{activePoint.index} ({activePoint.game.map || "—"}) ·{" "}
          {activePoint.cumulativeWrPct}% lifetime ·{" "}
          {activePoint.rollingWrPct == null
            ? `${rollingLabel} not yet available`
            : `${activePoint.rollingWrPct}% rolling`}
        </p>
      ) : (
        <p className="text-[11px] text-text-dim">
          Click a dot to highlight the matching row in the table below. Use
          arrow keys to step through games.
        </p>
      )}
    </figure>
  );
}

function TimelineHeader({
  opponent,
  presetLong,
  overallWrPct,
  totalGames,
  rollingLabel,
  rollingWrPct,
  accent,
  raceLabel,
}: {
  opponent: string;
  presetLong: string;
  overallWrPct: number;
  totalGames: number;
  rollingLabel: string;
  rollingWrPct: number | null;
  accent: string;
  raceLabel: string;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-caption">
      <span className="font-semibold text-text">{opponent}</span>
      <span className="text-text-dim">{presetLong}</span>
      <span
        className="tabular-nums"
        style={{ color: wrColor(overallWrPct / 100, totalGames) }}
      >
        {overallWrPct}% lifetime ({totalGames} game{totalGames === 1 ? "" : "s"})
      </span>
      <span className="tabular-nums text-text-dim">
        {rollingLabel}: {rollingWrPct == null ? "—" : `${rollingWrPct}%`}
      </span>
      <span
        className="ml-auto inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-text-dim"
        title={`Race accent only — race: ${raceLabel}`}
      >
        <span
          aria-hidden
          className="inline-block h-2.5 w-2.5 rounded-full"
          style={{ background: accent }}
        />
        accent: {raceLabel}
      </span>
    </div>
  );
}

function PeriodicBars({
  data,
  bucketLabel,
  showYear,
  accent,
}: {
  data: PeriodPoint[];
  bucketLabel: string;
  showYear: boolean;
  accent: string;
}) {
  if (data.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-bg-elevated/40 p-3 text-caption text-text-dim">
        No bucketed games to plot in this window.
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-border bg-bg-elevated/40 p-2">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-1 text-caption">
        <span className="font-semibold text-text">
          {bucketLabel} win rate
        </span>
        <span className="text-text-dim">
          {data.length} bucket{data.length === 1 ? "" : "s"} · faint background
          bar shows volume
        </span>
      </div>
      <div className="h-32 sm:h-36">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={data}
            syncId="h2h-timeline"
            margin={{ top: 4, right: 12, bottom: 0, left: 0 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#1f2533" />
            <XAxis
              dataKey="date"
              stroke="#6b7280"
              fontSize={10}
              tickFormatter={(v) => formatBucketTick(v, showYear)}
              minTickGap={28}
              tickMargin={4}
            />
            <YAxis
              yAxisId="wr"
              stroke="#6b7280"
              fontSize={10}
              domain={[0, 100]}
              ticks={[0, 50, 100]}
              tickFormatter={(v) => `${v}%`}
              width={32}
            />
            <YAxis
              yAxisId="vol"
              orientation="right"
              stroke="#6b7280"
              fontSize={10}
              tickFormatter={() => ""}
              width={4}
            />
            <ReferenceLine
              yAxisId="wr"
              y={50}
              stroke="#3a4252"
              strokeDasharray="2 4"
            />
            <Tooltip
              content={(props) => (
                <PeriodTooltip {...props} bucketLabel={bucketLabel} />
              )}
              cursor={{ fill: `${accent}10` }}
            />
            <Bar
              yAxisId="vol"
              dataKey="total"
              fill={accent}
              fillOpacity={0.12}
              isAnimationActive={false}
              legendType="none"
              radius={[2, 2, 0, 0]}
            />
            <Bar
              yAxisId="wr"
              dataKey="winRatePct"
              isAnimationActive={false}
              radius={[3, 3, 0, 0]}
            >
              {data.map((p) => (
                <Cell
                  key={p.date}
                  fill={wrColor(p.winRatePct / 100, p.total)}
                />
              ))}
            </Bar>
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

type DotProps = {
  cx?: number;
  cy?: number;
  index?: number;
  payload?: CumulativePoint;
};

function renderResultDot(activeIndex: number) {
  const Dot = (props: DotProps) => {
    const { cx, cy, payload, index = 0 } = props;
    if (typeof cx !== "number" || typeof cy !== "number" || !payload) {
      return <g />;
    }
    const r = dotRadius(payload.macroPercentile);
    const fill = payload.isWin
      ? "#3ec07a"
      : payload.isLoss
        ? "#ff6b6b"
        : "#9aa3b2";
    const isActive = index === activeIndex;
    return (
      <g>
        {isActive ? (
          <circle
            cx={cx}
            cy={cy}
            r={r + 3}
            fill="none"
            stroke="#7c8cff"
            strokeWidth={2}
          />
        ) : null}
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill={fill}
          stroke="#0b0d12"
          strokeWidth={1}
        />
      </g>
    );
  };
  return Dot;
}

function dotRadius(percentile: number | null): number {
  if (percentile == null) return 4;
  if (percentile >= 80) return 7;
  if (percentile >= 60) return 6;
  if (percentile >= 40) return 5;
  if (percentile >= 20) return 4;
  return 3.5;
}

function clickedIndex(state: unknown): number | null {
  if (!state || typeof state !== "object") return null;
  const idx = (state as { activeTooltipIndex?: unknown }).activeTooltipIndex;
  if (typeof idx === "number") return idx;
  return null;
}

function spansMultipleYears(series: CumulativePoint[]): boolean {
  let earliest: string | null = null;
  let latest: string | null = null;
  for (const p of series) {
    const d = p.game.date || "";
    if (!d) continue;
    if (!earliest || d < earliest) earliest = d;
    if (!latest || d > latest) latest = d;
  }
  if (!earliest || !latest) return false;
  return earliest.slice(0, 4) !== latest.slice(0, 4);
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

function formatBucketTick(value: string, showYear: boolean): string {
  if (!value || value.length < 10) return value;
  const [y, m, d] = value.split("-");
  const monthIdx = Number.parseInt(m, 10) - 1;
  const dayN = Number.parseInt(d, 10);
  if (Number.isNaN(monthIdx) || monthIdx < 0 || monthIdx > 11) return value;
  const month = MONTHS[monthIdx];
  if (showYear) return `${month} '${y.slice(2)}`;
  return `${month} ${dayN}`;
}

function raceLabelFor(letter: ReturnType<typeof normalizeRace>): string {
  switch (letter) {
    case "T": return "Terran";
    case "P": return "Protoss";
    case "Z": return "Zerg";
    case "R": return "Random";
    default: return "Unknown";
  }
}

function buildFigcaption(args: {
  opponent: string;
  presetLong: string;
  overallWrPct: number;
  totalGames: number;
  rollingLabel: string;
  rollingWrPct: number | null;
}): string {
  const rolling =
    args.rollingWrPct == null
      ? `${args.rollingLabel} unavailable yet`
      : `most recent ${args.rollingLabel} ${args.rollingWrPct}%`;
  return (
    `Cumulative win rate trend across ${args.totalGames} games vs ${args.opponent} ` +
    `in ${args.presetLong}, currently ${args.overallWrPct}%, ${rolling}.`
  );
}
