"use client";

import { useState } from "react";
import { Area, Bar, CartesianGrid, Cell, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ExplorerResponse, ExplorerRow, ExplorerView } from "@/lib/trendsExplorer";
import { ExplorerStat, formatCount, formatRate, formatSeconds, GamesButton } from "./ExplorerPrimitives";

const COLORS = { accent: "rgb(var(--accent))", secondary: "rgb(var(--accent-cyan))", muted: "rgb(var(--text-dim))", grid: "rgb(var(--border))", success: "rgb(var(--success))" };
export type ExplorerSegment = { key: string; label: string };

export function ExplorerVisualization({ view, data, display, onSelect, weighted }: { view: ExplorerView; data: ExplorerResponse; display: "chart" | "table"; onSelect: (segment: ExplorerSegment) => void; weighted: boolean }) {
  const comparison = view === "periods" || view === "groups";
  const execution = view === "execution";
  return <div className="space-y-5">
    {comparison ? <div className="grid gap-3 sm:grid-cols-2">{data.rows.map((row) => <div key={row.key} className="min-w-0 rounded-xl border border-border bg-bg-elevated/40 p-4">
      <div className="flex items-center justify-between gap-2"><h4 className="truncate text-xs font-semibold text-text" title={row.label}>{row.label}</h4><GamesButton label={`View games for ${row.label}`} disabled={!row.games} onClick={() => onSelect(row)} /></div>
      <div className="mt-1 text-3xl font-semibold tabular-nums tracking-tight text-text">{formatRate(row.winRate)}<span className="ml-2 text-xs font-normal text-text-muted">{weighted ? "player-weighted win rate" : "win rate"}</span></div>
      <div className="mt-3 grid grid-cols-2 gap-2 border-t border-border pt-3 text-xs"><span className="text-text-muted">{formatCount(row.games)} {row.games === 1 ? "game" : "games"} · {formatCount(row.players)} {row.players === 1 ? "player" : "players"}</span><span className="text-right text-text-muted">{formatCount(row.wins)}W · {formatCount(row.losses)}L</span><span className="text-text-dim">Avg. MMR <span className="tabular-nums text-text-muted">{row.avgMmr == null ? "—" : formatCount(Math.round(row.avgMmr))}</span></span><span className="text-right text-text-dim">Avg. length <span className="tabular-nums text-text-muted">{formatSeconds(row.avgDurationSec)}</span></span></div>
    </div>)}</div> : <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      <ExplorerStat label="Games analyzed" value={formatCount(data.eligibleGames)} detail={`${formatCount(Math.max(0, data.totalGames - data.eligibleGames))} excluded or missing required data`} />
      <ExplorerStat label="Data coverage" value={data.totalGames ? formatRate(data.eligibleGames / data.totalGames) : "—"} detail={`Of ${formatCount(data.totalGames)} games in this selection`} />
      <div className="col-span-2 sm:col-span-1"><ExplorerStat label={execution ? "Timing groups" : "Result groups"} value={formatCount(data.rows.filter((row) => row.games > 0).length)} detail="Open a group to inspect its games" /></div>
    </div>}
    {display === "table" ? <ExplorerDataTable rows={data.rows} execution={execution} onSelect={onSelect} weighted={weighted} /> : execution ? <ExecutionChart rows={data.rows} onSelect={onSelect} /> : <OutcomeChart rows={data.rows} view={view} onSelect={onSelect} weighted={weighted} />}
    {comparison ? <p className="text-xs text-text-dim">{formatCount(data.eligibleGames)} of {formatCount(data.totalGames)} selected games represented. Groups may overlap; totals count each represented game once.</p> : null}
    {comparison && data.breakdown?.length ? <ComparisonBreakdown data={data.breakdown} onSelect={onSelect} /> : null}
  </div>;
}

function ExplorerTooltip({ row, execution, weighted }: { row: ExplorerRow; execution?: boolean; weighted?: boolean }) {
  return <div className="max-w-[240px] rounded-lg border border-border-strong bg-bg-surface px-3 py-2 text-xs shadow-lg">
    <div className="mb-1.5 font-semibold text-text">{row.label}</div>
    {execution ? <><TooltipRow label="Median timing" value={formatSeconds(row.medianSec)} /><TooltipRow label="Middle 50%" value={`${formatSeconds(row.p25Sec)}–${formatSeconds(row.p75Sec)}`} /></> : <TooltipRow label={weighted ? "Player-weighted win rate" : "Win rate"} value={formatRate(row.winRate)} />}
    {execution && (row.winMedianSec != null || row.lossMedianSec != null) ? <><TooltipRow label="Median in wins" value={formatSeconds(row.winMedianSec)} /><TooltipRow label="Median in losses" value={formatSeconds(row.lossMedianSec)} /></> : null}
    <TooltipRow label="Games" value={formatCount(row.games)} /><TooltipRow label="Players" value={formatCount(row.players)} />
    <TooltipRow label="Record" value={`${row.wins}W · ${row.losses}L`} />
    {row.decided < 20 ? <div className="mt-2 border-t border-border pt-1.5 text-[10px] text-text-dim">Small sample · interpret with care</div> : null}
    <div className="mt-1 text-[10px] text-accent">Select to view games</div>
  </div>;
}

function TooltipRow({ label, value }: { label: string; value: string }) { return <div className="flex justify-between gap-4 py-0.5"><span className="text-text-muted">{label}</span><span className="font-medium tabular-nums text-text">{value}</span></div>; }

function OutcomeChart({ rows, view, onSelect, weighted }: { rows: ExplorerRow[]; view: ExplorerView; onSelect: (row: ExplorerSegment) => void; weighted: boolean }) {
  const comparison = view === "periods" || view === "groups";
  const values = rows.map((row) => ({ ...row, ratePct: row.winRate == null ? null : row.winRate * 100 }));
  return <div>
    <div role="img" aria-label={`${weighted ? "Player-weighted win rate" : "Win rate"} and game count by group. Select Data for exact values and accessible game links.`} className="h-72 min-w-0 w-full sm:h-80">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={values} margin={{ top: 16, right: 0, left: -20, bottom: 6 }} onClick={(state) => { const row = state?.activePayload?.[0]?.payload as ExplorerRow | undefined; if (row?.games) onSelect(row); }} accessibilityLayer>
          <CartesianGrid stroke={COLORS.grid} strokeDasharray="3 4" vertical={false} />
          <XAxis dataKey="label" stroke={COLORS.muted} fontSize={10} tickLine={false} axisLine={false} minTickGap={18} interval="preserveStartEnd" tickMargin={10} tickFormatter={(label: string) => label.length > 20 ? `${label.slice(0, 18)}…` : label} />
          <YAxis yAxisId="rate" orientation="right" domain={[0, 100]} stroke={COLORS.muted} fontSize={10} tickLine={false} axisLine={false} tickFormatter={(value: number) => `${value}%`} width={44} />
          <YAxis yAxisId="games" stroke={COLORS.muted} fontSize={10} tickLine={false} axisLine={false} allowDecimals={false} width={50} hide={comparison} />
          <ReferenceLine yAxisId="rate" y={50} stroke={COLORS.muted} strokeOpacity={0.5} strokeDasharray="4 4" />
          <Tooltip cursor={{ fill: "rgb(var(--accent) / 0.05)" }} content={({ active, payload }) => active && payload?.length ? <ExplorerTooltip row={payload[0].payload as ExplorerRow} weighted={weighted} /> : null} />
          {comparison ? <Bar yAxisId="rate" dataKey="ratePct" name="Win rate" radius={[6, 6, 0, 0]} maxBarSize={104} cursor="pointer" isAnimationActive={false}>{values.map((row, index) => <Cell key={row.key} fill={index === 0 ? COLORS.accent : COLORS.secondary} fillOpacity={0.8} />)}</Bar> : null}
          {/* Recharts v2 requires series to be direct chart children. */}
          {!comparison ? <Bar yAxisId="games" dataKey="games" name="Games" fill={COLORS.accent} fillOpacity={0.17} radius={[4, 4, 0, 0]} maxBarSize={60} cursor="pointer" isAnimationActive={false} /> : null}
          {!comparison ? <Line yAxisId="rate" dataKey="ratePct" name="Win rate" stroke={COLORS.accent} strokeWidth={2.5} connectNulls={false} dot={{ r: 4, fill: "rgb(var(--bg-surface))", strokeWidth: 2 }} activeDot={{ r: 6, cursor: "pointer" }} isAnimationActive={false} /> : null}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
    <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-2 text-[11px] text-text-dim"><span className="inline-flex items-center gap-2"><span className="h-0.5 w-4 bg-accent" />{weighted ? "Player-weighted win rate" : "Win rate"}</span>{!comparison ? <span className="inline-flex items-center gap-2"><span className="h-2.5 w-3 rounded-sm bg-accent/20" />Game count</span> : null}<span>Dashed line: 50%</span><span className="sm:ml-auto">Select a chart group to view games</span></div>
  </div>;
}

function ExecutionChart({ rows, onSelect }: { rows: ExplorerRow[]; onSelect: (row: ExplorerSegment) => void }) {
  const values = rows.filter((row) => row.medianSec != null).map((row) => ({ ...row, timingRange: [row.p25Sec ?? row.medianSec, row.p75Sec ?? row.medianSec] }));
  if (!values.length) return <p className="py-10 text-center text-sm text-text-muted">No timing samples are available for this milestone.</p>;
  return <div>
    <div role="img" aria-label="Median execution timing over time with the middle 50 percent of timing samples. Select Data for exact values." className="h-72 min-w-0 w-full sm:h-80">
      <ResponsiveContainer width="100%" height="100%"><ComposedChart data={values} margin={{ top: 16, right: 16, left: -14, bottom: 10 }} onClick={(state) => { const row = state?.activePayload?.[0]?.payload as ExplorerRow | undefined; if (row?.games) onSelect(row); }} accessibilityLayer>
        <CartesianGrid stroke={COLORS.grid} strokeDasharray="3 4" vertical={false} />
        <XAxis dataKey="label" stroke={COLORS.muted} fontSize={10} tickLine={false} axisLine={false} minTickGap={24} interval="preserveStartEnd" tickMargin={10} />
        <YAxis type="number" stroke={COLORS.muted} fontSize={10} tickLine={false} axisLine={false} width={62} tickFormatter={formatSeconds} />
        <Tooltip cursor={{ fill: "rgb(var(--accent) / 0.05)" }} content={({ active, payload }) => active && payload?.length ? <ExplorerTooltip row={payload[0].payload as ExplorerRow} execution /> : null} />
        <Area dataKey="timingRange" name="Middle 50%" fill={COLORS.accent} fillOpacity={0.14} stroke="none" connectNulls={false} isAnimationActive={false} />
        <Line dataKey="medianSec" name="Median timing" stroke={COLORS.accent} strokeWidth={2.5} dot={values.length <= 24 ? { r: 3, fill: "rgb(var(--bg-surface))", strokeWidth: 2 } : false} activeDot={{ r: 5, cursor: "pointer" }} connectNulls={false} isAnimationActive={false} />
      </ComposedChart></ResponsiveContainer>
    </div>
    <p className="mt-2 text-[11px] leading-relaxed text-text-dim">The line shows median timing; the shaded band spans the 25th–75th percentiles. A narrower band means more consistent execution. Only games that reached this milestone contribute.</p>
  </div>;
}

function ExplorerDataTable({ rows, execution, onSelect, weighted }: { rows: ExplorerRow[]; execution: boolean; onSelect: (row: ExplorerSegment) => void; weighted: boolean }) {
  return <>
    <div className="space-y-2 sm:hidden">{rows.map((row) => <div className="rounded-xl border border-border p-3" key={row.key}><div className="flex items-center justify-between gap-2"><h4 className="min-w-0 text-xs font-semibold text-text">{row.label}</h4><GamesButton label={`View games for ${row.label}`} onClick={() => onSelect(row)} disabled={!row.games} /></div><dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-2 text-xs"><div><dt className="text-text-dim">{execution ? "Median timing" : weighted ? "Player-weighted win rate" : "Win rate"}</dt><dd className="mt-0.5 font-medium tabular-nums text-text">{execution ? formatSeconds(row.medianSec) : formatRate(row.winRate)}</dd></div><div><dt className="text-text-dim">Games · players</dt><dd className="mt-0.5 tabular-nums text-text">{formatCount(row.games)} · {formatCount(row.players)}</dd></div>{execution ? <div><dt className="text-text-dim">Middle 50%</dt><dd className="mt-0.5 tabular-nums text-text">{formatSeconds(row.p25Sec)}–{formatSeconds(row.p75Sec)}</dd></div> : <div><dt className="text-text-dim">Record</dt><dd className="mt-0.5 tabular-nums text-text">{row.wins}W · {row.losses}L</dd></div>}</dl></div>)}</div>
    <div className="hidden overflow-hidden rounded-xl border border-border sm:block"><table className="w-full text-left text-xs" aria-label="Analysis group data"><thead className="bg-bg-elevated text-[11px] text-text-muted"><tr>{["Group", execution ? "Median" : weighted ? "Weighted win rate" : "Win rate", execution ? "Middle 50%" : "Record", "Games", "Players", ""].map((label, index) => <th key={index} scope="col" className="px-3 py-3 font-medium">{label || <span className="sr-only">Inspect games</span>}</th>)}</tr></thead><tbody>{rows.map((row) => <tr key={row.key} className="border-t border-border"><th scope="row" className="max-w-44 break-words px-3 py-2 font-medium text-text">{row.label}</th><td className="px-3 py-2 tabular-nums text-text">{execution ? formatSeconds(row.medianSec) : formatRate(row.winRate)}</td><td className="px-3 py-2 tabular-nums text-text-muted">{execution ? `${formatSeconds(row.p25Sec)}–${formatSeconds(row.p75Sec)}` : `${row.wins}W · ${row.losses}L`}</td><td className="px-3 py-2 tabular-nums text-text-muted">{formatCount(row.games)}</td><td className="px-3 py-2 tabular-nums text-text-muted">{formatCount(row.players)}</td><td className="px-2 py-1 text-right"><GamesButton label={`View games for ${row.label}`} onClick={() => onSelect(row)} disabled={!row.games} /></td></tr>)}</tbody></table></div>
    <p className="text-[11px] text-text-dim">Win rates use games with a known win or loss. Small samples can vary substantially.</p>
  </>;
}

function ComparisonBreakdown({ data, onSelect }: { data: NonNullable<ExplorerResponse["breakdown"]>; onSelect: (row: ExplorerSegment) => void }) {
  const [kind, setKind] = useState<"matchup" | "build">("matchup");
  const labels = Array.from(new Set(data.filter((row) => row.kind === kind).map((row) => row.label)));
  return <details className="rounded-xl border border-border"><summary className="cursor-pointer px-4 py-3 text-xs font-semibold text-text">Compare matchups and builds</summary><div className="space-y-3 border-t border-border p-3 sm:p-4">
    <div className="inline-flex rounded-lg border border-border bg-bg-elevated p-1" aria-label="Comparison breakdown">{(["matchup", "build"] as const).map((item) => <button key={item} type="button" aria-pressed={kind === item} className={`min-h-10 rounded-md px-4 text-xs font-medium ${kind === item ? "bg-bg-surface text-accent shadow-sm" : "text-text-muted"}`} onClick={() => setKind(item)}>{item === "matchup" ? "Matchups" : "Builds"}</button>)}</div>
    {labels.length ? <div className="space-y-2">{labels.map((label) => <div key={label} className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] sm:items-center"><h5 className="min-w-0 break-words text-xs font-medium text-text">{label}</h5>{(["a", "b"] as const).map((group) => { const row = data.find((item) => item.kind === kind && item.label === label && item.group === group); return <div key={group} className="flex items-center justify-between gap-2"><div><span className="text-[10px] text-text-dim">{group.toUpperCase()} · {formatCount(row?.games ?? 0)} games</span><p className="text-sm font-medium tabular-nums text-text">{formatRate(row?.winRate)}</p></div><GamesButton label={`View ${label} games in group ${group.toUpperCase()}`} disabled={!row?.games} onClick={() => onSelect({ key: row?.key ?? `${group}:${kind}:${label}`, label: `${group.toUpperCase()} · ${label}` })} /></div>; })}</div>)}</div> : <p className="py-4 text-xs text-text-dim">No {kind === "matchup" ? "matchups" : "classified builds"} in these groups.</p>}
  </div></details>;
}
