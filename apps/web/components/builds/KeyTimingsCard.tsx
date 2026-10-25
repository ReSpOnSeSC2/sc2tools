"use client";

import { useState } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { pct1, fmtDate } from "@/lib/format";
import { timingDisplay, visibleDossierTimings, type VisibleTiming } from "@/lib/dossierTimings";
import type { DossierTimingSource } from "@/lib/dossierTypes";
import { timingDelta } from "@/lib/guides/timingDelta";
import { timingAxis, type BuildDossierInsightsData, type CommunityTiming } from "@/lib/buildDossierInsights";

const measured = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const rate = (value: number | null | undefined) => measured(value) && value <= 1 ? pct1(value) : "Unavailable";

/** Quartiles are an observed middle half, never a confidence interval. */
function TimingWhisker({ item, axis }: { item: VisibleTiming; axis: number }) {
  const { row, median } = item;
  const quartiles = measured(row.p25Seconds) && measured(row.p75Seconds) && row.p25Seconds <= median && median <= row.p75Seconds;
  const left = quartiles ? row.p25Seconds! / axis * 100 : 0;
  return <div className="space-y-1">
    <div role="img" aria-label={quartiles ? `Middle half ${timingDisplay(row.p25Seconds)} to ${timingDisplay(row.p75Seconds)}; median ${timingDisplay(median)}` : `Median ${timingDisplay(median)}; middle half unavailable`} className="relative mx-1 h-3 rounded-full bg-bg-elevated">
      {quartiles ? <span className="absolute inset-y-1 rounded bg-accent/40" style={{ left: `${left}%`, width: `${(row.p75Seconds! - row.p25Seconds!) / axis * 100}%` }} /> : null}
      <span className="absolute inset-y-0 w-1 -translate-x-1/2 rounded bg-accent" style={{ left: `${median / axis * 100}%` }} />
    </div><div className="flex justify-between text-micro text-text-dim"><span>0:00</span><span>{timingDisplay(axis)}</span></div>
  </div>;
}

function TimingRow({ item, axis, community, onSelect }: { item: VisibleTiming; axis: number; community?: CommunityTiming; onSelect: (ids: string[], label: string) => void }) {
  const { row, median, n, selection } = item;
  const trend = row.trend === "earlier" ? "↘ Earlier" : row.trend === "later" ? "↗ Later" : row.trend === "stable" ? "→ Stable" : "Trend unavailable";
  const outcome = (row.winnerSampleCount ?? 0) >= 5 && (row.loserSampleCount ?? 0) >= 5 && measured(row.winnerMedianSeconds) && measured(row.loserMedianSeconds);
  const delta = community ? timingDelta(median, { median: community.medianSeconds, p25: community.p25Seconds, p75: community.p75Seconds }) : null;
  return <li className="rounded-lg border border-border">
    <button type="button" disabled={!selection} onClick={() => selection && onSelect(selection.gameIds, `${selection.label} timings${selection.matchup ? ` · ${selection.matchup}` : ""}`)} className="block min-h-11 w-full space-y-2 rounded-lg p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default">
      <span className="flex flex-wrap items-center justify-between gap-2"><span className="flex min-w-0 items-center gap-2"><Icon name={item.token} size="md" decorative /><strong className="break-words text-caption">{row.displayName || item.token}</strong></span><span className="font-mono text-caption tabular-nums">{timingDisplay(median)} · n={n}</span></span>
      <TimingWhisker item={item} axis={axis} />
      <span className="flex flex-wrap gap-x-4 gap-y-1 text-micro text-text-muted"><span>{trend}</span><span>Your WR when {row.source === "opp_build_log" ? "opponent " : ""}built: {rate(row.winRateWhenBuilt)}{measured(row.winRateSampleCount) ? ` · ${row.winRateSampleCount} decided` : ""}</span></span>
      {outcome ? <span className="block text-micro text-text-muted">Your wins: {timingDisplay(row.winnerMedianSeconds)} median (n={row.winnerSampleCount}) · Your losses: {timingDisplay(row.loserMedianSeconds)} median (n={row.loserSampleCount})</span> : null}
      {community && delta ? <span className="flex flex-wrap items-center gap-2 text-micro"><span className="text-text-muted">Community: {timingDisplay(community.medianSeconds)} · n={community.sampleCount}</span><span className={`rounded border px-2 py-0.5 ${delta.tone === "late" ? "border-warning/40 text-text" : "border-border text-text-muted"}`} title={delta.text}>{delta.deltaSec === 0 ? "Same as community median" : `${Math.abs(delta.deltaSec)} s ${delta.deltaSec > 0 ? "slower" : "faster"} than community`}</span></span> : null}
      <span className="block text-micro text-text-dim">{selection ? `${selection.gameIds.length} recorded sample game${selection.gameIds.length === 1 ? "" : "s"} · inspect games` : "Recorded game links unavailable"}</span>
    </button>
  </li>;
}

export function KeyTimingsCard({ data, initialSource = "build_log", onSelect }: { data: BuildDossierInsightsData; initialSource?: DossierTimingSource; onSelect: (ids: string[], label: string) => void }) {
  const [chosen, setChosen] = useState(""), [source, setSource] = useState(initialSource);
  const matchups = Object.keys(data.matchupTimingsLegacy ?? {}).filter(value => /^[PTZ]v[PTZ]$/.test(value));
  const matchup = matchups.includes(chosen) ? chosen : matchups[0] ?? "";
  const rows = visibleDossierTimings(data, matchup, source);
  const axis = timingAxis(rows.flatMap(({ row, median }) => [row.p75Seconds, median]));
  const community = source === "build_log" ? data.communityTimings?.[matchup] : undefined;
  const guideHref = community && /^\/guides\/[ptz]v[ptz]\/[a-z0-9-]+$/.test(community.href) ? community.href : null;
  return <Card title="Key timings" headingLevel={2} right={<LazyHelpLink slug="custom-builds" anchor="key-timings" variant="icon" />}>
    <div className="mb-4 space-y-3">
      {matchups.length ? <div role="group" aria-label="Key timing matchup" className="flex flex-wrap gap-1">{matchups.map(value => <button type="button" key={value} aria-pressed={matchup === value} onClick={() => setChosen(value)} className={`min-h-11 rounded-md border px-3 text-caption ${matchup === value ? "border-accent text-accent" : "border-border text-text-muted"}`}>{value}</button>)}</div> : null}
      <div role="group" aria-label="Key timing perspective" className="flex flex-wrap gap-1">{(["build_log", "opp_build_log"] as const).map(value => <button type="button" key={value} aria-pressed={source === value} onClick={() => setSource(value)} className={`min-h-11 rounded-md border px-3 text-caption ${source === value ? "border-accent text-accent" : "border-border text-text-muted"}`}>{value === "build_log" ? "Your timings" : "Opponent timings"}</button>)}</div>
      <p className="text-caption text-text-muted">{data.timingsTruncated ? `Based on your last ${data.timingSampleLimit ?? 25} games eligible for timing analysis` : data.timingSampleGames === undefined ? "Recent recorded timing sample" : `${data.timingSampleGames} games with recorded timing logs`}. The timing sample requires agreement with the recorded build label. Each row needs two observations. The bar spans p25–median–p75, the middle half of observed timings.</p>
      <p className="text-micro text-text-dim">Win rate uses decided games in this timing sample. Timing differences describe observations; they do not explain the result.</p>
      {community && guideHref ? <p className="text-micro text-text-muted"><Link href={guideHref} className="underline hover:text-accent">Community guide</Link> · {community.era === "after" ? "12-worker" : community.era === "before" ? "8-worker" : "Recorded"} era · first construction starts only{community.computedAt ? ` · snapshot ${fmtDate(community.computedAt)}` : ""}. Other eras and non-equivalent milestones have no comparison.</p> : null}
    </div>
    {rows.length ? <ul className="space-y-3" aria-label="Build key timing rows">{rows.map(item => <TimingRow key={item.token} item={item} axis={axis} community={community?.rows.find(row => row.token === item.token)} onSelect={onSelect} />)}</ul> : <p className="text-caption text-text-muted">Not enough recorded timings for this perspective and matchup.</p>}
  </Card>;
}
