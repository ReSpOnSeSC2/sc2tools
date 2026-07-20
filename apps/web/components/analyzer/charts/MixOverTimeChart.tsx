"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useApi } from "@/lib/clientApi";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";
import { clientTimezone, localDateKey } from "@/lib/timeseries";

type MixPoint = {
  bucket: string;
  key: string;
  wins: number;
  losses: number;
  total: number;
};

type MixResponse = {
  interval: "day" | "week" | "month";
  points: MixPoint[];
};

const OTHER_KEY = "__other";
const OTHER_LABEL = "Other";
const OTHER_COLOR = "#3a4252";

// Distinct, accessible palette tuned for the dark surface. Order is
// stable so the same series gets the same colour across re-renders.
const PALETTE = [
  "#7c8cff", // accent
  "#3ec07a", // success
  "#e6b450", // warning
  "#ff6b6b", // danger
  "#a78bfa", // violet
  "#22d3ee", // cyan
  "#f472b6", // pink
  "#fb923c", // orange
];

const TOP_N_OPTIONS = [4, 6, 8] as const;
const DEFAULT_TOP_N = 6;

// Beyond this many periods the gap in-fill would produce an unusable
// wall of empty cells (e.g. a day bucket across years), so the
// timeline falls back to only the periods that actually have games.
const MAX_COLUMNS = 160;

// Rows a matrix needs before the recent-share shift chip is shown,
// and the minimum games in the recent window for it to mean anything.
const SHIFT_MIN_GAMES = 5;
const SHIFT_MIN_PTS = 8;

type SeriesDef = {
  key: string;
  label: string;
  color: string;
  total: number;
  /** Share of the recent third of the window minus overall share, in
   *  percentage points. Null when the recent window is too thin. */
  shiftPts: number | null;
};

type CellDatum = { count: number; wins: number; losses: number };

type ColumnDatum = { date: string; total: number; wins: number; losses: number };

type MixMatrix = {
  series: SeriesDef[];
  columns: ColumnDatum[];
  cells: Map<string, CellDatum>;
  maxCellCount: number;
  maxColumnTotal: number;
  totalGames: number;
};

export type MixOpponentRace = "" | "P" | "T" | "Z";

type MixMatchupFilter = {
  opponentRace: MixOpponentRace;
  onChange: (race: MixOpponentRace) => void;
};

type MixOverTimeChartProps = {
  /** Endpoint suffix under /v1/ — e.g. "timeseries/my-builds". */
  endpoint: string;
  /** Card title. */
  title: string;
  /** Short caption below the title (1 line). */
  caption: string;
  /** Bucket granularity, threaded from TrendsTab. */
  bucket: "day" | "week" | "month";
  /** Label for the "no data" empty state. */
  emptyTitle?: string;
  /** Sub-copy for the empty state. */
  emptySub?: string;
  /** Optional card-local opponent-race scope shared by the mix cards. */
  matchupFilter?: MixMatchupFilter;
};

/**
 * Cadence-matrix "mix" chart: one row per category, one column per
 * period, each cell the actual game count (colour intensity scales
 * with volume).
 *
 * Generic on the categorical dimension — used by the "Your build
 * mix" and "Strategies you're facing" cards in the Trends tab.
 * Selects the top-N most-played categories over the visible window
 * (toggleable: 4/6/8) and rolls the remainder into a single
 * "Other" row so the matrix never balloons past readable palette
 * size, even on accounts with hundreds of distinct values.
 *
 * Why a matrix and not the 100% stacked area it replaced: these
 * feeds run at very low volume per period (often 1-8 games a day),
 * and a share-based area chart interpolates a single game into a
 * full-height spike — pure noise. The matrix plots the counts
 * themselves, keeps calendar gaps visible as gaps, and lets the eye
 * scan a row to see exactly when a build was in rotation. The
 * composition question the old chart asked ("is my mix shifting?")
 * is answered head-on by the per-row recent-share chip and the
 * per-period breakdown panel below.
 */
export function MixOverTimeChart({
  endpoint,
  title,
  caption,
  bucket,
  emptyTitle = "Not enough data to plot a mix yet",
  emptySub,
  matchupFilter,
}: MixOverTimeChartProps) {
  const { filters, dbRev } = useFilters();
  const tz = useMemo(() => clientTimezone(), []);
  const hasMatchupFilter = matchupFilter !== undefined;
  const opponentRace = matchupFilter?.opponentRace;
  const params = useMemo(
    () => ({
      ...filters,
      // When the local selector is present it owns this card's matchup
      // scope. An empty value deliberately removes any global opp_race
      // constraint so "All matchups" means exactly that for these cards.
      opp_race: hasMatchupFilter
        ? opponentRace || undefined
        : filters.opp_race,
      interval: bucket,
      tz,
    }),
    [filters, bucket, tz, hasMatchupFilter, opponentRace],
  );
  const { data, isLoading } = useApi<MixResponse>(
    `/v1/${endpoint}${filtersToQuery(params)}#${dbRev}`,
  );
  const [topN, setTopN] = useState<number>(DEFAULT_TOP_N);
  // The hovered/tapped period lives in a dedicated panel below the
  // matrix instead of a floating tooltip — on narrow mobile viewports
  // a tooltip wide enough for build labels ("PvT - Phoenix into
  // Robo") would cover the very cells it's annotating.
  const [activeDate, setActiveDate] = useState<string | null>(null);

  const matrix = useMemo(
    () => shapeMatrix(data?.points || [], tz, topN, bucket),
    [data, tz, topN, bucket],
  );
  const { series, columns, cells, maxCellCount, maxColumnTotal, totalGames } =
    matrix;

  // Default selection = most recent period with games, so the panel
  // always has something useful in it before the user interacts.
  const selectedColumn = useMemo(() => {
    if (columns.length === 0) return null;
    if (activeDate) {
      const match = columns.find((c) => c.date === activeDate);
      if (match) return match;
    }
    for (let i = columns.length - 1; i >= 0; i--) {
      if (columns[i].total > 0) return columns[i];
    }
    return columns[columns.length - 1];
  }, [columns, activeDate]);

  // Most recent periods are the interesting ones — start the matrix
  // scrolled to the right edge whenever the window changes.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [columns.length, series.length]);

  const matchupControl = matchupFilter ? (
    <MatchupSelect
      title={title}
      myRace={filters.race}
      value={matchupFilter.opponentRace}
      onChange={matchupFilter.onChange}
    />
  ) : null;

  const headerControls = (
    <TopNToggle value={topN} onChange={setTopN} />
  );

  if (isLoading) {
    return (
      <Card title={title} right={headerControls}>
        {matchupControl ? (
          <div className="-mt-1 mb-3 flex justify-end">{matchupControl}</div>
        ) : null}
        <Skeleton rows={3} />
      </Card>
    );
  }

  if (columns.length === 0 || totalGames === 0) {
    return (
      <Card title={title} right={headerControls}>
        {matchupControl ? (
          <div className="-mt-1 flex justify-end">{matchupControl}</div>
        ) : null}
        <EmptyState title={emptyTitle} sub={emptySub} />
      </Card>
    );
  }

  const showYear =
    columns[0].date.slice(0, 4) !== columns[columns.length - 1].date.slice(0, 4);
  const activeColDate = selectedColumn?.date ?? null;
  const tickStep = Math.max(1, Math.ceil(columns.length / 7));

  return (
    <Card title={title} right={headerControls}>
      <div className="-mt-1 mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-caption text-text-dim">{caption}</p>
        {matchupControl}
      </div>
      <div
        ref={scrollRef}
        className="overflow-x-auto pb-1"
        onMouseLeave={() => setActiveDate(null)}
      >
        <div className="w-max min-w-full">
          {series.map((s) => (
            <div key={s.key} className="flex w-full items-center">
              <RowLabel series={s} />
              <div className="flex min-w-0 flex-1 gap-[3px] py-[3px]">
                {columns.map((c) => {
                  const datum = cells.get(cellKey(c.date, s.key));
                  const isActiveCol = c.date === activeColDate;
                  return (
                    <div
                      key={c.date}
                      onMouseEnter={() => setActiveDate(c.date)}
                      onClick={() => setActiveDate(c.date)}
                      title={
                        datum
                          ? `${s.label} · ${c.date} · ${datum.count} game${
                              datum.count === 1 ? "" : "s"
                            } · ${datum.wins}W-${datum.losses}L`
                          : `${s.label} · ${c.date} · no games`
                      }
                      className={[
                        "grid h-6 min-w-6 max-w-9 flex-1 basis-6 select-none place-items-center rounded-[5px] text-[10px] font-semibold tabular-nums text-white/90",
                        datum ? "" : "bg-bg-elevated/40",
                        isActiveCol ? "ring-1 ring-accent/60" : "",
                      ].join(" ")}
                      style={
                        datum
                          ? {
                              backgroundColor: withAlpha(
                                s.color,
                                cellAlpha(datum.count, maxCellCount),
                              ),
                            }
                          : undefined
                      }
                    >
                      {datum
                        ? datum.count > 99
                          ? "99+"
                          : datum.count
                        : null}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          {/* Games-per-period volume strip — anchors the matrix in raw
              activity so a quiet week reads as quiet, not as a data bug. */}
          <div className="flex w-full items-center border-t border-border/60">
            <div className="sticky left-0 z-10 w-28 shrink-0 bg-bg-surface py-1 pr-2 sm:w-44">
              <span className="text-micro uppercase tracking-wider text-text-dim">
                Games
              </span>
            </div>
            <div className="flex min-w-0 flex-1 gap-[3px] py-1">
              {columns.map((c) => {
                const isActiveCol = c.date === activeColDate;
                return (
                  <div
                    key={c.date}
                    onMouseEnter={() => setActiveDate(c.date)}
                    onClick={() => setActiveDate(c.date)}
                    title={`${c.date} · ${c.total} game${c.total === 1 ? "" : "s"}`}
                    className="flex h-6 min-w-6 max-w-9 flex-1 basis-6 items-end"
                  >
                    <div
                      className={[
                        "w-full rounded-t-[3px]",
                        isActiveCol ? "bg-accent" : "bg-accent/45",
                      ].join(" ")}
                      style={{
                        height:
                          c.total > 0 && maxColumnTotal > 0
                            ? `${Math.max(
                                15,
                                Math.round((c.total / maxColumnTotal) * 100),
                              )}%`
                            : "0%",
                      }}
                    />
                  </div>
                );
              })}
            </div>
          </div>

          {/* Date axis. Each column is a real button so keyboard and
              touch users can pin a period's breakdown. */}
          <div className="flex w-full items-center">
            <div className="sticky left-0 z-10 w-28 shrink-0 bg-bg-surface pr-2 sm:w-44" />
            <div className="flex min-w-0 flex-1 gap-[3px]">
              {columns.map((c, i) => {
                const isActiveCol = c.date === activeColDate;
                const isLast = i === columns.length - 1;
                const showTick =
                  isLast ||
                  (i % tickStep === 0 &&
                    columns.length - 1 - i >= Math.ceil(tickStep / 2));
                return (
                  <button
                    key={c.date}
                    type="button"
                    aria-label={`Show ${c.date} breakdown`}
                    onMouseEnter={() => setActiveDate(c.date)}
                    onClick={() => setActiveDate(c.date)}
                    className="relative h-5 min-w-6 max-w-9 flex-1 basis-6"
                  >
                    {showTick ? (
                      <span
                        className={[
                          "absolute left-1/2 top-0.5 -translate-x-1/2 whitespace-nowrap text-[10px] tabular-nums",
                          isActiveCol ? "text-accent" : "text-text-dim",
                        ].join(" ")}
                      >
                        {tickLabel(c.date, bucket, showYear)}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
      <ActiveBreakdown
        column={selectedColumn}
        cells={cells}
        series={series}
        isPinned={activeDate != null}
      />
    </Card>
  );
}

const RACE_NAMES: Record<Exclude<MixOpponentRace, "">, string> = {
  P: "Protoss",
  T: "Terran",
  Z: "Zerg",
};

const MIX_RACES: ReadonlyArray<Exclude<MixOpponentRace, "">> = [
  "P",
  "T",
  "Z",
];

function MatchupSelect({
  title,
  myRace,
  value,
  onChange,
}: {
  title: string;
  myRace?: string;
  value: MixOpponentRace;
  onChange: (race: MixOpponentRace) => void;
}) {
  const mine = String(myRace || "").trim().charAt(0).toUpperCase();
  const hasConcreteMyRace = mine === "P" || mine === "T" || mine === "Z";

  return (
    <label className="flex items-center gap-1.5 text-micro text-text-dim">
      <span>Matchup</span>
      <select
        aria-label={`${title} matchup`}
        value={value}
        onChange={(event) =>
          onChange(event.target.value as MixOpponentRace)
        }
        className="h-8 max-w-[9rem] rounded-md border border-border bg-bg-elevated px-2 text-caption text-text transition-colors focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
      >
        <option value="">All matchups</option>
        {MIX_RACES.map((race) => (
          <option key={race} value={race}>
            {hasConcreteMyRace ? `${mine}v${race}` : `vs ${RACE_NAMES[race]}`}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Sticky row header — doubles as the legend (colour chip + label)
 * and the per-series summary (games, share of window, and a shift
 * chip when the recent third of the window differs meaningfully
 * from the overall share).
 */
function RowLabel({ series }: { series: SeriesDef }) {
  const shift =
    series.shiftPts != null && Math.abs(series.shiftPts) >= SHIFT_MIN_PTS ? (
      <span
        className="text-text-muted"
        title={`Share of recent games vs the whole window: ${
          series.shiftPts > 0 ? "+" : ""
        }${series.shiftPts} pts`}
      >
        {series.shiftPts > 0 ? "▲" : "▼"} {Math.abs(series.shiftPts)}
      </span>
    ) : null;
  return (
    <div className="sticky left-0 z-10 w-28 shrink-0 bg-bg-surface py-[3px] pr-2 sm:w-44">
      <div className="flex items-center gap-1.5">
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-sm"
          style={{ background: series.color }}
        />
        <span
          className="min-w-0 truncate text-caption text-text-muted"
          title={series.label}
        >
          {series.label}
        </span>
      </div>
      <div className="flex items-center gap-1.5 pl-4 text-micro tabular-nums text-text-dim">
        <span>{series.total} game{series.total === 1 ? "" : "s"}</span>
        {shift}
      </div>
    </div>
  );
}

/**
 * Per-period breakdown rendered below the matrix. Idle state shows
 * the most recent period with games (so the panel is never blank);
 * hovering or tapping a column pins that period instead. The
 * "Latest period" / "Selected" pill makes the source explicit.
 */
function ActiveBreakdown({
  column,
  cells,
  series,
  isPinned,
}: {
  column: ColumnDatum | null;
  cells: Map<string, CellDatum>;
  series: SeriesDef[];
  isPinned: boolean;
}) {
  if (!column) return null;
  const total = column.total;
  const entries = series
    .map((s) => ({ ...s, cell: cells.get(cellKey(column.date, s.key)) }))
    .filter(
      (e): e is SeriesDef & { cell: CellDatum } =>
        e.cell !== undefined && e.cell.count > 0,
    )
    .sort((a, b) => b.cell.count - a.cell.count);
  return (
    <div className="mt-3 rounded-lg border border-border bg-bg-elevated/60 p-3">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="flex items-baseline gap-2">
          <span className="text-caption font-semibold text-text">
            {column.date}
          </span>
          <span
            className={[
              "rounded px-1.5 py-0.5 text-micro font-medium uppercase tracking-wider",
              isPinned
                ? "bg-accent/15 text-accent ring-1 ring-accent/30"
                : "bg-bg-elevated text-text-dim ring-1 ring-border",
            ].join(" ")}
          >
            {isPinned ? "Selected" : "Latest period"}
          </span>
        </div>
        <span className="text-micro tabular-nums text-text-dim">
          {total} game{total === 1 ? "" : "s"}
        </span>
      </div>
      {entries.length === 0 ? (
        <div className="text-caption text-text-dim">No games in this period.</div>
      ) : (
        <ul className="space-y-1">
          {entries.map((e) => {
            const share = total > 0 ? e.cell.count / total : 0;
            return (
              <li key={e.key} className="flex items-center gap-2 text-caption">
                <span
                  className="inline-block h-2.5 w-2.5 flex-none rounded-sm"
                  style={{ background: e.color }}
                />
                <span
                  className="min-w-0 flex-1 truncate text-text-muted"
                  title={e.label}
                >
                  {e.label}
                </span>
                <span className="flex-none tabular-nums text-text">
                  {Math.round(share * 100)}%
                </span>
                <span className="flex-none text-micro tabular-nums text-text-dim">
                  · {e.cell.count}
                </span>
                <span className="flex-none text-micro tabular-nums text-text-dim">
                  · {e.cell.wins}W-{e.cell.losses}L
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function TopNToggle({
  value,
  onChange,
}: {
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="flex items-center gap-1 text-micro">
      <span className="text-text-dim">Top</span>
      {TOP_N_OPTIONS.map((n) => (
        <button
          key={n}
          type="button"
          onClick={() => onChange(n)}
          className={[
            "rounded px-2 py-0.5",
            value === n
              ? "bg-accent/20 text-accent ring-1 ring-accent/40"
              : "bg-bg-elevated text-text-muted hover:text-text",
          ].join(" ")}
        >
          {n}
        </button>
      ))}
    </div>
  );
}

function cellKey(date: string, seriesKey: string): string {
  return `${date}|${seriesKey}`;
}

/**
 * Cell fill opacity. When every cell is a single game there's no
 * volume gradient worth encoding, so paint at near-full strength;
 * otherwise ramp from a clearly-visible floor to full.
 */
function cellAlpha(count: number, maxCellCount: number): number {
  if (maxCellCount <= 1) return 0.85;
  return 0.35 + 0.55 * (count / maxCellCount);
}

function withAlpha(hex: string, alpha: number): string {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(2)})`;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

function tickLabel(
  date: string,
  bucket: "day" | "week" | "month",
  showYear: boolean,
): string {
  if (!date || date.length < 10) return date;
  const [y, m, d] = date.split("-");
  const monthIdx = Number.parseInt(m, 10) - 1;
  if (Number.isNaN(monthIdx) || monthIdx < 0 || monthIdx > 11) return date;
  const month = MONTHS[monthIdx];
  if (bucket === "month") return `${month} '${y.slice(2)}`;
  const dayN = Number.parseInt(d, 10);
  return showYear ? `${month} ${dayN} '${y.slice(2)}` : `${month} ${dayN}`;
}

/**
 * Expand the periods that actually carry games into a continuous
 * timeline so a week off ladder reads as a visible gap instead of
 * being silently spliced out. Falls back to only the played periods
 * when the window is too wide to in-fill (MAX_COLUMNS), and unions
 * in any real bucket keys the calendar walk missed so no data is
 * ever dropped.
 */
function fillTimeline(
  sortedDates: string[],
  bucket: "day" | "week" | "month",
): string[] {
  if (sortedDates.length <= 1) return [...sortedDates];
  const first = sortedDates[0];
  const last = sortedDates[sortedDates.length - 1];
  const end = new Date(`${last}T00:00:00Z`).getTime();
  const cursor = new Date(`${first}T00:00:00Z`);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(end)) {
    return [...sortedDates];
  }
  const walked: string[] = [];
  while (cursor.getTime() <= end) {
    if (walked.length >= MAX_COLUMNS) return [...sortedDates];
    walked.push(cursor.toISOString().slice(0, 10));
    if (bucket === "day") cursor.setUTCDate(cursor.getUTCDate() + 1);
    else if (bucket === "week") cursor.setUTCDate(cursor.getUTCDate() + 7);
    else cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  const union = new Set(walked);
  for (const d of sortedDates) union.add(d);
  return [...union].sort();
}

/**
 * Collapse the raw (bucket, key, count) point cloud into the matrix
 * shape. Steps: collect totals per key, pick the top N, fold the
 * rest into "Other", build the continuous column timeline, then
 * index cells and column totals for O(1) render lookups.
 *
 * Series colours come from a stable palette indexed by rank in the
 * top-N list — same data always paints the same colour.
 */
function shapeMatrix(
  points: MixPoint[],
  tz: string,
  topN: number,
  bucket: "day" | "week" | "month",
): MixMatrix {
  if (!points.length) {
    return {
      series: [],
      columns: [],
      cells: new Map(),
      maxCellCount: 0,
      maxColumnTotal: 0,
      totalGames: 0,
    };
  }
  const totals = new Map<string, number>();
  let grandTotal = 0;
  for (const p of points) {
    const t = p.total || 0;
    totals.set(p.key, (totals.get(p.key) || 0) + t);
    grandTotal += t;
  }
  const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, topN);
  const topSet = new Set(top.map(([k]) => k));
  const hasOther = sorted.length > top.length;
  const otherTotal = hasOther
    ? sorted.slice(topN).reduce((acc, [, n]) => acc + n, 0)
    : 0;

  const playedDates = new Set<string>();
  for (const p of points) {
    const d = localDateKey(p.bucket, tz);
    if (d) playedDates.add(d);
  }
  const columnDates = fillTimeline([...playedDates].sort(), bucket);

  const cells = new Map<string, CellDatum>();
  const columnTotals = new Map<string, ColumnDatum>();
  for (const d of columnDates) {
    columnTotals.set(d, { date: d, total: 0, wins: 0, losses: 0 });
  }
  let maxCellCount = 0;
  for (const p of points) {
    const date = localDateKey(p.bucket, tz);
    if (!date) continue;
    const seriesKey = topSet.has(p.key) ? p.key : OTHER_KEY;
    const key = cellKey(date, seriesKey);
    const cell = cells.get(key) || { count: 0, wins: 0, losses: 0 };
    cell.count += p.total || 0;
    cell.wins += p.wins || 0;
    cell.losses += p.losses || 0;
    if (cell.count > 0) cells.set(key, cell);
    if (cell.count > maxCellCount) maxCellCount = cell.count;
    const col =
      columnTotals.get(date) || { date, total: 0, wins: 0, losses: 0 };
    col.total += p.total || 0;
    col.wins += p.wins || 0;
    col.losses += p.losses || 0;
    columnTotals.set(date, col);
  }
  const columns = [...columnTotals.values()].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
  );
  const maxColumnTotal = columns.reduce((m, c) => Math.max(m, c.total), 0);

  // Recent-share shift: how the last third of the window compares to
  // the series' overall share, in points. Only shown when the recent
  // window carries enough games to be more than coin-flip noise.
  const recentSpan = Math.max(2, Math.ceil(columns.length / 3));
  const recentCols = columns.slice(-recentSpan);
  const recentTotal = recentCols.reduce((acc, c) => acc + c.total, 0);
  const shiftFor = (seriesKey: string, overallTotal: number): number | null => {
    if (recentTotal < SHIFT_MIN_GAMES || grandTotal === 0) return null;
    let recentCount = 0;
    for (const c of recentCols) {
      recentCount += cells.get(cellKey(c.date, seriesKey))?.count || 0;
    }
    return Math.round(
      (recentCount / recentTotal - overallTotal / grandTotal) * 100,
    );
  };

  const series: SeriesDef[] = top.map(([key, total], idx) => ({
    key,
    label: key,
    color: PALETTE[idx % PALETTE.length],
    total,
    shiftPts: shiftFor(key, total),
  }));
  if (hasOther) {
    series.push({
      key: OTHER_KEY,
      label: OTHER_LABEL,
      color: OTHER_COLOR,
      total: otherTotal,
      shiftPts: shiftFor(OTHER_KEY, otherTotal),
    });
  }

  return {
    series,
    columns,
    cells,
    maxCellCount,
    maxColumnTotal,
    totalGames: grandTotal,
  };
}
