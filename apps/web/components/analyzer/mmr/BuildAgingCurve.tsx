"use client";

import { useMemo } from "react";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine } from "recharts";
import { useApi } from "@/lib/clientApi";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { useLocalStoragePositiveInt } from "@/lib/useLocalStorageState";
import { useChartKit, assignChartSeries, isLowSample } from "@/lib/charts/theme";
import { Card, EmptyState } from "@/components/ui/Card";
import { MinGamesPicker } from "@/components/ui/MinGamesPicker";
import { ChartFrame, ChartLegend, type ChartTableColumn } from "@/components/analyzer/charts/ChartFrame";

interface CurvePoint { n: number; wins: number; losses: number; cumulativeWins: number; cumulativeLosses: number }
interface BuildSeries { build: string; curve: CurvePoint[] }
interface ChartRow { n: number; [series: string]: number | null }
type AgingTableRow = { build: string; play: number; rate: number; wins: number; losses: number; decided: number };
const COLUMNS: readonly ChartTableColumn<AgingTableRow>[] = [
  { key: "build", label: "Build", render: row => row.build },
  { key: "play", label: "Nth play", render: row => row.play, align: "right" },
  { key: "rate", label: "Cumulative win rate", render: row => `${row.rate}%`, align: "right" },
  { key: "record", label: "Record", render: row => `${row.wins}W–${row.losses}L`, align: "right" },
  { key: "sample", label: "Decided sample", render: row => `${row.decided}${isLowSample(row.decided) ? " · small sample" : ""}`, align: "right" },
];
const LS_MIN_GAMES = "analyzer.mmr.aging.minGames", LS_TOP_N = "analyzer.mmr.aging.topN";

/** Cumulative win rate by play count describes recorded experience; it does
 * not establish mastery or explain why a player's results changed. */
export function BuildAgingCurve() {
  const { filters, dbRev } = useFilters(), kit = useChartKit();
  const [minGames, setMinGames] = useLocalStoragePositiveInt(LS_MIN_GAMES, 10);
  const [topN, setTopN] = useLocalStoragePositiveInt(LS_TOP_N, 6);
  const agingApi = useApi<BuildSeries[]>(`/v1/mmr-stats/aging-curve${filtersToQuery(filters)}#${dbRev}`);
  const { chartData, seriesList, totalPoints } = useMemo(() => shapeAgingForChart(agingApi.data || [], minGames, topN, kit.series), [agingApi.data, minGames, topN, kit.series]);
  const tableRows = useMemo(() => chartData.flatMap(row => seriesList.flatMap(series => {
    const rate = row[series.name];
    return typeof rate === "number" ? [{ build: series.name, play: row.n, rate, wins: Number(row[`${series.name}__wins`]), losses: Number(row[`${series.name}__losses`]), decided: Number(row[`${series.name}__decided`]) }] : [];
  })), [chartData, seriesList]);
  return <Card title="Build experience curve">
    <p className="-mt-1 mb-3 text-caption text-text-muted">Cumulative win rate by the Nth time you played each build. The horizontal axis is play count. Current filters apply; hollow points have fewer than 20 decided games.</p>
    <ChartFrame title="Build experience curve" query={agingApi} rows={tableRows} columns={COLUMNS}
      summary={`${totalPoints} recorded plays across ${seriesList.length} builds meeting the ${minGames}-play minimum; top ${topN} by recorded plays. Rates use cumulative wins and losses.`}
      empty={<EmptyState title="No builds with enough plays yet" sub="Curves appear once a build has been played at least the configured min-plays count above." />}
      toolbar={<div className="grid grid-cols-1 gap-3 md:grid-cols-2"><div className="flex flex-col gap-1"><span className="text-caption text-text-muted">Min plays per build</span><MinGamesPicker value={minGames} onChange={setMinGames} hideLabel /></div><div className="flex flex-col gap-1"><span className="text-caption text-text-muted">Builds shown (top N by volume)</span><MinGamesPicker value={topN} onChange={setTopN} steps={[3, 6, 10, 20]} hideLabel /></div></div>}
      legend={<ChartLegend items={seriesList.map(series => ({ key: series.name, label: `${series.name} · n=${series.decided}`, color: series.color, strokeDasharray: series.strokeDasharray }))} />}>
      <div className="h-[280px] min-w-0"><ResponsiveContainer width="100%" height="100%"><LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 12, left: -8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={kit.grid} />
        <XAxis dataKey="n" stroke={kit.axis} tick={kit.tickStyle} tickMargin={6} label={{ value: "Nth play", position: "insideBottom", offset: -6, style: kit.tickStyle }} />
        <YAxis stroke={kit.axis} tick={kit.tickStyle} domain={[0, 100]} tickFormatter={value => `${value}%`} />
        <ReferenceLine y={50} stroke={kit.grid} strokeDasharray="2 4" />
        <Tooltip contentStyle={kit.tooltipStyle} formatter={(value, name, entry) => [`${value}% · n=${entry.payload?.[`${name}__decided`] ?? "unknown"}`, name]} labelFormatter={n => `After ${n} plays`} />
        {seriesList.map(series => <Line key={series.name} type="monotone" dataKey={series.name} stroke={series.color} strokeWidth={2} strokeDasharray={series.strokeDasharray}
          dot={({ cx, cy, payload }: { cx?: number; cy?: number; payload?: ChartRow }) => typeof cx === "number" && typeof cy === "number" && payload && isLowSample(payload[`${series.name}__decided`])
            ? <circle cx={cx} cy={cy} r={3} fill={kit.tokens.bgSurface} stroke={kit.lowSample} strokeWidth={2} /> : <></>}
          connectNulls={false} isAnimationActive={false} />)}
      </LineChart></ResponsiveContainer></div>
    </ChartFrame>
  </Card>;
}

/** Qualification, volume ordering and cumulative rates retain their original
 * definitions. Added per-point counts support reading and the table only. */
export function shapeAgingForChart(series: BuildSeries[], minPlays: number, topN: number, palette: readonly string[]) {
  const qualified = series.filter(row => row.curve.length >= minPlays).sort((a, b) => b.curve.length - a.curve.length).slice(0, topN);
  if (qualified.length === 0) return { chartData: [] as ChartRow[], seriesList: [] as Array<{ name: string; color: string; strokeDasharray?: string; decided: number }>, totalPoints: 0 };
  const maxN = qualified.reduce((max, row) => Math.max(max, row.curve.length), 0);
  const colors = assignChartSeries(qualified.map(row => row.build), palette);
  const seriesList = qualified.map(row => ({ name: row.build, ...colors.get(row.build)!, decided: (row.curve.at(-1)?.cumulativeWins || 0) + (row.curve.at(-1)?.cumulativeLosses || 0) }));
  const chartData: ChartRow[] = [];
  for (let n = 1; n <= maxN; n += 1) {
    const row: ChartRow = { n };
    for (const build of qualified) {
      const point = build.curve[n - 1];
      if (!point) { row[build.build] = null; continue; }
      const total = point.cumulativeWins + point.cumulativeLosses;
      row[build.build] = total > 0 ? Math.round(point.cumulativeWins / total * 100) : null;
      row[`${build.build}__wins`] = point.cumulativeWins; row[`${build.build}__losses`] = point.cumulativeLosses; row[`${build.build}__decided`] = total;
    }
    chartData.push(row);
  }
  return { chartData, seriesList, totalPoints: qualified.reduce((sum, row) => sum + row.curve.length, 0) };
}
