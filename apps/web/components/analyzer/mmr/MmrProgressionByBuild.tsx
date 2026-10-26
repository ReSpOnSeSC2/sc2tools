"use client";

import { useMemo } from "react";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import { useApi } from "@/lib/clientApi";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { useLocalStoragePositiveInt } from "@/lib/useLocalStorageState";
import { useChartKit, assignChartSeries, isLowSample } from "@/lib/charts/theme";
import { Card, EmptyState } from "@/components/ui/Card";
import { MinGamesPicker } from "@/components/ui/MinGamesPicker";
import { ChartFrame, ChartLegend, type ChartTableColumn } from "@/components/analyzer/charts/ChartFrame";
import { fmtMmr } from "@/lib/format";
import { clientTimezone, localDateKey } from "@/lib/timeseries";

interface ProgressionPoint { date: string; mmr: number; result: "win" | "loss" }
interface BuildSeries { build: string; points: ProgressionPoint[] }
interface ChartRow { dateKey: string; dateLabel: string; [series: string]: number | string | null }
type ProgressionTableRow = { build: string; date: string; mmr: number; decided: number };
const COLUMNS: readonly ChartTableColumn<ProgressionTableRow>[] = [
  { key: "date", label: "Local date", render: row => row.date },
  { key: "build", label: "Build", render: row => row.build },
  { key: "mmr", label: "Recorded MMR", render: row => fmtMmr(row.mmr), align: "right" },
  { key: "sample", label: "Decided games so far", render: row => `${row.decided}${isLowSample(row.decided) ? " · small sample" : ""}`, align: "right" },
];
const LS_MIN_GAMES = "analyzer.mmr.progression.minGames", LS_TOP_N = "analyzer.mmr.progression.topN";

/** Recorded MMR when using each build, retaining the last supplied point
 * per local day. This is a description of the selected games, not causation. */
export function MmrProgressionByBuild() {
  const { filters, dbRev } = useFilters(), kit = useChartKit();
  const [minGames, setMinGames] = useLocalStoragePositiveInt(LS_MIN_GAMES, 10);
  const [topN, setTopN] = useLocalStoragePositiveInt(LS_TOP_N, 5);
  const tz = useMemo(() => clientTimezone(), []);
  const progressionApi = useApi<BuildSeries[]>(`/v1/mmr-stats/progression${filtersToQuery(filters)}#${dbRev}`);
  const { chartData, seriesList, totalPoints, mmrDomain } = useMemo(() => shapeProgressionForChart(progressionApi.data || [], minGames, topN, tz, kit.series), [progressionApi.data, minGames, topN, tz, kit.series]);
  const tableRows = useMemo(() => chartData.flatMap(row => seriesList.flatMap(series => {
    const mmr = row[series.name];
    return typeof mmr === "number" ? [{ date: row.dateKey, build: series.name, mmr, decided: Number(row[`${series.name}__decided`]) }] : [];
  })), [chartData, seriesList]);
  return <Card title="MMR progression by build">
    <p className="-mt-1 mb-3 text-caption text-text-muted">Your recorded MMR over time when playing each build. Multiple games on the same local day retain the last recorded MMR for that build. Current filters apply; hollow points have fewer than 20 decided games so far.</p>
    <ChartFrame title="MMR progression by build" query={progressionApi} rows={tableRows} columns={COLUMNS}
      summary={`${totalPoints} MMR-tagged games across ${seriesList.length} builds meeting the ${minGames}-play minimum; top ${topN} by recorded plays. Daily points use the viewer's ${tz} timezone and the last recorded MMR.`}
      empty={<EmptyState title="No MMR-tagged builds yet" sub="Lines appear once a build crosses the min-plays threshold above and has MMR data on each game." />}
      toolbar={<div className="grid grid-cols-1 gap-3 md:grid-cols-2"><div className="flex flex-col gap-1"><span className="text-caption text-text-muted">Min plays per build</span><MinGamesPicker value={minGames} onChange={setMinGames} hideLabel /></div><div className="flex flex-col gap-1"><span className="text-caption text-text-muted">Builds shown (top N by volume)</span><MinGamesPicker value={topN} onChange={setTopN} steps={[3, 5, 10, 20]} hideLabel /></div></div>}
      legend={<ChartLegend items={seriesList.map(series => ({ key: series.name, label: `${series.name} · n=${series.decided}`, color: series.color, strokeDasharray: series.strokeDasharray }))} />}>
      <div className="h-[280px] min-w-0"><ResponsiveContainer width="100%" height="100%"><LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 16, left: -8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={kit.grid} />
        <XAxis dataKey="dateLabel" stroke={kit.axis} tick={kit.tickStyle} tickMargin={6} interval="preserveStartEnd" angle={-30} textAnchor="end" height={60} />
        <YAxis stroke={kit.axis} tick={kit.tickStyle} domain={mmrDomain} allowDecimals={false} tickFormatter={(value: number) => fmtMmr(value)} />
        <Tooltip contentStyle={kit.tooltipStyle} formatter={(value, name, entry) => [`${value} MMR · n=${entry.payload?.[`${name}__decided`] ?? "unknown"}`, name]} />
        {seriesList.map(series => <Line key={series.name} type="monotone" dataKey={series.name} stroke={series.color} strokeWidth={2} strokeDasharray={series.strokeDasharray}
          dot={({ cx, cy, payload }: { cx?: number; cy?: number; payload?: ChartRow }) => typeof cx === "number" && typeof cy === "number" && payload && isLowSample(Number(payload[`${series.name}__decided`]))
            ? <circle cx={cx} cy={cy} r={3} fill={kit.tokens.bgSurface} stroke={kit.lowSample} strokeWidth={2} /> : <></>}
          connectNulls isAnimationActive={false} />)}
      </LineChart></ResponsiveContainer></div>
    </ChartFrame>
  </Card>;
}

/** Keep qualification, input-order daily projection, local labels and padded
 * domain identical to the existing chart; metadata only adds sample cues. */
export function shapeProgressionForChart(series: BuildSeries[], minPlays: number, topN: number, tz: string, palette: readonly string[]) {
  const qualified = series.filter(row => row.points.length >= minPlays).sort((a, b) => b.points.length - a.points.length).slice(0, topN);
  if (qualified.length === 0) return { chartData: [] as ChartRow[], seriesList: [] as Array<{ name: string; color: string; strokeDasharray?: string; decided: number }>, totalPoints: 0, mmrDomain: ["dataMin", "dataMax"] as ["dataMin", "dataMax"] };
  const rowByKey = new Map<string, ChartRow>();
  let minMmr = Infinity, maxMmr = -Infinity;
  for (const build of qualified) {
    let decided = 0;
    for (const point of build.points) {
      if (point.result === "win" || point.result === "loss") decided += 1;
      const date = new Date(point.date); if (Number.isNaN(date.getTime())) continue;
      const dateKey = localDateKey(date, tz); if (!dateKey) continue;
      let row = rowByKey.get(dateKey);
      if (!row) { row = { dateKey, dateLabel: date.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: tz }) }; rowByKey.set(dateKey, row); }
      row[build.build] = point.mmr; row[`${build.build}__decided`] = decided;
      if (point.mmr < minMmr) minMmr = point.mmr; if (point.mmr > maxMmr) maxMmr = point.mmr;
    }
  }
  const chartData = [...rowByKey.values()].sort((a, b) => a.dateKey.localeCompare(b.dateKey));
  if (chartData.length > 0) {
    const firstYear = chartData[0].dateKey.slice(0, 4), lastYear = chartData[chartData.length - 1].dateKey.slice(0, 4);
    if (firstYear !== lastYear || lastYear !== String(new Date().getFullYear())) for (const row of chartData) row.dateLabel = `${row.dateLabel} '${row.dateKey.slice(2, 4)}`;
  }
  const colors = assignChartSeries(qualified.map(row => row.build), palette);
  const seriesList = qualified.map(row => ({ name: row.build, ...colors.get(row.build)!, decided: row.points.filter(point => point.result === "win" || point.result === "loss").length }));
  const totalPoints = qualified.reduce((sum, row) => sum + row.points.length, 0);
  const pad = Math.max(50, Math.round((maxMmr - minMmr) * 0.1));
  const mmrDomain: [number, number] = [Math.max(0, Math.floor((minMmr - pad) / 50) * 50), Math.ceil((maxMmr + pad) / 50) * 50];
  return { chartData, seriesList, totalPoints, mmrDomain };
}
